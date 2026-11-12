import { DomainError } from "../domain/errors.js";
import { tradeExecutedEvent } from "../domain/events.js";
import { botStreamId, emptyUserAccount, holdingOf, parseMarketId, userStreamId } from "../domain/ledger.js";
import { assertTradable, withTrade } from "../domain/market-state.js";
import { decideSale, planSale } from "../domain/order-book.js";
import type { SaleDecision } from "../domain/order-book.js";
import { averagePriceMicro, otherSide, parseSide } from "../domain/units.js";
import { IdempotencyKeyReused, MarketNotOpen, NotFound, OrdersPaused, ProceedsBelowMinimum, TenantNotReady, ValidationFailed, fromDomainError, guardDomain } from "./errors.js";
import { parseSaleShares } from "./get-sale-quote.js";
import type { RuleDeps } from "./ports.js";
import { eventContext, orderScope, outboxMessage, parseIdempotencyKey, requestHash, requireTrader, userMeta, withConflictRetry } from "./support.js";
import type { PlacedSale, SaleResult, SellSharesInput, SellSharesUseCase } from "./use-cases.js";

/** DM-18's counterpart as the contract states it: a positive safe integer of microcredits, or absent. */
function parseMinProceeds(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationFailed([{ field: "minProceedsMicro", message: "minProceedsMicro must be a positive safe integer (microcredits)" }]);
  }
  return value;
}

/** The stored result of a completed key comes back from JSON: only the date needs reviving. */
function reviveSaleResult(stored: unknown): SaleResult {
  const raw = stored as Omit<SaleResult, "executedAt"> & { executedAt: string };
  return { ...raw, executedAt: new Date(raw.executedAt) };
}

/**
 * A trader's sale before the market closes (UC-08, plan 6.2 and section 12): buys as many shares of the other side from
 * the bot's offers as the trader sells and redeems the pairs for 1 credit each, all in one transaction, exactly as an
 * order: the idempotency key (the user's order scope, so a key names one trading request whatever its kind; the hash
 * names the kind), the runtime pause (ORDERS_ENABLED pauses sales too; ORDER_AMOUNT_MAX is about credits and does not
 * apply), the market copy (open, before its close time, checked again with the clock read after every lock), the
 * position, the fills with the pairs the bot lacks created first, the ledger appends on both streams with expected
 * versions (BotSharesSold of the other side, SharesSold), the projections, the remaining offers, trade sequence + 1
 * and TradeExecuted (kind "sale") in the outbox (REL-01). A refusal rolls everything back, the claimed key included.
 *
 * Lock order as an order: market_state row, the bot account, the trader's account.
 */
export class SellShares implements SellSharesUseCase {
  constructor(private readonly deps: RuleDeps) {}

