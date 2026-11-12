import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { BOT_EVENT_TYPES, USER_EVENT_TYPES, botStreamId, businessKeyOf, emptyBotAccount, emptyUserAccount, evolve, evolveAll, holdingOf, replayStream } from "../../src/domain/ledger.js";
import type { AccountState, LedgerEvent } from "../../src/domain/ledger.js";
import { decideBuy, decideSale, planSale } from "../../src/domain/order-book.js";
import type { Offer } from "../../src/domain/order-book.js";
import { MICROS_PER_UNIT } from "../../src/domain/units.js";

// UC-08: a sale of S shares of one side buys S shares of the other side from the bot's offers and redeems the pairs.

const MARKET = "018f3c1e-7a00-7000-8000-000000000101";
const CREDIT = MICROS_PER_UNIT;
const SHARE = MICROS_PER_UNIT;
const BOOK: Offer[] = [
  { side: "YES", priceMicro: 400_000, sharesMicro: 100 * SHARE },
  { side: "YES", priceMicro: 450_000, sharesMicro: 200 * SHARE },
  { side: "NO", priceMicro: 600_000, sharesMicro: 100 * SHARE },
  { side: "NO", priceMicro: 650_000, sharesMicro: 200 * SHARE },
];

function errorOf(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a DomainError");
}

function fundedBot(credits: number): AccountState {
  return evolve(emptyBotAccount(MARKET, "admin-1"), { type: "BotFunded", data: { marketId: MARKET, creatorId: "admin-1", amountMicro: credits * CREDIT } });
}

function grantedTrader(credits: number): AccountState {
  return evolve(emptyUserAccount("trader-1"), { type: "CreditsGranted", data: { grantId: "g-1", amountMicro: credits * CREDIT, reason: "test" } });
}

/** A literal state, to put the bot or the trader exactly where a test needs it. */
function state(kind: "user" | "bot", balanceMicro: number, yesMicro: number, noMicro: number): AccountState {
  return kind === "user"
    ? { streamId: "account:trader-1", kind, ownerId: "trader-1", marketId: null, balanceMicro, positions: { [MARKET]: { yesMicro, noMicro } }, version: 2 }
    : { streamId: botStreamId(MARKET), kind, ownerId: "admin-1", marketId: MARKET, balanceMicro, positions: { [MARKET]: { yesMicro, noMicro } }, version: 3 };
}

const sale = (trader: AccountState, bot: AccountState, side: "YES" | "NO", sharesMicro: number, minProceedsMicro: number | null = null, offers = BOOK) =>
  decideSale({ trader, bot, marketId: MARKET, side, sharesMicro, minProceedsMicro, offers, tradeId: "t-2", tradeSequence: 2 });

describe("planSale", () => {
  it("buys the other side from its cheapest offer up and returns the shares minus that cost", () => {
    const plan = planSale(BOOK, "YES", 150 * SHARE);
    expect(plan.fills).toEqual([
      { priceMicro: 600_000, sharesMicro: 100 * SHARE, costMicro: 60 * CREDIT },
      { priceMicro: 650_000, sharesMicro: 50 * SHARE, costMicro: 32_500_000 },
    ]);
    expect(plan).toMatchObject({ side: "YES", sharesMicro: 150 * SHARE, costMicro: 92_500_000, proceedsMicro: 57_500_000, averagePriceMicro: 383_333, worstPriceMicro: 650_000 });
    // The YES offers stay; the used NO levels shrink or disappear.
    expect(plan.remaining).toEqual([BOOK[0], BOOK[1], { side: "NO", priceMicro: 650_000, sharesMicro: 150 * SHARE }]);
    expect(planSale(BOOK, "NO", 10 * SHARE)).toMatchObject({ costMicro: 4 * CREDIT, proceedsMicro: 6 * CREDIT, averagePriceMicro: 600_000, worstPriceMicro: 400_000 });
  });

  it("rounds each fill in the bot account's favour by less than one microcredit (ADR-055)", () => {
    // 3 microshares of NO at 0.65 cost ceil(1.95) = 2: the seller gets 1 instead of 1.05.
    expect(planSale(BOOK, "YES", 3)).toMatchObject({ costMicro: 2, proceedsMicro: 1, averagePriceMicro: 333_333 });
    // Across two levels: each fill is rounded up once, so the proceeds lie within one microcredit per fill of the exact value.
    const plan = planSale(BOOK, "YES", 100 * SHARE + 7);
    const exact = 100 * SHARE + 7 - (100 * SHARE * 0.6 + 7 * 0.65);
    expect(plan.proceedsMicro).toBeLessThanOrEqual(exact);
    expect(plan.proceedsMicro).toBeGreaterThan(exact - plan.fills.length);
  });

  it("is fill or kill: more shares than the other side's offers hold answers the most they can take", () => {
    const error = errorOf(() => planSale(BOOK, "YES", 300 * SHARE + 1));
    expect(error.code).toBe("insufficient_liquidity");
    expect(error.details).toEqual({ maxSharesMicro: 300 * SHARE });
    expect(errorOf(() => planSale(BOOK.filter((offer) => offer.side === "YES"), "YES", 1)).details).toEqual({ maxSharesMicro: 0 });
    expect(errorOf(() => planSale(BOOK, "YES", 0)).code).toBe("invalid_shares");
    expect(errorOf(() => planSale(BOOK, "YES", 1.5)).code).toBe("invalid_shares");
  });
});

