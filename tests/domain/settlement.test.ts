import { describe, expect, it } from "vitest";
import { decideDeposit, decideFunding } from "../../src/domain/accounts.js";
import { DomainError } from "../../src/domain/errors.js";
import { emptyBotAccount, emptyUserAccount, holdingOf, nonEmptyPositions } from "../../src/domain/ledger.js";
import type { AccountState } from "../../src/domain/ledger.js";
import {
  applyClosed,
  applyOpened,
  applyResolved,
  assertTradable,
  markSettled,
  needsSettlement,
  newFundedMarket,
  recordFunding,
  tradingRefusal,
  withTrade,
} from "../../src/domain/market-state.js";
import type { OpenedFacts } from "../../src/domain/market-state.js";
import { decideBuy } from "../../src/domain/order-book.js";
import type { Offer } from "../../src/domain/order-book.js";
import { decideSettlement } from "../../src/domain/settlement.js";
import type { Side } from "../../src/domain/units.js";
import { CREATOR, MARKET_1, TRADER } from "../support/fakes.js";

const SHARE = 1_000_000;
const NOW = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-08T10:00:00.000Z");

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

const total = (accounts: AccountState[]): number => accounts.reduce((sum, account) => sum + account.balanceMicro, 0);

/** Funding, two traders buying both sides, then settlement: credits are conserved exactly. */
function scenario(outcome: Side) {
  let creator = decideDeposit(emptyUserAccount(CREATOR), { depositId: "d-c", credits: 5000 }).next;
  let alice = decideDeposit(emptyUserAccount(TRADER), { depositId: "d-a", credits: 100 }).next;
  let bob = decideDeposit(emptyUserAccount("trader-2"), { depositId: "d-b", credits: 100 }).next;
  const before = total([creator, alice, bob]);
  const funding = decideFunding(creator, emptyBotAccount(MARKET_1), { marketId: MARKET_1, creatorId: CREATOR, credits: 30 });
  creator = funding.creator.next;
  let bot = funding.bot.next;
  let offers: Offer[] = [
    { side: "YES", priceMicro: 550_000, sharesMicro: 30 * SHARE },
    { side: "NO", priceMicro: 480_000, sharesMicro: 30 * SHARE },
  ];
  const buyA = decideBuy({ trader: alice, bot, marketId: MARKET_1, side: "YES", credits: 13, maxAveragePriceMicro: null, offers, tradeId: "t-1", tradeSequence: 1 });
  alice = buyA.trader.next;
  bot = buyA.bot.next;
  offers = buyA.plan.remaining;
  const buyB = decideBuy({ trader: bob, bot, marketId: MARKET_1, side: "NO", credits: 9, maxAveragePriceMicro: null, offers, tradeId: "t-2", tradeSequence: 2 });
  bob = buyB.trader.next;
  bot = buyB.bot.next;
  const settlement = decideSettlement({ marketId: MARKET_1, outcome, creatorId: CREATOR, bot, accounts: [bob, creator, alice] });
  return { before, settlement, alice, bob, bot, creator };
}

describe("decideSettlement", () => {
  it("pays every winning share, returns the bot's holdings to the creator and conserves credits exactly", () => {
    for (const outcome of ["YES", "NO"] as const) {
      const { before, settlement } = scenario(outcome);
      const after = settlement.decisions.map((decision) => decision.next);
      const users = after.filter((account) => account.kind === "user");
      const botAfter = after.find((account) => account.kind === "bot");
      expect(botAfter?.balanceMicro).toBe(0);
      expect(botAfter && nonEmptyPositions(botAfter)).toEqual({});
      for (const user of users) expect(holdingOf(user, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 0 });
      // Every account of the scenario is in the decisions (the creator gets the return), so the sum is complete.
      expect(total(users)).toBe(before);
      // Alice bought 23.636363 YES for 13 credits at 0.55; Bob 18.75 NO for 9 credits at 0.48; one of them wins.
      expect(settlement.summary.payoutCount).toBe(1);
      expect(settlement.summary.payoutTotalMicro).toBe(outcome === "YES" ? 23_636_363 : 18_750_000);
      expect(settlement.summary.returnedToCreatorMicro).toBe(outcome === "YES" ? 22 * SHARE + 6_363_637 : 22 * SHARE + 11_250_000);
    }
  });

  it("orders the bot account first, then the users by stream id, and records the creator's return", () => {
    const { settlement } = scenario("YES");
    expect(settlement.decisions.map((decision) => decision.streamId)).toEqual([`bot:${MARKET_1}`, "account:admin-1", "account:trader-1", "account:trader-2"]);
    const bot = settlement.decisions[0];
    expect(bot?.events.map((event) => event.type)).toEqual(["BotSettled", "BotHoldingsReturned"]);
    const creator = settlement.decisions[1];
    expect(creator?.events).toEqual([{ type: "HoldingsReturned", data: { marketId: MARKET_1, amountMicro: settlement.summary.returnedToCreatorMicro } }]);
    const loser = settlement.decisions[3];
    expect(loser?.events[0]).toMatchObject({ type: "PositionSettled", data: { outcome: "YES", payoutMicro: 0 } });
  });

  it("settles a market trading never funded, and refuses a missing creator account or a bot of another market", () => {
    expect(decideSettlement({ marketId: MARKET_1, outcome: "NO", creatorId: CREATOR, bot: null, accounts: [] }).decisions).toEqual([]);
    const { bot } = scenario("YES");
    expect(errorCode(() => decideSettlement({ marketId: MARKET_1, outcome: "YES", creatorId: CREATOR, bot, accounts: [] }))).toBe("invariant_violated");
    const other = emptyBotAccount("018f3c1e-7a00-7000-8000-000000000999");
    expect(errorCode(() => decideSettlement({ marketId: MARKET_1, outcome: "YES", creatorId: CREATOR, bot: other, accounts: [] }))).toBe("invariant_violated");
    const alice = emptyUserAccount(TRADER);
    expect(errorCode(() => decideSettlement({ marketId: MARKET_1, outcome: "YES", creatorId: CREATOR, bot: null, accounts: [alice, alice] }))).toBe("invariant_violated");
  });
});

