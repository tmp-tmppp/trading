import type { MarketEventNotice } from "../domain/consumed.js";
import { marketSettledEvent } from "../domain/events.js";
import { botStreamId, emptyUserAccount, userStreamId } from "../domain/ledger.js";
import { applyClosed, applyOpened, applyResolved, markSettled, needsSettlement } from "../domain/market-state.js";
import type { Applied, MarketState } from "../domain/market-state.js";
import { decideRefundSettlement, decideSettlement } from "../domain/settlement.js";
import type { SettlementSummary } from "../domain/settlement.js";
import { eventContext, eventMeta, MARKET_EVENTS_CONSUMER, outboxMessage, withConflictRetry } from "./support.js";
import { guardDomain } from "./errors.js";
import type { TenantRepositories, UseCaseDeps } from "./ports.js";
import type { MarketEventResult, RecordMarketEventUseCase } from "./use-cases.js";

/** Applies the lifecycle event to the stored copy (null: no copy yet) under markets' version guard (DM-04). */
function apply(notice: MarketEventNotice, state: MarketState | null, now: Date): Applied {
  switch (notice.kind) {
    case "market_opened":
      return applyOpened(state, notice.facts, now);
    case "market_closed":
      return applyClosed(state, notice.facts, now);
    case "market_resolved":
      return applyResolved(state, notice.facts, now);
  }
}

/**
 * MarketOpened, MarketClosed and MarketResolved of markets (EP-2, DM-04), each in one transaction with its inbox
 * entry. The copy changes only when the event's version is higher than the stored one, so a late or repeated event never
 * rolls a market back, and the events of one market need no order: resolved before closed, opened after resolved and
 * repeats all fold correctly. A resolved copy is final (DM-19): no later event changes its status or outcome. Concurrent events of one market serialise on the market_state row; a copy that a
 * concurrent funding or event created after our read (insert answers false) is read again with its lock and decided
 * again. MarketClosed and MarketResolved cancel the bot's offers; MarketResolved settles the market exactly once
 * (FL-A step 10): the ledger's business keys and `settledAt` both refuse a second settlement.
 * The tenant comes from markets, a trusted service: `ensureTenant`, so TenantNotReady never happens here.
 */
