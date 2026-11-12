import { decision } from "./accounts.js";
import type { StreamDecision } from "./accounts.js";
import { DomainError } from "./errors.js";
import { holdingOf } from "./ledger.js";
import type { AccountState, Fill } from "./ledger.js";
import {
  MICROS_PER_UNIT,
  addMicro,
  averagePriceMicro,
  averageWithin,
  costOfShares,
  creditsToMicro,
  isMicroQuantity,
  isSide,
  mulDivFloor,
  otherSide,
  parsePriceMicro,
  sharesForBudget,
  subMicro,
  wholeCredits,
} from "./units.js";
import type { Side } from "./units.js";

// The order book of a market (ADR-019, ADR-041): only the bot's resting offers, a short list per side. A trader's buy
// is a market order that takes the cheapest offers first, all in one transaction, and spends exactly its amount or
// nothing (fill or kill: an amount the offers cannot absorb is refused with the largest amount they can).

export interface Offer {
  side: Side;
  /** Microcredits per share, on the grid of units.ts (0.01 .. 0.99). */
  priceMicro: number;
  /** Microshares offered at that price, at least 1. */
  sharesMicro: number;
}

/** The most offers per side the bot may post; the runtime setting MAX_OFFERS_PER_SIDE is at most this. */
export const MAX_OFFERS_PER_SIDE_LIMIT = 50;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** YES before NO, cheapest first: the order the book is stored and shown in. */
export function sortOffers(offers: readonly Offer[]): Offer[] {
  return [...offers].sort((a, b) => (a.side === b.side ? a.priceMicro - b.priceMicro : a.side === "YES" ? -1 : 1));
}

/** The offers of one side, cheapest first. */
export function offersOf(offers: readonly Offer[], side: Side): Offer[] {
  return sortOffers(offers.filter((offer) => offer.side === side));
}

/**
 * Checks a replacement book from the bot (PUT bot-orders): each offer is {side, priceMicro, sharesMicro} with a price
 * on the grid (outside 0.01 .. 0.99 is refused, plan 6.2) and at least one microshare; one offer per side and price; at
 * most `maxPerSide` per side; and the cheapest YES and the cheapest NO together cost at least 1 credit, because a pair
 * bought for less than 1 pays 1 at resolution whatever the outcome (crossed_offers). An empty list cancels every offer.
 */
export function parseOffers(raw: unknown, maxPerSide: number): Offer[] {
  if (!Array.isArray(raw)) throw new DomainError("invalid_offers", "offers must be an array", "offers");
  const offers: Offer[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const field = `offers[${index}]`;
    if (!isObject(item)) throw new DomainError("invalid_offers", `${field} must be an object`, field);
    if (!isSide(item["side"])) throw new DomainError("invalid_side", `${field}.side must be YES or NO`, `${field}.side`);
    const priceMicro = parsePriceMicro(item["priceMicro"], `${field}.priceMicro`);
    const sharesMicro = item["sharesMicro"];
    if (!isMicroQuantity(sharesMicro) || sharesMicro < 1) {
      throw new DomainError("invalid_shares", `${field}.sharesMicro must be a positive safe integer`, `${field}.sharesMicro`);
    }
    const key = `${item["side"]}:${priceMicro}`;
    if (seen.has(key)) throw new DomainError("invalid_offers", `${field} repeats the price ${priceMicro} of side ${item["side"]}`, field);
    seen.add(key);
    offers.push({ side: item["side"], priceMicro, sharesMicro });
  });
  for (const side of ["YES", "NO"] as const) {
    const count = offers.filter((offer) => offer.side === side).length;
    if (count > maxPerSide) throw new DomainError("invalid_offers", `At most ${maxPerSide} offers per side are allowed (${side}: ${count})`, "offers");
  }
  const bestYes = offersOf(offers, "YES")[0];
  const bestNo = offersOf(offers, "NO")[0];
  if (bestYes && bestNo && bestYes.priceMicro + bestNo.priceMicro < MICROS_PER_UNIT) {
    throw new DomainError("crossed_offers", "The cheapest YES and the cheapest NO offer together cost less than 1 credit", "offers", {
      yesPriceMicro: bestYes.priceMicro,
      noPriceMicro: bestNo.priceMicro,
    });
  }
  return sortOffers(offers);
}

