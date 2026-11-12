import { DomainError } from "../domain/errors.js";
import { tradeExecutedEvent } from "../domain/events.js";
import { botStreamId, emptyUserAccount, holdingOf, parseMarketId, userStreamId } from "../domain/ledger.js";
import { assertTradable, withTrade } from "../domain/market-state.js";
import { decideBuy, quoteBuy } from "../domain/order-book.js";
import type { BuyDecision } from "../domain/order-book.js";
import { parseCreditAmount, parseSide } from "../domain/units.js";
import { IdempotencyKeyReused, MarketNotOpen, NotFound, OrdersPaused, PriceLimitExceeded, TenantNotReady, ValidationFailed, fromDomainError, guardDomain } from "./errors.js";
import type { RuleDeps } from "./ports.js";
import { eventContext, orderScope, outboxMessage, parseIdempotencyKey, requestHash, requireTrader, userMeta, withConflictRetry } from "./support.js";
import type { OrderResult, PlaceOrderInput, PlaceOrderUseCase, PlacedOrder } from "./use-cases.js";

/** DM-18's bound as the contract states it: an integer from 1 to 999 999 microcredits per share. */
function parseMaxAveragePrice(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 999_999) {
    throw new ValidationFailed([{ field: "maxAveragePriceMicro", message: "maxAveragePriceMicro must be an integer from 1 to 999999" }]);
  }
  return value;
}

/** The stored result of a completed key comes back from JSON: only the date needs reviving. */
function reviveOrderResult(stored: unknown): OrderResult {
  const raw = stored as Omit<OrderResult, "executedAt"> & { executedAt: string };
  return { ...raw, executedAt: new Date(raw.executedAt) };
}

/**
 * A trader's buy (FL-A step 6), one transaction: idempotency key, market copy (open, before its close time), balance,
 * fills from the cheapest offer up with the pairs the bot lacks created first, ledger appends on both streams with
 * expected versions, the projections, the remaining offers, trade sequence + 1 and TradeExecuted in the outbox
 * (REL-01). A lost race (LedgerConflict) decides the whole order again; a refusal rolls everything back, the claimed
 * key included, so a refused order can be repeated.
 *
 * Order of checks: role, shape, tenant, the key (a completed key answers its stored result even after ORDER_AMOUNT_MAX
 * was lowered or orders were paused, REL-03), the runtime rules (a newly claimed key only), the market.
 * Lock order: market_state row, the bot account, the trader's account.
 */
export class PlaceOrder implements PlaceOrderUseCase {
  constructor(private readonly deps: RuleDeps) {}