describe("market state", () => {
  const opened: OpenedFacts = {
    marketId: MARKET_1,
    version: 3,
    question: "Will it snow in Ljubljana?",
    closeTime: LATER,
    startingPriceMicro: 550_000,
    creatorId: CREATOR,
    openedAt: NOW,
  };

  it("works with funding first, then MarketOpened", () => {
    const funded = newFundedMarket(MARKET_1, CREATOR, 30 * SHARE, NOW);
    expect(funded).toMatchObject({ status: "funded", version: 0, fundingMicro: 30 * SHARE });
    expect(tradingRefusal(funded, NOW)).toBe("The market is not open yet");
    const open = applyOpened(funded, opened, NOW);
    expect(open.kind).toBe("applied");
    expect(open.state).toMatchObject({ status: "open", version: 3, question: opened.question, startingPriceMicro: 550_000, fundingMicro: 30 * SHARE });
    expect(() => assertTradable(open.state, NOW)).not.toThrow();
  });

  it("works with MarketOpened first, then funding", () => {
    const open = applyOpened(null, opened, NOW).state;
    expect(tradingRefusal(open, NOW)).toBe("The market is not funded yet");
    const funded = recordFunding(open, CREATOR, 30 * SHARE, NOW);
    expect(funded).toMatchObject({ status: "open", fundingMicro: 30 * SHARE, fundedAt: NOW });
    expect(tradingRefusal(funded, NOW)).toBeNull();
    expect(errorCode(() => recordFunding(funded, CREATOR, 1, NOW))).toBe("invariant_violated");
  });

  it("guards by version (DM-04): a late or repeated event never rolls the market back", () => {
    const open = applyOpened(null, opened, NOW).state;
    expect(applyOpened(open, opened, NOW)).toEqual({ state: open, kind: "stale" });
    const closed = applyClosed(open, { marketId: MARKET_1, version: 4, closedAt: NOW }, NOW).state;
    expect(closed.status).toBe("closed");
    expect(applyOpened(closed, opened, NOW).kind).toBe("stale");
    expect(applyClosed(closed, { marketId: MARKET_1, version: 4, closedAt: NOW }, NOW).kind).toBe("stale");
    const resolved = applyResolved(closed, { marketId: MARKET_1, version: 5, outcome: "NO", resolvedAt: NOW, creatorId: CREATOR }, NOW).state;
    expect(resolved).toMatchObject({ status: "resolved", outcome: "NO", version: 5 });
    expect(applyClosed(resolved, { marketId: MARKET_1, version: 4, closedAt: NOW }, NOW).kind).toBe("stale");
    expect(applyResolved(resolved, { marketId: MARKET_1, version: 5, outcome: "YES", resolvedAt: NOW, creatorId: CREATOR }, NOW).kind).toBe("stale");
    expect(errorCode(() => recordFunding(closed, CREATOR, 1, NOW))).toBe("market_closed");
  });

  it("lets a late MarketOpened fill in the question of a market first seen closed, without reopening it", () => {
    const closed = applyClosed(null, { marketId: MARKET_1, version: 4, closedAt: NOW }, NOW).state;
    expect(closed.creatorId).toBeNull();
    const filled = applyOpened(closed, opened, NOW);
    expect(filled.kind).toBe("filled");
    expect(filled.state).toMatchObject({ status: "closed", version: 4, question: opened.question, creatorId: CREATOR });
  });

  it("refuses orders after the close time, counts trades and marks the settlement once", () => {
    const open = recordFunding(applyOpened(null, opened, NOW).state, CREATOR, SHARE, NOW);
    expect(tradingRefusal(open, LATER)).toBe("The market is past its close time");
    expect(errorCode(() => assertTradable(open, LATER))).toBe("market_not_open");
    expect(withTrade(withTrade(open, NOW), NOW).tradeSequence).toBe(2);
    const resolved = applyResolved(open, { marketId: MARKET_1, version: 5, outcome: "YES", resolvedAt: NOW, creatorId: CREATOR }, NOW).state;
    expect(needsSettlement(resolved)).toBe(true);
    const settled = markSettled(resolved, { payoutTotalMicro: 7, payoutCount: 1, botPayoutMicro: 3, returnedToCreatorMicro: 9 }, NOW);
    expect(settled).toMatchObject({ settledAt: NOW, payoutTotalMicro: 7, returnedMicro: 9 });
    expect(needsSettlement(settled)).toBe(false);
    expect(errorCode(() => markSettled(settled, { payoutTotalMicro: 0, payoutCount: 0, botPayoutMicro: 0, returnedToCreatorMicro: 0 }, NOW))).toBe(
      "invariant_violated",
    );
  });
});