/**
 * The bot can never sell more than its account holds (plan 6.2): per side, the offered microshares must not exceed the
 * shares it holds plus the pairs its credits can create. A book that passes this check can always be filled: every fill
 * adds the trader's payment to the credits, so the backing of the other offers never shrinks.
 */
export function assertOffersBacked(offers: readonly Offer[], bot: AccountState): void {
  if (bot.kind !== "bot" || bot.marketId === null) throw new DomainError("invariant_violated", `${bot.streamId} is not a bot account`);
  const holding = holdingOf(bot, bot.marketId);
  for (const side of ["YES", "NO"] as const) {
    // Compared as BigInt: offers that are each valid can add up past the range of exact integers, and that sum is an
    // answer (409), never an internal error.
    const offered = offersOf(offers, side).reduce((sum, offer) => sum + BigInt(offer.sharesMicro), 0n);
    const available = BigInt(side === "YES" ? holding.yesMicro : holding.noMicro) + BigInt(bot.balanceMicro);
    if (offered > available) {
      throw new DomainError("insufficient_holdings", `The bot account cannot back ${offered} offered microshares of ${side} (it can deliver ${available})`, "offers", {
        side,
        offeredMicro: Number(offered),
        availableMicro: Number(available),
      });
    }
  }
}

/** What all offers of one side cost together: the most a buy of that side can spend. */
export function liquidityMicro(offers: readonly Offer[], side: Side): number {
  return offersOf(offers, side).reduce((sum, offer) => addMicro(sum, costOfShares(offer.sharesMicro, offer.priceMicro)), 0);
}

export interface BuyPlan {
  side: Side;
  /** The amount of the order in microcredits; a plan always spends all of it. */
  budgetMicro: number;
  /** Cheapest level first. */
  fills: Fill[];
  sharesMicro: number;
  costMicro: number;
  /** ceil(cost x 10^6 / shares). */
  averagePriceMicro: number;
  /** The price of the last (most expensive) level that was used. */
  worstPriceMicro: number;
  /** The whole book after the buy (both sides): used levels reduced, emptied levels removed. */
  remaining: Offer[];
}

/**
 * Walks the offers of `side` from the cheapest up and spends exactly `budgetMicro`: whole levels while the budget
 * covers them, then floor(budget x 10^6 / price) microshares of the next level, which costs exactly the rest (the rest
 * is below the price of one share, so ceil(shares x price / 10^6) equals it). If the offers cannot absorb the whole
 * amount: insufficient_liquidity with `maxAmount`, the most whole credits they can take.
 */
export function planBuy(offers: readonly Offer[], side: Side, budgetMicro: number): BuyPlan {
  if (!isMicroQuantity(budgetMicro) || budgetMicro < 1) throw new DomainError("invalid_amount", "The amount must be positive", "amount");
  const levels = offersOf(offers, side);
  const available = liquidityMicro(offers, side);
  if (available < budgetMicro) {
    throw new DomainError("insufficient_liquidity", "The offers of the market maker cannot fill this amount now", "amount", {
      maxAmount: wholeCredits(available),
    });
  }
  const fills: Fill[] = [];
  const used = new Map<number, number>();
  let left = budgetMicro;
  for (const level of levels) {
    if (left === 0) break;
    const fullCost = costOfShares(level.sharesMicro, level.priceMicro);
    const sharesMicro = fullCost <= left ? level.sharesMicro : sharesForBudget(left, level.priceMicro);
    const costMicro = fullCost <= left ? fullCost : costOfShares(sharesMicro, level.priceMicro);
    if (sharesMicro === 0) break;
    fills.push({ priceMicro: level.priceMicro, sharesMicro, costMicro });
    used.set(level.priceMicro, sharesMicro);
    left = subMicro(left, costMicro);
  }
  if (left !== 0) throw new DomainError("invariant_violated", `A buy left ${left} microcredits unspent although the offers could absorb them`);
  const sharesMicro = fills.reduce((sum, fill) => addMicro(sum, fill.sharesMicro), 0);
  const costMicro = fills.reduce((sum, fill) => addMicro(sum, fill.costMicro), 0);
  const remaining = sortOffers(offers)
    .map((offer) => (offer.side === side && used.has(offer.priceMicro) ? { ...offer, sharesMicro: offer.sharesMicro - (used.get(offer.priceMicro) ?? 0) } : offer))
    .filter((offer) => offer.sharesMicro > 0);
  const last = fills[fills.length - 1];
  return {
    side,
    budgetMicro,
    fills,
    sharesMicro,
    costMicro,
    averagePriceMicro: averagePriceMicro(costMicro, sharesMicro) ?? 0,
    worstPriceMicro: last?.priceMicro ?? 0,
    remaining,
  };
}

