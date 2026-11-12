import { DomainError } from "./errors.js";

// Units and money arithmetic (Proposed ADR "exact integer micro-units in trading").
//
// At the boundaries a credit is payments' whole-number `amount` (1 credit = 1 EUR cent): deposits, withdrawals, the
// funding of a market and the amount of a buy order. Inside trading every quantity is an exact integer in micro-units:
//   1 credit = 1 000 000 microcredits, 1 share = 1 000 000 microshares, and a winning share pays 1 credit,
// so one pair (1 YES + 1 NO microshare) is worth exactly 1 microcredit and pairs, payouts and funding need no rounding.
// Prices are microcredits per share, from 10 000 (0.01) to 990 000 (0.99) in steps of 10 000. JSON carries all of them
// as safe integers. No floating point touches money: products and quotients go through BigInt below.
//
// The rounding rule (written down once, used everywhere): a conversion that cannot be exact rounds in favour of the
// market's bot account, never in favour of the person making the request, and by less than one microunit per fill:
//   - shares bought at a price cost ceil(shares x price / 10^6) microcredits;
//   - a budget spent at a price buys floor(budget x 10^6 / price) microshares;
//   - the average price shown is ceil(cost x 10^6 / shares);
//   - a withdrawal debits whole credits only (balance and the withdrawable part are separate numbers).
// The bot account's holdings return to the market's creator at resolution, so no fraction is ever lost or created.

export const MICROS_PER_UNIT = 1_000_000;
const MICROS = 1_000_000n;

export const PRICE_STEP_MICRO = 10_000;
export const MIN_PRICE_MICRO = 10_000;
export const MAX_PRICE_MICRO = 990_000;

/** payments' bound of one `amount`: deposits, withdrawals, funding and orders never carry more credits. */
export const CREDIT_AMOUNT_MAX = 1_000_000;

export const SIDES = ["YES", "NO"] as const;
export type Side = (typeof SIDES)[number];

export function isSide(value: unknown): value is Side {
  return value === "YES" || value === "NO";
}

/**
 * The outcome of a resolved market (markets' MarketResolved): a side, or INVALID (UC-16), which pays no winners but
 * refunds the traders' net stakes and returns the rest to the creator (settlement.ts, decideRefundSettlement).
 */
export const OUTCOMES = ["YES", "NO", "INVALID"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return isSide(value) || value === "INVALID";
}

export function parseSide(value: unknown, field = "side"): Side {
  if (!isSide(value)) throw new DomainError("invalid_side", `${field} must be YES or NO`, field);
  return value;
}

export function otherSide(side: Side): Side {
  return side === "YES" ? "NO" : "YES";
}

/** A safe, non-negative integer: what every micro quantity in a balance, holding or event is. */
export function isMicroQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A whole-credit amount as payments carries it: an integer from 1 to `max`. */
export function isCreditAmount(value: unknown, max = CREDIT_AMOUNT_MAX): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

export function parseCreditAmount(value: unknown, field = "amount", max = CREDIT_AMOUNT_MAX): number {
  if (!isCreditAmount(value, max)) throw new DomainError("invalid_amount", `${field} must be a whole number of credits from 1 to ${max}`, field);
  return value;
}

/** Whole credits to microcredits (exact). */
export function creditsToMicro(credits: number): number {
  if (!Number.isSafeInteger(credits) || credits < 0) throw new DomainError("amount_out_of_range", "Credits must be a non-negative integer");
  return checked(BigInt(credits) * MICROS);
}

/** The whole credits inside a microcredit amount, rounded down: what a withdrawal may take. */
export function wholeCredits(microcredits: number): number {
  assertMicro(microcredits, "microcredits");
  return Number(BigInt(microcredits) / MICROS);
}

/** A price on the grid: an integer from MIN_PRICE_MICRO to MAX_PRICE_MICRO in steps of PRICE_STEP_MICRO. */
export function isPriceMicro(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PRICE_MICRO &&
    value <= MAX_PRICE_MICRO &&
    value % PRICE_STEP_MICRO === 0
  );
}