  async execute(input: SellSharesInput): Promise<PlacedSale> {
    const { store, clock, ids, logger, rules } = this.deps;
    const { actor } = input;
    requireTrader(actor.role);
    const key = parseIdempotencyKey(input.idempotencyKey);
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const side = guardDomain(() => parseSide(input.side));
    const sharesMicro = parseSaleShares(input.sharesMicro);
    const minProceedsMicro = parseMinProceeds(input.minProceedsMicro);
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();

    const scope = orderScope(actor.userId);
    const hash = requestHash({ kind: "sale", marketId, side, sharesMicro, minProceedsMicro });

    const placed = await withConflictRetry(() =>
      tenant.transaction(async (repositories): Promise<PlacedSale> => {
        const claim = await repositories.idempotency.claim({ scope, key, requestHash: hash, now: clock.now() });
        if (claim.kind === "mismatch") throw new IdempotencyKeyReused();
        if (claim.kind === "replay") return { result: reviveSaleResult(claim.result), replayed: true };

        if (!rules.current().ordersEnabled) throw new OrdersPaused();

        const market = await repositories.marketStates.find(marketId, { lock: true });
        if (!market) throw new NotFound();
        guardDomain(() => assertTradable(market, clock.now()));
        const book = await repositories.botOrders.get(marketId);
        const bot = await repositories.accounts.load(botStreamId(marketId), { lock: true, marketIds: [marketId] });
        if (!bot) throw new MarketNotOpen("The market has no bot account yet");
        const trader = (await repositories.accounts.load(userStreamId(actor.userId), { lock: true, marketIds: [marketId] })) ?? emptyUserAccount(actor.userId);

        // The instant of the trade, read with every row lock held (as PlaceOrder): no sale after the stored close time,
        // and executedAt in trade-sequence order.
        const now = clock.now();
        guardDomain(() => assertTradable(market, now));

        const tradeId = ids.newId();
        const tradeSequence = market.tradeSequence + 1;
        let sale: SaleDecision;
        try {
          sale = decideSale({ trader, bot, marketId, side, sharesMicro, minProceedsMicro, offers: book.offers, tradeId, tradeSequence });
        } catch (error) {
          if (error instanceof DomainError && error.code === "proceeds_below_minimum") {
            // Nothing is sold; the answer carries a fresh sale quote so the client can decide again.
            const plan = guardDomain(() => planSale(book.offers, side, sharesMicro));
            throw new ProceedsBelowMinimum({
              ...error.details,
              quote: {
                marketId,
                side,
                sharesMicro,
                proceedsMicro: plan.proceedsMicro,
                averagePriceMicro: plan.averagePriceMicro,
                costMicro: plan.costMicro,
                fills: plan.fills,
                tradeSequence: market.tradeSequence,
                quotedAt: now.toISOString(),
              },
            });
          }
          if (error instanceof DomainError) throw fromDomainError(error);
          throw error;
        }

        const meta = userMeta(actor);
        for (const streamDecision of [sale.bot, sale.trader]) {
          await repositories.ledger.append({
            streamId: streamDecision.streamId,
            expectedVersion: streamDecision.expectedVersion,
            events: streamDecision.events,
            meta,
            recordedAt: now,
          });
          await repositories.accounts.save(streamDecision.next, now);
        }
        await repositories.botOrders.replace(marketId, sale.plan.remaining, book.pricedOnSequence, now);
        await repositories.marketStates.update(withTrade(market, now));
        // The event describes the buy of the other side, which is what moved the bot's book and the price (kind "sale").
        const bought = otherSide(side);
        const event = tradeExecutedEvent(
          {
            tradeId,
            marketId,
            userId: actor.userId,
            side: bought,
            sharesMicro,
            costMicro: sale.plan.costMicro,
            averagePriceMicro: averagePriceMicro(sale.plan.costMicro, sharesMicro) ?? 0,
            lastPriceMicro: sale.plan.worstPriceMicro,
            tradeSequence,
            executedAt: now.toISOString(),
            kind: "sale",
          },
          eventContext(this.deps, actor.tenantId, actor, now),
        );
        await repositories.outbox.add(outboxMessage("TradeExecuted", event, marketId, now));

        const held = holdingOf(sale.trader.next, marketId);
        const result: SaleResult = {
          tradeId,
          marketId,
          side,
          sharesMicro,
          proceedsMicro: sale.plan.proceedsMicro,
          averagePriceMicro: sale.plan.averagePriceMicro,
          costMicro: sale.plan.costMicro,
          fills: sale.plan.fills,
          tradeSequence,
          executedAt: now,
          balanceMicro: sale.trader.next.balanceMicro,
          position: { marketId, yesMicro: held.yesMicro, noMicro: held.noMicro },
        };
        await repositories.idempotency.complete(scope, key, result);
        return { result, replayed: false };
      }),
    );

    const fields = { tenantId: actor.tenantId, marketId, tradeId: placed.result.tradeId, correlationId: actor.correlationId };
    logger.info(fields, placed.replayed ? "Sale replayed from its Idempotency-Key" : "Sale executed");
    return placed;
  }
}