/** A quote (GET /v1/trading/quote): the plan of a buy of `credits` now, without any change. */
export function quoteBuy(offers: readonly Offer[], side: Side, credits: number): BuyPlan {
  return planBuy(offers, side, creditsToMicro(credits));
}

export interface BuyInput {
  trader: AccountState;
  /** The market's bot account, with the market's holding loaded. */
  bot: AccountState;
  marketId: string;
  side: Side;
  /** Whole credits to spend (the order's amount). */
  credits: number;
  /** DM-18: fill only if the average price stays at or below this; null for no limit. */
  maxAveragePriceMicro: number | null;
  offers: readonly Offer[];
  tradeId: string;
  /** The market's trade sequence after this trade (the stored one + 1). */
  tradeSequence: number;
}

export interface BuyDecision {
  trader: StreamDecision;
  bot: StreamDecision;
  plan: BuyPlan;
  /** Pairs the bot created from its credits for this trade (0 when its holding sufficed). */
  pairsCreatedMicro: number;
}

/**
 * A trader's buy (FL-A step 6), decided on the states of both accounts: the trader pays exactly `credits`, the bot
 * delivers the planned microshares, first creating the pairs it lacks from its credits (the payment included).
 * Errors: insufficient_credits (balance), insufficient_liquidity (offers), price_limit_exceeded (DM-18),
 * insufficient_holdings (a book that was not backed; the bot account never goes below zero).
 */
export function decideBuy(input: BuyInput): BuyDecision {
  const { trader, bot, marketId, side } = input;
  if (trader.kind !== "user") throw new DomainError("invariant_violated", `${trader.streamId} is not a user account`);
  if (bot.kind !== "bot" || bot.marketId !== marketId) throw new DomainError("invariant_violated", `${bot.streamId} is not the bot account of ${marketId}`);
  const budgetMicro = creditsToMicro(input.credits);
  if (trader.balanceMicro < budgetMicro) {
    throw new DomainError("insufficient_credits", "The balance is lower than the amount", "amount", { withdrawableCredits: wholeCredits(trader.balanceMicro) });
  }
  const plan = planBuy(input.offers, side, budgetMicro);
  if (input.maxAveragePriceMicro !== null && !averageWithin(plan.costMicro, plan.sharesMicro, input.maxAveragePriceMicro)) {
    throw new DomainError("price_limit_exceeded", "The average price would be above maxAveragePriceMicro", "maxAveragePriceMicro", {
      averagePriceMicro: plan.averagePriceMicro,
      maxAveragePriceMicro: input.maxAveragePriceMicro,
    });
  }
  const delivery = decideBotDelivery(bot, { tradeId: input.tradeId, side, sharesMicro: plan.sharesMicro, costMicro: plan.costMicro, tradeSequence: input.tradeSequence }, "amount");
  return {
    trader: decision(trader, [
      {
        type: "SharesBought",
        data: { tradeId: input.tradeId, marketId, side, sharesMicro: plan.sharesMicro, costMicro: plan.costMicro, tradeSequence: input.tradeSequence, fills: plan.fills },
      },
    ]),
    bot: delivery.bot,
    plan,
    pairsCreatedMicro: delivery.pairsCreatedMicro,
  };
}

/**
 * The bot's side of a trade, the same for a buy and a sale: it delivers `sharesMicro` of `side` for `costMicro`, first
 * creating the pairs it lacks from its credits (the payment included). A backed book never fails this check.
 */
