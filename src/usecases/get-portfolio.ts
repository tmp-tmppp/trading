import { withdrawableCredits } from "../domain/accounts.js";
import { nonEmptyPositions, userStreamId } from "../domain/ledger.js";
import { MICROS_PER_UNIT, averagePriceMicro, mulDivFloor } from "../domain/units.js";
import { TenantNotReady, guardDomain } from "./errors.js";
import type { RecordedLedgerEvent, UseCaseDeps } from "./ports.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageSize } from "./support.js";
import type { FundedMarket, GetPortfolioUseCase, PayoutEntry, Portfolio, PortfolioInput, PortfolioPosition, TradeEntry } from "./use-cases.js";

function tradeEntry(event: RecordedLedgerEvent): TradeEntry[] {
  if (event.type === "SharesBought") {
    const { data } = event;
    return [
      {
        tradeId: data.tradeId,
        marketId: data.marketId,
        kind: "buy",
        side: data.side,
        sharesMicro: data.sharesMicro,
        costMicro: data.costMicro,
        proceedsMicro: null,
        averagePriceMicro: averagePriceMicro(data.costMicro, data.sharesMicro) ?? 0,
        tradeSequence: data.tradeSequence,
        executedAt: event.recordedAt,
      },
    ];
  }
  if (event.type === "SharesSold") {
    // UC-08: the side sold and what it returned; the price is what each share sold brought (floor, as the sale's answer).
    const { data } = event;
    return [
      {
        tradeId: data.tradeId,
        marketId: data.marketId,
        kind: "sale",
        side: data.side,
        sharesMicro: data.sharesMicro,
        costMicro: data.costMicro,
        proceedsMicro: data.proceedsMicro,
        averagePriceMicro: mulDivFloor(data.proceedsMicro, MICROS_PER_UNIT, data.sharesMicro),
        tradeSequence: data.tradeSequence,
        executedAt: event.recordedAt,
      },
    ];
  }
  return [];
}

function payoutEntry(event: RecordedLedgerEvent): PayoutEntry[] {
  if (event.type === "PositionSettled") {
    return [{ marketId: event.data.marketId, kind: "winnings", amountMicro: event.data.payoutMicro, outcome: event.data.outcome, paidAt: event.recordedAt }];
  }
  if (event.type === "PositionRefunded") {
    return [{ marketId: event.data.marketId, kind: "refund", amountMicro: event.data.refundMicro, outcome: "INVALID", paidAt: event.recordedAt }];
  }
  if (event.type === "HoldingsReturned") {
    return [{ marketId: event.data.marketId, kind: "returned", amountMicro: event.data.amountMicro, outcome: null, paidAt: event.recordedAt }];
  }
  return [];
}

/**
 * The portfolio of the caller (UC-05, UC-06): balance and the part a withdrawal may take, the non-empty positions with
 * the market copy's question and status, the newest trades and payouts, and for a tenant admin the markets funded.
 * A user without an account sees zeros. Reads only, so it takes no lock.
 */
export class GetPortfolio implements GetPortfolioUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: PortfolioInput): Promise<Portfolio> {
    const { actor } = input;
    const limit = pageSize(input.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const streamId = guardDomain(() => userStreamId(actor.userId));
    const tenant = await this.deps.store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const { accounts, marketStates, ledger } = tenant.repositories;

    const account = await accounts.load(streamId);
    const held = account ? Object.entries(nonEmptyPositions(account)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [];
    const markets = new Map((await marketStates.findMany(held.map(([marketId]) => marketId))).map((market) => [market.marketId, market]));
    const positions: PortfolioPosition[] = held.map(([marketId, holding]) => {
      const market = markets.get(marketId);
      return {
        marketId,
        yesMicro: holding.yesMicro,
        noMicro: holding.noMicro,
        question: market?.question ?? null,
        status: market?.status ?? null,
        closeTime: market?.closeTime ?? null,
      };
    });

    const trades = (await ledger.readStream(streamId, { types: ["SharesBought", "SharesSold"], order: "desc", limit })).flatMap(tradeEntry);
    const payouts = (await ledger.readStream(streamId, { types: ["PositionSettled", "PositionRefunded", "HoldingsReturned"], order: "desc", limit })).flatMap(payoutEntry);

    let fundedMarkets: FundedMarket[] | null = null;
    if (actor.role === "tenant-admin") {
      const bots = await accounts.botAccountsOwnedBy(actor.userId);
      const copies = new Map((await marketStates.findMany(bots.flatMap((bot) => (bot.marketId === null ? [] : [bot.marketId])))).map((market) => [market.marketId, market]));
      // Newest first: market ids are UUIDv7, so they sort by creation time.
      fundedMarkets = bots
        .flatMap((bot) => (bot.marketId === null ? [] : [bot.marketId]))
        .sort()
        .reverse()
        .map((marketId) => {
          const market = copies.get(marketId);
          return {
            marketId,
            question: market?.question ?? null,
            status: market?.status ?? null,
            fundingMicro: market?.fundingMicro ?? null,
            returnedMicro: market?.returnedMicro ?? null,
            settledAt: market?.settledAt ?? null,
          };
        });
    }

    const balanceMicro = account?.balanceMicro ?? 0;
    return { balanceMicro, withdrawableCredits: account ? withdrawableCredits(account) : 0, positions, recentTrades: trades, payouts, fundedMarkets };
  }
}