describe("decideSale", () => {
  it("sells a bought position back: the trader's credits and the bot's, plus the pairs, stay the same total", () => {
    const bot0 = fundedBot(1000);
    const trader0 = grantedTrader(100);
    const buy = decideBuy({ trader: trader0, bot: bot0, marketId: MARKET, side: "YES", credits: 100, maxAveragePriceMicro: null, offers: BOOK, tradeId: "t-1", tradeSequence: 1 });
    const held = holdingOf(buy.trader.next, MARKET).yesMicro;
    expect(held).toBe(233_333_333);

    const sold = sale(buy.trader.next, buy.bot.next, "YES", held, null, buy.plan.remaining);
    // 233.333333 NO: 100 at 0.60 (60 credits) and 133.333333 at 0.65 (ceil 86.666666.45 = 86.666667 credits).
    expect(sold.plan).toMatchObject({ costMicro: 146_666_667, proceedsMicro: 86_666_666 });
    expect(sold.trader.events).toEqual([
      {
        type: "SharesSold",
        data: { tradeId: "t-2", marketId: MARKET, side: "YES", sharesMicro: held, costMicro: 146_666_667, proceedsMicro: 86_666_666, tradeSequence: 2, fills: sold.plan.fills },
      },
    ]);
    expect(sold.bot.events).toEqual([
      { type: "BotSharesSold", data: { tradeId: "t-2", side: "NO", sharesMicro: held, costMicro: 146_666_667, pairsCreatedMicro: 0, tradeSequence: 2 } },
    ]);
    expect(sold.trader.next).toMatchObject({ balanceMicro: 86_666_666, version: 3 });
    expect(holdingOf(sold.trader.next, MARKET)).toEqual({ yesMicro: 0, noMicro: 0 });

    const bot = holdingOf(sold.bot.next, MARKET);
    const pairs = bot.yesMicro; // the trader holds nothing, so the bot's YES are every YES of the market
    expect(bot.noMicro).toBe(pairs);
    expect(sold.trader.next.balanceMicro + sold.bot.next.balanceMicro + pairs).toBe((100 + 1000) * CREDIT);
    expect(sold.trader.expectedVersion).toBe(buy.trader.next.version);
    const granted: LedgerEvent = { type: "CreditsGranted", data: { grantId: "g-1", amountMicro: 100 * CREDIT, reason: "test" } };
    // The replay of the stream from its first event ends in the decided state (positions of loaded markets only).
    expect(replayStream(sold.trader.streamId, [granted, ...buy.trader.events, ...sold.trader.events])).toEqual(sold.trader.next);
  });

  it("lets a trader with no credits sell: one event, so no recorded state goes below zero", () => {
    const sold = sale(state("user", 0, 50 * SHARE, 0), fundedBot(1000), "YES", 50 * SHARE);
    expect(sold.trader.next.balanceMicro).toBe(20 * CREDIT); // 50 NO at 0.60 cost 30, the 50 pairs pay 50
    expect(sold.trader.events).toHaveLength(1);
  });

  it("creates the pairs the bot lacks from its credits, the payment included, as a buy does", () => {
    const sold = sale(state("user", 0, 100 * SHARE, 0), state("bot", 200 * CREDIT, 50 * SHARE, 10 * SHARE), "YES", 100 * SHARE);
    expect(sold.pairsCreatedMicro).toBe(90 * SHARE);
    expect(sold.bot.next.balanceMicro).toBe((200 + 60 - 90) * CREDIT);
    expect(holdingOf(sold.bot.next, MARKET)).toEqual({ yesMicro: 140 * SHARE, noMicro: 0 });
    const poor = errorOf(() => sale(state("user", 0, 100 * SHARE, 0), state("bot", 10 * CREDIT, 0, 10 * SHARE), "YES", 100 * SHARE));
    expect(poor.code).toBe("insufficient_holdings");
  });

  it("refuses a sale of more shares than the position holds, with what it holds", () => {
    const error = errorOf(() => sale(state("user", 0, 5 * SHARE, 9 * SHARE), fundedBot(1000), "YES", 5 * SHARE + 1));
    expect(error).toMatchObject({ code: "insufficient_shares", field: "sharesMicro", details: { side: "YES", heldMicro: 5 * SHARE } });
    expect(errorOf(() => sale(emptyUserAccount("trader-1"), fundedBot(1000), "NO", 1)).code).toBe("insufficient_shares");
    expect(errorOf(() => sale(state("user", 0, 5, 0), fundedBot(1000), "YES", 0)).code).toBe("invalid_shares");
  });

  it("refuses proceeds below minProceedsMicro (DM-18's counterpart) and a sale that would return nothing", () => {
    const trader = state("user", 0, 50 * SHARE, 0);
    expect(sale(trader, fundedBot(1000), "YES", 50 * SHARE, 20 * CREDIT).plan.proceedsMicro).toBe(20 * CREDIT);
    const error = errorOf(() => sale(trader, fundedBot(1000), "YES", 50 * SHARE, 20 * CREDIT + 1));
    expect(error).toMatchObject({ code: "proceeds_below_minimum", details: { proceedsMicro: 20 * CREDIT, minProceedsMicro: 20 * CREDIT + 1 } });
    // One microshare of YES against NO at 0.65: the NO share costs ceil(0.65) = 1, the pair pays 1, nothing is left.
    const dust = errorOf(() => sale(trader, fundedBot(1000), "YES", 1));
    expect(dust).toMatchObject({ code: "proceeds_below_minimum", details: { proceedsMicro: 0, minProceedsMicro: 1 } });
  });

  it("refuses a bot account of another market and a trader that is not a user", () => {
    const other = emptyBotAccount("018f3c1e-7a00-7000-8000-000000000999");
    expect(errorOf(() => sale(state("user", 0, 5, 0), other, "YES", 5)).code).toBe("invariant_violated");
    expect(errorOf(() => sale(fundedBot(10), fundedBot(10), "YES", 5)).code).toBe("invariant_violated");
  });
});