function decideBotDelivery(
  bot: AccountState,
  trade: { tradeId: string; side: Side; sharesMicro: number; costMicro: number; tradeSequence: number },
  field: string,
): { bot: StreamDecision; pairsCreatedMicro: number } {
  const holding = holdingOf(bot, bot.marketId ?? "");
  const held = trade.side === "YES" ? holding.yesMicro : holding.noMicro;
  const pairsCreatedMicro = Math.max(0, subMicro(trade.sharesMicro, held));
  if (addMicro(bot.balanceMicro, trade.costMicro) < pairsCreatedMicro) {
    throw new DomainError("insufficient_holdings", "The bot account cannot deliver these shares", field);
  }
  return {
    bot: decision(bot, [
      {
        type: "BotSharesSold",
        data: { tradeId: trade.tradeId, side: trade.side, sharesMicro: trade.sharesMicro, costMicro: trade.costMicro, pairsCreatedMicro, tradeSequence: trade.tradeSequence },
      },
    ]),
    pairsCreatedMicro,
  };
}

// --- Selling (UC-08, plan 6.2) ------------------------------------------------------------------------------------
// One YES and one NO share always pay 1 credit together, so selling S shares of a side is buying S shares of the other
// side from the bot's offers and redeeming the S pairs for S microcredits (plan section 12: "selling then reuses buying
// plus a redeem step"). The other side is bought fill-or-kill on shares, cheapest first, with the rounding of a buy:
// each fill costs ceil(shares x price / 10^6), in the bot account's favour by less than one microcredit per fill. The
// proceeds S - cost are never negative (a price is below 1 credit per share), and a sale that would return nothing is
// refused (proceeds_below_minimum): the trader would give its shares away.

export interface SalePlan {
  /** The side sold. */
  side: Side;
  /** Microshares sold; the same number of the other side is bought. */
  sharesMicro: number;
  /** The levels of the other side bought, cheapest first, priced as the bot's offers. */
  fills: Fill[];
  /** What the shares of the other side cost. */
  costMicro: number;
  /** sharesMicro - costMicro: what the sale adds to the balance. */
  proceedsMicro: number;
  /** floor(proceeds x 10^6 / shares): microcredits received per share sold (rounded in the bot account's favour). */
  averagePriceMicro: number;
  /** The most expensive level of the other side used (as the bot's offer of that side is priced). */
  worstPriceMicro: number;
  /** The whole book after the sale (both sides). */
  remaining: Offer[];
}

/**
 * Buys exactly `sharesMicro` of `side` from its offers, cheapest first (fill or kill). Offers that hold fewer shares:
 * insufficient_liquidity with `maxSharesMicro`, the most the book can deliver now.
 */
function planSharesOf(offers: readonly Offer[], side: Side, sharesMicro: number): { fills: Fill[]; costMicro: number; remaining: Offer[] } {
  if (!isMicroQuantity(sharesMicro) || sharesMicro < 1) throw new DomainError("invalid_shares", "sharesMicro must be a positive safe integer", "sharesMicro");
  const levels = offersOf(offers, side);
  const offered = levels.reduce((sum, level) => sum + BigInt(level.sharesMicro), 0n);
  if (offered < BigInt(sharesMicro)) {
    throw new DomainError("insufficient_liquidity", "The offers of the market maker cannot take these shares now", "sharesMicro", {
      maxSharesMicro: Number(offered),
    });
  }
  const fills: Fill[] = [];
  const used = new Map<number, number>();
  let left = sharesMicro;
  for (const level of levels) {
    if (left === 0) break;
    const take = Math.min(left, level.sharesMicro);
    fills.push({ priceMicro: level.priceMicro, sharesMicro: take, costMicro: costOfShares(take, level.priceMicro) });
    used.set(level.priceMicro, take);
    left -= take;
  }
  const costMicro = fills.reduce((sum, fill) => addMicro(sum, fill.costMicro), 0);
  const remaining = sortOffers(offers)
    .map((offer) => (offer.side === side && used.has(offer.priceMicro) ? { ...offer, sharesMicro: offer.sharesMicro - (used.get(offer.priceMicro) ?? 0) } : offer))
    .filter((offer) => offer.sharesMicro > 0);
  return { fills, costMicro, remaining };
}

