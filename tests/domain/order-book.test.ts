import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { emptyBotAccount, emptyUserAccount, evolve, holdingOf } from "../../src/domain/ledger.js";
import type { AccountState } from "../../src/domain/ledger.js";
import { assertOffersBacked, decideBuy, liquidityMicro, offersOf, parseOffers, planBuy, quoteBuy, sortOffers } from "../../src/domain/order-book.js";
import type { Offer } from "../../src/domain/order-book.js";
import { CREATOR, MARKET_1, TRADER } from "../support/fakes.js";

function errorOf(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a DomainError");
}

const SHARE = 1_000_000;

function fundedBot(credits: number): AccountState {
  return evolve(emptyBotAccount(MARKET_1), { type: "BotFunded", data: { marketId: MARKET_1, creatorId: CREATOR, amountMicro: credits * SHARE } });
}

function traderWith(credits: number): AccountState {
  return evolve(emptyUserAccount(TRADER), { type: "DepositCredited", data: { depositId: "d-1", amountMicro: credits * SHARE } });
}

const BOOK: Offer[] = [
  { side: "YES", priceMicro: 520_000, sharesMicro: 10 * SHARE },
  { side: "YES", priceMicro: 500_000, sharesMicro: 10 * SHARE },
  { side: "NO", priceMicro: 520_000, sharesMicro: 10 * SHARE },
];

describe("parseOffers", () => {
  it("accepts a book on the grid, sorted YES before NO and cheapest first; an empty book cancels all", () => {
    const raw = BOOK.map((offer) => ({ ...offer }));
    expect(parseOffers(raw, 10)).toEqual(sortOffers(BOOK));
    expect(parseOffers([], 10)).toEqual([]);
    expect(offersOf(BOOK, "YES").map((offer) => offer.priceMicro)).toEqual([500_000, 520_000]);
  });

  it("refuses prices off the grid or outside 0.01 .. 0.99, bad shares, repeats, too many offers", () => {
    expect(errorOf(() => parseOffers([{ side: "YES", priceMicro: 995_000, sharesMicro: 1 }], 10)).code).toBe("invalid_price");
    expect(errorOf(() => parseOffers([{ side: "YES", priceMicro: 1_000_000, sharesMicro: 1 }], 10)).field).toBe("offers[0].priceMicro");
    expect(errorOf(() => parseOffers([{ side: "YES", priceMicro: 0, sharesMicro: 1 }], 10)).code).toBe("invalid_price");
    expect(errorOf(() => parseOffers([{ side: "YES", priceMicro: 500_000, sharesMicro: 0 }], 10)).code).toBe("invalid_shares");
    expect(errorOf(() => parseOffers([{ side: "MAYBE", priceMicro: 500_000, sharesMicro: 1 }], 10)).code).toBe("invalid_side");
    expect(errorOf(() => parseOffers({}, 10)).code).toBe("invalid_offers");
    expect(errorOf(() => parseOffers([7], 10)).code).toBe("invalid_offers");
    const repeated = [
      { side: "NO", priceMicro: 500_000, sharesMicro: 1 },
      { side: "NO", priceMicro: 500_000, sharesMicro: 2 },
    ];
    expect(errorOf(() => parseOffers(repeated, 10)).code).toBe("invalid_offers");
    const many = [1, 2, 3].map((i) => ({ side: "YES", priceMicro: 500_000 + i * 10_000, sharesMicro: 1 }));
    expect(errorOf(() => parseOffers(many, 2)).code).toBe("invalid_offers");
  });

  it("refuses crossed offers: a pair cheaper than 1 credit pays 1 whatever the outcome", () => {
    const crossed = [
      { side: "YES", priceMicro: 480_000, sharesMicro: 1 },
      { side: "NO", priceMicro: 510_000, sharesMicro: 1 },
    ];
    const error = errorOf(() => parseOffers(crossed, 10));
    expect(error.code).toBe("crossed_offers");
    expect(error.details).toEqual({ yesPriceMicro: 480_000, noPriceMicro: 510_000 });
    expect(parseOffers([{ side: "YES", priceMicro: 490_000, sharesMicro: 1 }, { side: "NO", priceMicro: 510_000, sharesMicro: 1 }], 10)).toHaveLength(2);
  });
});