export function parsePriceMicro(value: unknown, field = "priceMicro"): number {
  if (!isPriceMicro(value)) {
    throw new DomainError("invalid_price", `${field} must be an integer from ${MIN_PRICE_MICRO} to ${MAX_PRICE_MICRO} in steps of ${PRICE_STEP_MICRO} (0.01 to 0.99 credits per share)`, field);
  }
  return value;
}

/**
 * markets' starting price (a JSON number with two decimals, 0.01 .. 0.99) as a price on the grid. Two decimals times
 * 100 rounds to the exact integer, so the conversion is exact for every value markets accepts.
 */
export function decimalPriceToMicro(price: number, field = "startingPrice"): number {
  if (typeof price !== "number" || !Number.isFinite(price)) throw new DomainError("invalid_price", `${field} must be a number`, field);
  const cents = Math.round(price * 100);
  if (Math.abs(price * 100 - cents) > 1e-6) throw new DomainError("invalid_price", `${field} must have at most two decimals`, field);
  return parsePriceMicro(cents * PRICE_STEP_MICRO, field);
}

/** a + b, exact; throws when the result leaves the safe integer range. */
export function addMicro(a: number, b: number): number {
  return checked(BigInt(a) + BigInt(b));
}

/** a - b, exact; may be negative (callers decide whether that is allowed). */
export function subMicro(a: number, b: number): number {
  return checked(BigInt(a) - BigInt(b));
}

/** floor(a x b / d) for non-negative safe integers, exact. */
export function mulDivFloor(a: number, b: number, d: number): number {
  assertMicro(a, "a");
  assertMicro(b, "b");
  if (!Number.isSafeInteger(d) || d <= 0) throw new DomainError("amount_out_of_range", "The divisor must be a positive integer");
  return checked((BigInt(a) * BigInt(b)) / BigInt(d));
}

/** ceil(a x b / d) for non-negative safe integers, exact. */
export function mulDivCeil(a: number, b: number, d: number): number {
  assertMicro(a, "a");
  assertMicro(b, "b");
  if (!Number.isSafeInteger(d) || d <= 0) throw new DomainError("amount_out_of_range", "The divisor must be a positive integer");
  const divisor = BigInt(d);
  return checked((BigInt(a) * BigInt(b) + divisor - 1n) / divisor);
}

/** What `sharesMicro` cost at `priceMicro`: rounded up (the bot account's favour). */
export function costOfShares(sharesMicro: number, priceMicro: number): number {
  return mulDivCeil(sharesMicro, priceMicro, MICROS_PER_UNIT);
}

/** The microshares a budget buys at `priceMicro`: rounded down (the bot account's favour). */
export function sharesForBudget(budgetMicro: number, priceMicro: number): number {
  return mulDivFloor(budgetMicro, MICROS_PER_UNIT, priceMicro);
}

/** Microcredits per share paid on average, rounded up; null when no shares were bought. */
export function averagePriceMicro(costMicro: number, sharesMicro: number): number | null {
  if (sharesMicro === 0) return null;
  return mulDivCeil(costMicro, MICROS_PER_UNIT, sharesMicro);
}

/** Whether cost / shares <= limit per share, compared exactly (cost x 10^6 <= limit x shares). */
export function averageWithin(costMicro: number, sharesMicro: number, limitPriceMicro: number): boolean {
  return BigInt(costMicro) * MICROS <= BigInt(limitPriceMicro) * BigInt(sharesMicro);
}

function checked(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError("amount_out_of_range", "A quantity left the range of exact integers");
  }
  return Number(value);
}

function assertMicro(value: number, name: string): void {
  if (!isMicroQuantity(value)) throw new DomainError("amount_out_of_range", `${name} must be a non-negative safe integer`);
}