/** The plan of a sale of `sharesMicro` of `side` now (also the sale quote): the other side bought, the proceeds. */
export function planSale(offers: readonly Offer[], side: Side, sharesMicro: number): SalePlan {
  const bought = planSharesOf(offers, otherSide(side), sharesMicro);
  const proceedsMicro = subMicro(sharesMicro, bought.costMicro);
  if (proceedsMicro < 0) throw new DomainError("invariant_violated", `A sale of ${sharesMicro} microshares would cost ${bought.costMicro}`);
  const last = bought.fills[bought.fills.length - 1];
  return {
    side,
    sharesMicro,
    fills: bought.fills,
    costMicro: bought.costMicro,
    proceedsMicro,
    averagePriceMicro: mulDivFloor(proceedsMicro, MICROS_PER_UNIT, sharesMicro),
    worstPriceMicro: last?.priceMicro ?? 0,
    remaining: bought.remaining,
  };
}

export interface SaleInput {
  trader: AccountState;
  /** The market's bot account, with the market's holding loaded. */
  bot: AccountState;
  marketId: string;
  /** The side sold. */
  side: Side;
  sharesMicro: number;
  /** The counterpart of DM-18: sell only if the proceeds are at least this; null for no limit (still at least 1). */
  minProceedsMicro: number | null;
  offers: readonly Offer[];
  tradeId: string;
  /** The market's trade sequence after this trade (the stored one + 1). */
  tradeSequence: number;
}

export interface SaleDecision {
  trader: StreamDecision;
  bot: StreamDecision;
  plan: SalePlan;
  pairsCreatedMicro: number;
}

/**
 * A trader's sale (UC-08), decided on the states of both accounts: the trader must hold at least `sharesMicro` of
 * `side` in the market; the bot delivers that many of the other side (creating the pairs it lacks, as for a buy) and the
 * trader's pairs are redeemed in the same event (SharesSold). Errors: insufficient_shares (the position),
 * insufficient_liquidity (offers, with maxSharesMicro), proceeds_below_minimum (minProceedsMicro, or a sale that would
 * return nothing), insufficient_holdings (a book that was not backed).
 */
export function decideSale(input: SaleInput): SaleDecision {
  const { trader, bot, marketId, side, sharesMicro } = input;
  if (trader.kind !== "user") throw new DomainError("invariant_violated", `${trader.streamId} is not a user account`);
  if (bot.kind !== "bot" || bot.marketId !== marketId) throw new DomainError("invariant_violated", `${bot.streamId} is not the bot account of ${marketId}`);
  if (!isMicroQuantity(sharesMicro) || sharesMicro < 1) throw new DomainError("invalid_shares", "sharesMicro must be a positive safe integer", "sharesMicro");
  const holding = holdingOf(trader, marketId);
  const heldMicro = side === "YES" ? holding.yesMicro : holding.noMicro;
  if (heldMicro < sharesMicro) {
    throw new DomainError("insufficient_shares", `The position holds fewer ${side} shares than the sale`, "sharesMicro", { side, heldMicro });
  }
  const plan = planSale(input.offers, side, sharesMicro);
  const minimum = Math.max(1, input.minProceedsMicro ?? 1);
  if (plan.proceedsMicro < minimum) {
    throw new DomainError("proceeds_below_minimum", "The proceeds would be below minProceedsMicro (a sale must return at least 1 microcredit)", "minProceedsMicro", {
      proceedsMicro: plan.proceedsMicro,
      minProceedsMicro: minimum,
    });
  }
  const delivery = decideBotDelivery(
    bot,
    { tradeId: input.tradeId, side: otherSide(side), sharesMicro, costMicro: plan.costMicro, tradeSequence: input.tradeSequence },
    "sharesMicro",
  );
  return {
    trader: decision(trader, [
      {
        type: "SharesSold",
        data: {
          tradeId: input.tradeId,
          marketId,
          side,
          sharesMicro,
          costMicro: plan.costMicro,
          proceedsMicro: plan.proceedsMicro,
          tradeSequence: input.tradeSequence,
          fills: plan.fills,
        },
      },
    ]),
    bot: delivery.bot,
    plan,
    pairsCreatedMicro: delivery.pairsCreatedMicro,
  };
}