describe("assertOffersBacked", () => {
  it("allows per side what the bot holds plus the pairs its credits can create", () => {
    const bot = { ...fundedBot(10), balanceMicro: 5 * SHARE };
    expect(() => assertOffersBacked([{ side: "YES", priceMicro: 500_000, sharesMicro: 15 * SHARE }], bot)).not.toThrow();
    const error = errorOf(() => assertOffersBacked([{ side: "NO", priceMicro: 500_000, sharesMicro: 15 * SHARE + 1 }], bot));
    expect(error.code).toBe("insufficient_holdings");
    expect(error.details).toMatchObject({ side: "NO", availableMicro: 15 * SHARE });
  });

  it("refuses offers that are each valid but add up past the exact integers as insufficient_holdings, not as an out-of-range error", () => {
    const bot = { ...fundedBot(10), balanceMicro: 5 * SHARE };
    const huge = 5_000_000_000_000_000;
    const error = errorOf(() =>
      assertOffersBacked(
        [
          { side: "YES", priceMicro: 400_000, sharesMicro: huge },
          { side: "YES", priceMicro: 450_000, sharesMicro: huge },
        ],
        bot,
      ),
    );
    expect(error.code).toBe("insufficient_holdings");
    expect(error.details).toMatchObject({ side: "YES", offeredMicro: 2 * huge, availableMicro: 15 * SHARE });
  });
});

describe("planBuy", () => {
  it("fills from the cheapest offer up and spends exactly the amount", () => {
    const plan = quoteBuy(BOOK, "YES", 7);
    // 10 shares at 0.50 cost 5 credits; the remaining 2 credits buy 3.846153 shares at 0.52.
    expect(plan.fills).toEqual([
      { priceMicro: 500_000, sharesMicro: 10 * SHARE, costMicro: 5 * SHARE },
      { priceMicro: 520_000, sharesMicro: 3_846_153, costMicro: 2 * SHARE },
    ]);
    expect(plan.costMicro).toBe(7 * SHARE);
    expect(plan.sharesMicro).toBe(13_846_153);
    expect(plan.averagePriceMicro).toBe(505_556);
    expect(plan.worstPriceMicro).toBe(520_000);
    expect(plan.remaining).toEqual([
      { side: "YES", priceMicro: 520_000, sharesMicro: 6_153_847 },
      { side: "NO", priceMicro: 520_000, sharesMicro: 10 * SHARE },
    ]);
  });

  it("takes whole levels exactly and removes emptied ones", () => {
    const plan = quoteBuy(BOOK, "YES", 5);
    expect(plan.fills).toEqual([{ priceMicro: 500_000, sharesMicro: 10 * SHARE, costMicro: 5 * SHARE }]);
    expect(offersOf(plan.remaining, "YES")).toEqual([{ side: "YES", priceMicro: 520_000, sharesMicro: 10 * SHARE }]);
  });

  it("refuses an amount the offers cannot absorb, with the largest whole amount they can", () => {
    expect(liquidityMicro(BOOK, "YES")).toBe(10_200_000);
    const error = errorOf(() => quoteBuy(BOOK, "YES", 11));
    expect(error.code).toBe("insufficient_liquidity");
    expect(error.details).toEqual({ maxAmount: 10 });
    expect(errorOf(() => quoteBuy([], "NO", 1)).details).toEqual({ maxAmount: 0 });
    expect(errorOf(() => planBuy(BOOK, "YES", 0)).code).toBe("invalid_amount");
  });
});