  async execute(input: PlaceOrderInput): Promise<PlacedOrder> {
    const { store, clock, ids, logger, rules } = this.deps;
    const { actor } = input;
    requireTrader(actor.role);
    const key = parseIdempotencyKey(input.idempotencyKey);
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const side = guardDomain(() => parseSide(input.side));
    const amount = guardDomain(() => parseCreditAmount(input.amount));
    const maxAveragePriceMicro = parseMaxAveragePrice(input.maxAveragePriceMicro);
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();

    const scope = orderScope(actor.userId);
    const hash = requestHash({ marketId, side, amount, maxAveragePriceMicro });

    const placed = await withConflictRetry(() =>
      tenant.transaction(async (repositories): Promise<PlacedOrder> => {
        // The claim waits for a concurrent holder of the same key, so this reading is only the key's creation time: the
        // trade is stamped later, once the row locks are held (`now` below).
        const claim = await repositories.idempotency.claim({ scope, key, requestHash: hash, now: clock.now() });
        if (claim.kind === "mismatch") throw new IdempotencyKeyReused();
        if (claim.kind === "replay") return { result: reviveOrderResult(claim.result), replayed: true };

        const current = rules.current();
        if (!current.ordersEnabled) throw new OrdersPaused();
        if (amount > current.orderAmountMax) {
          throw new ValidationFailed([{ field: "amount", message: `amount must not be more than ${current.orderAmountMax} credits` }]);
        }

        const market = await repositories.marketStates.find(marketId, { lock: true });
        if (!market) throw new NotFound();
        // Checked first, with a reading taken after the market row was granted, so a market that is not open answers
        // before the bot account is looked at.
        guardDomain(() => assertTradable(market, clock.now()));
        // The book is read after the market row is locked: a stale read would sell an offer a concurrent order consumed.
        const book = await repositories.botOrders.get(marketId);
        const bot = await repositories.accounts.load(botStreamId(marketId), { lock: true, marketIds: [marketId] });
        if (!bot) throw new MarketNotOpen("The market has no bot account yet");
        const trader = (await repositories.accounts.load(userStreamId(actor.userId), { lock: true, marketIds: [marketId] })) ?? emptyUserAccount(actor.userId);

        // The instant of the trade: read only now, with every row lock held, because the waits for the market row and
        // the trader's account (concurrent orders, a settlement, a replay's table lock) can take seconds. An earlier
        // reading would let an order execute after the stored close time, and would stamp it before trades that already
        // hold a lower trade sequence (executedAt and the outbox time stay in trade-sequence order).
        const now = clock.now();
        guardDomain(() => assertTradable(market, now));

        const tradeId = ids.newId();
        const tradeSequence = market.tradeSequence + 1;
        let buy: BuyDecision;
        try {
          buy = decideBuy({ trader, bot, marketId, side, credits: amount, maxAveragePriceMicro, offers: book.offers, tradeId, tradeSequence });
        } catch (error) {
          if (error instanceof DomainError && error.code === "price_limit_exceeded") {
            // DM-18: nothing is bought; the answer carries a fresh quote so the client can decide again.
            const plan = guardDomain(() => quoteBuy(book.offers, side, amount));
            throw new PriceLimitExceeded({
              ...error.details,
              quote: {
                marketId,
                side,
                amount,
                sharesMicro: plan.sharesMicro,
                costMicro: plan.costMicro,
                averagePriceMicro: plan.averagePriceMicro,
                worstPriceMicro: plan.worstPriceMicro,
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
        for (const streamDecision of [buy.bot, buy.trader]) {
          await repositories.ledger.append({
            streamId: streamDecision.streamId,
            expectedVersion: streamDecision.expectedVersion,
            events: streamDecision.events,
            meta,
            recordedAt: now,
          });
          await repositories.accounts.save(streamDecision.next, now);
        }
        await repositories.botOrders.replace(marketId, buy.plan.remaining, book.pricedOnSequence, now);
        await repositories.marketStates.update(withTrade(market, now));
        const event = tradeExecutedEvent(
          {
            tradeId,
            marketId,
            userId: actor.userId,
            side,
            sharesMicro: buy.plan.sharesMicro,
            costMicro: buy.plan.costMicro,
            averagePriceMicro: buy.plan.averagePriceMicro,
            lastPriceMicro: buy.plan.worstPriceMicro,
            tradeSequence,
            executedAt: now.toISOString(),
            kind: "buy",
          },
          eventContext(this.deps, actor.tenantId, actor, now),
        );
        await repositories.outbox.add(outboxMessage("TradeExecuted", event, marketId, now));

        const held = holdingOf(buy.trader.next, marketId);
        const result: OrderResult = {
          tradeId,
          marketId,
          side,
          amount,
          sharesMicro: buy.plan.sharesMicro,
          costMicro: buy.plan.costMicro,
          averagePriceMicro: buy.plan.averagePriceMicro,
          worstPriceMicro: buy.plan.worstPriceMicro,
          fills: buy.plan.fills,
          tradeSequence,
          executedAt: now,
          balanceMicro: buy.trader.next.balanceMicro,
          position: { marketId, yesMicro: held.yesMicro, noMicro: held.noMicro },
        };
        await repositories.idempotency.complete(scope, key, result);
        return { result, replayed: false };
      }),
    );

    const fields = { tenantId: actor.tenantId, marketId, tradeId: placed.result.tradeId, correlationId: actor.correlationId };
    logger.info(fields, placed.replayed ? "Order replayed from its Idempotency-Key" : "Order executed");
    return placed;
  }
}