describe("evolve SharesSold", () => {
  const sold = (data: Partial<{ sharesMicro: number; costMicro: number; proceedsMicro: number; side: "YES" | "NO" }>): LedgerEvent => ({
    type: "SharesSold",
    data: { tradeId: "t-9", marketId: MARKET, side: "YES", sharesMicro: 10, costMicro: 4, proceedsMicro: 6, tradeSequence: 1, fills: [], ...data },
  });

  it("takes the shares sold and adds the proceeds; the other side is untouched; it is a user event keyed by its trade", () => {
    expect(USER_EVENT_TYPES).toContain("SharesSold");
    expect(BOT_EVENT_TYPES).not.toContain("SharesSold");
    expect(businessKeyOf("account:trader-1", sold({}))).toBe("t-9");
    const next = evolve(state("user", 0, 10, 3), sold({}));
    expect(next).toMatchObject({ balanceMicro: 6, version: 3 });
    expect(holdingOf(next, MARKET)).toEqual({ yesMicro: 0, noMicro: 3 });
  });

  it("refuses proceeds that are not shares minus cost, a position too small and a bot stream", () => {
    expect(errorOf(() => evolve(state("user", 0, 10, 0), sold({ proceedsMicro: 7 }))).code).toBe("invariant_violated");
    expect(errorOf(() => evolve(state("user", 0, 10, 0), sold({ costMicro: 11, proceedsMicro: -1 }))).code).toBe("invariant_violated");
    expect(errorOf(() => evolve(state("user", 0, 9, 0), sold({}))).code).toBe("invariant_violated");
    expect(errorOf(() => evolve(state("bot", 0, 10, 0), sold({}))).code).toBe("invariant_violated");
    expect(evolveAll(state("user", 0, 0, 10), [sold({ side: "NO" })]).balanceMicro).toBe(6);
  });
});