describe("decideBuy", () => {
  const base = { marketId: MARKET_1, offers: BOOK, tradeId: "t-1", tradeSequence: 1, maxAveragePriceMicro: null };

  it("moves the credits to the bot account and the shares to the trader", () => {
    const result = decideBuy({ ...base, trader: traderWith(100), bot: fundedBot(50), side: "YES", credits: 7 });
    expect(result.trader.next.balanceMicro).toBe(93 * SHARE);
    expect(holdingOf(result.trader.next, MARKET_1)).toEqual({ yesMicro: 13_846_153, noMicro: 0 });
    expect(result.bot.next.balanceMicro).toBe(7 * SHARE);
    expect(holdingOf(result.bot.next, MARKET_1)).toEqual({ yesMicro: 50 * SHARE - 13_846_153, noMicro: 50 * SHARE });
    expect(result.pairsCreatedMicro).toBe(0);
    expect(result.trader.events[0]).toMatchObject({ type: "SharesBought", data: { tradeId: "t-1", tradeSequence: 1, costMicro: 7 * SHARE } });
    expect(result.bot.expectedVersion).toBe(1);
  });

  it("creates the pairs the bot lacks from its credits", () => {
    const bot = { ...fundedBot(5), balanceMicro: 10 * SHARE };
    const result = decideBuy({ ...base, trader: traderWith(100), bot, side: "YES", credits: 7 });
    expect(result.pairsCreatedMicro).toBe(13_846_153 - 5 * SHARE);
    expect(result.bot.next.balanceMicro).toBe(17 * SHARE - result.pairsCreatedMicro);
    expect(holdingOf(result.bot.next, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 5 * SHARE + result.pairsCreatedMicro });
    expect(result.bot.events[0]).toMatchObject({ type: "BotSharesSold", data: { pairsCreatedMicro: 8_846_153 } });
  });

  it("may create the pairs from the payment of the same trade", () => {
    const result = decideBuy({ ...base, trader: traderWith(100), bot: fundedBot(10), side: "YES", credits: 7 });
    expect(result.pairsCreatedMicro).toBe(3_846_153);
    expect(result.bot.next.balanceMicro).toBe(7 * SHARE - 3_846_153);
    expect(holdingOf(result.bot.next, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 13_846_153 });
  });

  it("refuses too few credits, a price above maxAveragePriceMicro (DM-18) and an unbacked book", () => {
    expect(errorOf(() => decideBuy({ ...base, trader: traderWith(6), bot: fundedBot(50), side: "YES", credits: 7 })).code).toBe("insufficient_credits");
    const limited = errorOf(() => decideBuy({ ...base, trader: traderWith(100), bot: fundedBot(50), side: "YES", credits: 7, maxAveragePriceMicro: 505_000 }));
    expect(limited.code).toBe("price_limit_exceeded");
    expect(limited.details).toEqual({ averagePriceMicro: 505_556, maxAveragePriceMicro: 505_000 });
    expect(decideBuy({ ...base, trader: traderWith(100), bot: fundedBot(50), side: "YES", credits: 7, maxAveragePriceMicro: 505_556 }).plan.costMicro).toBe(7 * SHARE);
    const empty = emptyBotAccount(MARKET_1, CREATOR);
    expect(errorOf(() => decideBuy({ ...base, trader: traderWith(100), bot: empty, side: "YES", credits: 7 })).code).toBe("insufficient_holdings");
    expect(errorOf(() => decideBuy({ ...base, trader: fundedBot(1), bot: fundedBot(1), side: "YES", credits: 1 })).code).toBe("invariant_violated");
  });

  it("keeps a backed book fillable on both sides one buy after another", () => {
    let trader = traderWith(1000);
    let bot = fundedBot(20);
    let offers: Offer[] = [
      { side: "YES", priceMicro: 600_000, sharesMicro: 20 * SHARE },
      { side: "NO", priceMicro: 450_000, sharesMicro: 20 * SHARE },
    ];
    assertOffersBacked(offers, bot);
    for (const [index, side] of (["YES", "NO", "YES", "NO"] as const).entries()) {
      const result = decideBuy({ ...base, trader, bot, offers, side, credits: 4, tradeId: `t-${index}`, tradeSequence: index + 1 });
      trader = result.trader.next;
      bot = result.bot.next;
      offers = result.plan.remaining;
      assertOffersBacked(offers, bot);
    }
    expect(trader.balanceMicro).toBe(984 * SHARE);
    expect(bot.balanceMicro).toBeGreaterThanOrEqual(0);
  });
});
