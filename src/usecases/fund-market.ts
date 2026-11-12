import { decideFunding } from "../domain/accounts.js";
import { marketFundedEvent } from "../domain/events.js";
import { botStreamId, emptyBotAccount, emptyUserAccount, parseMarketId, parseUserId, userStreamId } from "../domain/ledger.js";
import { newFundedMarket, recordFunding } from "../domain/market-state.js";
import type { MarketState } from "../domain/market-state.js";
import { parseTenantId } from "../domain/tenant.js";
import { creditsToMicro, parseCreditAmount } from "../domain/units.js";
import { IdempotencyKeyReused, ValidationFailed, guardDomain } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { FUNDING_SCOPE, eventContext, outboxMessage, requestHash, serviceMeta, withConflictRetry } from "./support.js";
import type { FundMarketInput, FundMarketResult, FundMarketUseCase, MarketFunding } from "./use-cases.js";

/** The completed funding as the idempotency table keeps it (JSON): the date needs reviving. */
function reviveFunding(stored: unknown): MarketFunding {
  const raw = stored as Omit<MarketFunding, "fundedAt"> & { fundedAt: string };
  return { ...raw, fundedAt: new Date(raw.fundedAt) };
}

/**
 * FL-A step 2, called by markets' opening saga: the creator's credits become pairs in the market's bot account
 * (DM-07, ADR-013). One transaction: the key (= the market id, REL-03), the market copy created as "funded" or the one
 * MarketOpened made, the directory entry, both ledger streams, MarketFunded in the outbox. Only a completed funding is
 * stored under the key: a refusal (too few credits, a closed market) rolls back everything, the copy included.
 *
 * Lock order (TRD-08): market_state, then the shared directory row, then the bot account, then the creator's account;
 * RecordMarketEvent takes market_state and the directory in the same order, so the two never wait on each other.
 * The tenant comes from markets, a trusted service: `ensureTenant` provisions it when TenantCreated never arrived.
 */
export class FundMarket implements FundMarketUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: FundMarketInput): Promise<FundMarketResult> {
    const { store, clock, logger } = this.deps;
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const tenantId = guardDomain(() => parseTenantId(input.tenantId));
    const creatorId = guardDomain(() => parseUserId(input.creatorId, "creatorId"));
    const amount = guardDomain(() => parseCreditAmount(input.amount));
    if (input.idempotencyKey?.toLowerCase() !== marketId) {
      throw new ValidationFailed([{ field: "Idempotency-Key", message: "The Idempotency-Key header must equal the marketId" }]);
    }
    const fundingMicro = creditsToMicro(amount);
    const hash = requestHash({ marketId, tenantId, creatorId, amount });
    const tenant = await store.ensureTenant(tenantId, clock.now());

    const result = await withConflictRetry(() =>
      tenant.transaction(async (repositories): Promise<FundMarketResult> => {
        const now = clock.now();
        const claim = await repositories.idempotency.claim({ scope: FUNDING_SCOPE, key: marketId, requestHash: hash, now });
        if (claim.kind === "mismatch") throw new IdempotencyKeyReused();
        if (claim.kind === "replay") return { funding: reviveFunding(claim.result), created: false };

        // The market copy: created as "funded", or the one MarketOpened created is funded (both orders of arrival).
        const existing = await repositories.marketStates.find(marketId, { lock: true });
        let market: MarketState;
        if (existing === null) {
          market = newFundedMarket(marketId, creatorId, fundingMicro, now);
          if (!(await repositories.marketStates.insert(market))) {
            // A concurrent MarketOpened created the row after our read: decide again on the locked row.
            const raced = await repositories.marketStates.find(marketId, { lock: true });
            if (raced === null) throw new Error(`The market ${marketId} vanished between an insert and a read`);
            market = this.fund(raced, creatorId, fundingMicro, now);
            await repositories.marketStates.update(market);
          }
        } else {
          market = this.fund(existing, creatorId, fundingMicro, now);
          await repositories.marketStates.update(market);
        }
        // After market_state, as RecordMarketEvent does: the market must not belong to another tenant.
        if ((await repositories.marketDirectory.register(marketId, tenantId, now)) !== tenantId) {
          throw new IdempotencyKeyReused("The market belongs to another tenant");
        }

        const bot = (await repositories.accounts.load(botStreamId(marketId), { lock: true, marketIds: [marketId] })) ?? emptyBotAccount(marketId, creatorId);
        const creator = (await repositories.accounts.load(userStreamId(creatorId), { lock: true, marketIds: [] })) ?? emptyUserAccount(creatorId);
        const funded = guardDomain(() => decideFunding(creator, bot, { marketId, creatorId, credits: amount }));
        const meta = serviceMeta(input.caller);
        for (const streamDecision of [funded.bot, funded.creator]) {
          await repositories.ledger.append({
            streamId: streamDecision.streamId,
            expectedVersion: streamDecision.expectedVersion,
            events: streamDecision.events,
            meta,
            recordedAt: now,
          });
          await repositories.accounts.save(streamDecision.next, now);
        }

        const fundedAt = now.toISOString();
        const event = marketFundedEvent({ marketId, creatorId, amount, fundedAt }, eventContext(this.deps, tenantId, input.caller, now));
        await repositories.outbox.add(outboxMessage("MarketFunded", event, marketId, now));
        const funding: MarketFunding = { marketId, amount, fundedAt: now };
        await repositories.idempotency.complete(FUNDING_SCOPE, marketId, { marketId, amount, fundedAt });
        return { funding, created: true };
      }),
    );
    logger.info(
      { tenantId, marketId, correlationId: input.caller.correlationId, client: input.caller.client, created: result.created },
      result.created ? "Market funded" : "Funding repeated; answered from its Idempotency-Key",
    );
    return result;
  }

  /** recordFunding, plus the check that the funding creator is the one MarketOpened named. */
  private fund(market: MarketState, creatorId: string, fundingMicro: number, now: Date): MarketState {
    if (market.creatorId !== null && market.creatorId !== creatorId) throw new IdempotencyKeyReused("The market was opened by another creator");
    return guardDomain(() => recordFunding(market, creatorId, fundingMicro, now));
  }
}