export class RecordMarketEvent implements RecordMarketEventUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(notice: MarketEventNotice): Promise<MarketEventResult> {
    const { store, clock, logger } = this.deps;
    const tenant = await store.ensureTenant(notice.tenantId, clock.now());
    const result = await withConflictRetry(() =>
      tenant.transaction(async (repositories): Promise<MarketEventResult> => {
        const now = clock.now();
        const fresh = await repositories.inbox.record({ consumer: MARKET_EVENTS_CONSUMER, eventId: notice.eventId, eventType: notice.eventType, processedAt: now });
        if (!fresh) return "duplicate";
        const marketId = notice.facts.marketId;

        let current = await repositories.marketStates.find(marketId, { lock: true });
        let applied = apply(notice, current, now);
        if (applied.kind !== "stale") {
          if (current === null) {
            if (!(await repositories.marketStates.insert(applied.state))) {
              // A concurrent funding or event created the row after our read: decide again on the locked row.
              current = await repositories.marketStates.find(marketId, { lock: true });
              if (current === null) throw new Error(`The market ${marketId} vanished between an insert and a read`);
              applied = apply(notice, current, now);
              if (applied.kind !== "stale") await repositories.marketStates.update(applied.state);
            }
          } else {
            await repositories.marketStates.update(applied.state);
          }
        }

        if (notice.kind === "market_opened") {
          // After market_state, as FundMarket does (TRD-08). A market belongs to one tenant for good.
          if (applied.kind !== "stale" && (await repositories.marketDirectory.register(marketId, notice.tenantId, now)) !== notice.tenantId) {
            throw new Error(`The market ${marketId} is registered for another tenant than ${notice.tenantId}`);
          }
          return applied.kind;
        }
        if (applied.kind !== "stale") await repositories.botOrders.clear(marketId);
        if (notice.kind === "market_closed") return applied.kind;

        // A resolved copy is final (DM-19: markets resolves once), so a MarketResolved with another outcome breaks markets'
        // contract. It changes nothing; the error keeps the contradiction visible (the ledger settled the stored outcome).
        const storedOutcome = applied.state.outcome;
        if (applied.kind === "stale" && storedOutcome !== null && storedOutcome !== notice.facts.outcome) {
          logger.error(
            {
              tenantId: notice.tenantId,
              marketId,
              eventId: notice.eventId,
              storedOutcome,
              eventOutcome: notice.facts.outcome,
              storedVersion: applied.state.version,
              eventVersion: notice.facts.version,
              correlationId: notice.correlationId,
            },
            "A MarketResolved contradicts the market's outcome; ignored",
          );
        }
        // MarketResolved: settle when the copy is resolved and not settled yet (a repeat finds `settledAt` set).
        if (!needsSettlement(applied.state)) return applied.kind;
        await this.settle(repositories, applied.state, notice.eventId, notice.correlationId, notice.tenantId, now);
        return "settled";
      }),
    );
    logger.info(
      { tenantId: notice.tenantId, marketId: notice.facts.marketId, eventId: notice.eventId, kind: notice.kind, result, correlationId: notice.correlationId },
      "Market event processed",
    );
    return result;
  }

  /**
   * Pays every winning share one microcredit (the bot account's own included) and returns what the bot account holds to
   * the creator, in one transaction with the resolution. Lock order: market_state (held), the bot account, then every
   * holder by stream id; the creator is locked with them whether it holds a position or not.
   * INVALID (UC-16) refunds instead: every share is voided, every trader gets back its net payment from the ledger and
   * the creator the rest (decideRefundSettlement). The traders who paid into the market are read from the ledger after
   * the market_state lock (every trade of the market takes it first, so none can be added meanwhile) and locked with the
   * holders, by stream id: a trader who sold everything holds nothing and is still refunded.
   */
  private async settle(
    repositories: TenantRepositories,
    market: MarketState,
    eventId: string,
    correlationId: string | null,
    tenantId: string,
    now: Date,
  ): Promise<void> {
    const outcome = market.outcome;
    if (outcome === null) throw new Error(`The resolved market ${market.marketId} has no outcome`);
    const bot = await repositories.accounts.load(botStreamId(market.marketId), { lock: true, marketIds: [market.marketId] });
    // The bot account's owner is whoever funded the market: the ledger's own record, the first choice for the return.
    const creatorId = bot?.ownerId ?? market.creatorId;
    if (creatorId === null) throw new Error(`The resolved market ${market.marketId} has no creator`);
    const creatorStream = userStreamId(creatorId);
    const payments = outcome === "INVALID" ? await repositories.ledger.marketPayments(market.marketId) : [];
    const alsoStreamIds = [creatorStream, ...payments.map((payment) => payment.streamId)];
    const holders = await repositories.accounts.holdersOf(market.marketId, { lock: true, alsoStreamIds });
    const accounts = holders.some((holder) => holder.streamId === creatorStream) ? holders : [...holders, emptyUserAccount(creatorId)];

    const settlement = guardDomain(() =>
      outcome === "INVALID"
        ? decideRefundSettlement({ marketId: market.marketId, creatorId, fundingMicro: market.fundingMicro, bot, accounts, payments })
        : decideSettlement({ marketId: market.marketId, outcome, creatorId, bot, accounts }),
    );
    const meta = eventMeta({ eventId, correlationId });
    for (const streamDecision of settlement.decisions) {
      await repositories.ledger.append({
        streamId: streamDecision.streamId,
        expectedVersion: streamDecision.expectedVersion,
        events: streamDecision.events,
        meta,
        recordedAt: now,
      });
      await repositories.accounts.save(streamDecision.next, now);
    }
    await repositories.marketStates.update(markSettled(market, settlement.summary, now));
    const event = marketSettledEvent(
      {
        marketId: market.marketId,
        outcome,
        creatorId,
        payoutTotalMicro: settlement.summary.payoutTotalMicro,
        payoutCount: settlement.summary.payoutCount,
        returnedToCreatorMicro: settlement.summary.returnedToCreatorMicro,
        settledAt: now.toISOString(),
      },
      eventContext(this.deps, tenantId, { correlationId: correlationId ?? eventId, causationId: eventId }, now),
    );
    await repositories.outbox.add(outboxMessage("MarketSettled", event, market.marketId, now));
    this.deps.logger.info({ tenantId, marketId: market.marketId, outcome, ...summaryFields(settlement.summary) }, "Market settled");
  }
}

function summaryFields(summary: SettlementSummary): Record<string, number> {
  return {
    payoutTotalMicro: summary.payoutTotalMicro,
    payoutCount: summary.payoutCount,
    botPayoutMicro: summary.botPayoutMicro,
    returnedToCreatorMicro: summary.returnedToCreatorMicro,
  };
}
