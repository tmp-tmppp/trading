import { describe, expect, it } from "vitest";
import { decideDebit, decideDeposit, decideFunding, decideGrant, decideRefund, withdrawableCredits } from "../../src/domain/accounts.js";
import { DomainError } from "../../src/domain/errors.js";
import { emptyBotAccount, emptyUserAccount, holdingOf } from "../../src/domain/ledger.js";
import {
  CREDIT_AMOUNT_MAX,
  addMicro,
  averagePriceMicro,
  averageWithin,
  costOfShares,
  creditsToMicro,
  decimalPriceToMicro,
  isPriceMicro,
  mulDivCeil,
  mulDivFloor,
  otherSide,
  parseCreditAmount,
  parsePriceMicro,
  parseSide,
  sharesForBudget,
  wholeCredits,
} from "../../src/domain/units.js";
import { CREATOR, MARKET_1, TRADER } from "../support/fakes.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

describe("units", () => {
  it("converts whole credits to microcredits and back, rounding the fraction down", () => {
    expect(creditsToMicro(5)).toBe(5_000_000);
    expect(creditsToMicro(CREDIT_AMOUNT_MAX)).toBe(1_000_000_000_000);
    expect(wholeCredits(5_999_999)).toBe(5);
    expect(wholeCredits(0)).toBe(0);
    expect(codeOf(() => creditsToMicro(-1))).toBe("amount_out_of_range");
    expect(codeOf(() => creditsToMicro(1.5))).toBe("amount_out_of_range");
  });

  it("accepts credit amounts from 1 to the bound only", () => {
    expect(parseCreditAmount(1)).toBe(1);
    expect(parseCreditAmount(1_000_000)).toBe(1_000_000);
    for (const bad of [0, -3, 1.5, 1_000_001, "10", null, Number.NaN]) expect(codeOf(() => parseCreditAmount(bad))).toBe("invalid_amount");
    expect(codeOf(() => parseCreditAmount(200, "amount", 100))).toBe("invalid_amount");
  });

  it("accepts prices on the 0.01 grid from 0.01 to 0.99 only", () => {
    expect(isPriceMicro(10_000)).toBe(true);
    expect(isPriceMicro(990_000)).toBe(true);
    expect(isPriceMicro(550_000)).toBe(true);
    for (const bad of [0, 5_000, 1_000_000, 995_000, 555_000, 550_000.5, "550000"]) expect(isPriceMicro(bad)).toBe(false);
    expect(parsePriceMicro(120_000)).toBe(120_000);
    expect(codeOf(() => parsePriceMicro(1_000_000))).toBe("invalid_price");
  });

  it("turns markets' two-decimal starting price into an exact grid price", () => {
    expect(decimalPriceToMicro(0.55)).toBe(550_000);
    expect(decimalPriceToMicro(0.01)).toBe(10_000);
    expect(decimalPriceToMicro(0.29)).toBe(290_000);
    expect(decimalPriceToMicro(0.99)).toBe(990_000);
    expect(codeOf(() => decimalPriceToMicro(0.555))).toBe("invalid_price");
    expect(codeOf(() => decimalPriceToMicro(1))).toBe("invalid_price");
    expect(codeOf(() => decimalPriceToMicro(Number.NaN))).toBe("invalid_price");
  });

  it("does exact integer arithmetic beyond 2^53 in intermediate products", () => {
    // 10^14 microshares at 0.99: the product 9.9 x 10^19 is far beyond Number.MAX_SAFE_INTEGER.
    expect(costOfShares(100_000_000_000_000, 990_000)).toBe(99_000_000_000_000);
    expect(mulDivFloor(7, 3, 2)).toBe(10);
    expect(mulDivCeil(7, 3, 2)).toBe(11);
    expect(mulDivCeil(6, 3, 2)).toBe(9);
    expect(codeOf(() => addMicro(Number.MAX_SAFE_INTEGER, 1))).toBe("amount_out_of_range");
    expect(codeOf(() => mulDivFloor(-1, 1, 1))).toBe("amount_out_of_range");
    expect(codeOf(() => mulDivCeil(1, 1, 0))).toBe("amount_out_of_range");
  });

  it("rounds every conversion in the bot account's favour by less than one microunit", () => {
    // 1 microshare at 0.33 costs 0.33 microcredits: the buyer pays 1.
    expect(costOfShares(1, 330_000)).toBe(1);
    // 1 microcredit at 0.33 buys 3.03 microshares: the buyer gets 3.
    expect(sharesForBudget(1, 330_000)).toBe(3);
    // A budget spent at one level costs exactly the budget (the rest is below one share's price).
    for (const budget of [1, 2, 3, 999_999, 1_000_000, 12_345_678]) {
      for (const price of [10_000, 330_000, 550_000, 990_000]) {
        expect(costOfShares(sharesForBudget(budget, price), price)).toBe(budget);
      }
    }
    expect(averagePriceMicro(10, 3)).toBe(3_333_334);
    expect(averagePriceMicro(0, 0)).toBeNull();
    expect(averageWithin(550_000, 1_000_000, 550_000)).toBe(true);
    expect(averageWithin(550_001, 1_000_000, 550_000)).toBe(false);
  });

  it("names sides and their opposites", () => {
    expect(parseSide("YES")).toBe("YES");
    expect(otherSide("YES")).toBe("NO");
    expect(otherSide("NO")).toBe("YES");
    expect(codeOf(() => parseSide("yes"))).toBe("invalid_side");
  });
});

describe("credit decisions", () => {
  it("credits a deposit and a grant, debits whole credits and refunds exactly the debit", () => {
    const start = emptyUserAccount(TRADER);
    const granted = decideGrant(start, { grantId: "g-1", credits: 3, reason: "seed" });
    expect(granted.expectedVersion).toBe(0);
    expect(granted.next.balanceMicro).toBe(3_000_000);
    const deposited = decideDeposit(granted.next, { depositId: "d-1", credits: 7 });
    expect(deposited.expectedVersion).toBe(1);
    expect(deposited.next.balanceMicro).toBe(10_000_000);
    expect(deposited.next.version).toBe(2);
    const debited = decideDebit(deposited.next, { withdrawalId: "w-1", credits: 4 });
    expect(debited.next.balanceMicro).toBe(6_000_000);
    const refunded = decideRefund(debited.next, { withdrawalId: "w-1", debitedMicro: 4_000_000 });
    expect(refunded.next.balanceMicro).toBe(10_000_000);
    expect(refunded.events).toEqual([{ type: "WithdrawalRefunded", data: { withdrawalId: "w-1", amountMicro: 4_000_000 } }]);
  });

  it("refuses a debit above the balance and reports the withdrawable whole credits", () => {
    const account = { ...emptyUserAccount(TRADER), balanceMicro: 2_500_000, version: 3 };
    expect(withdrawableCredits(account)).toBe(2);
    try {
      decideDebit(account, { withdrawalId: "w-2", credits: 3 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("insufficient_credits");
      expect((error as DomainError).details).toEqual({ withdrawableCredits: 2 });
    }
  });

  it("funds a market: the creator's credits become pairs in the bot account", () => {
    const creator = { ...emptyUserAccount(CREATOR), balanceMicro: 5_000_000_000, version: 1 };
    const result = decideFunding(creator, emptyBotAccount(MARKET_1), { marketId: MARKET_1, creatorId: CREATOR, credits: 1000 });
    expect(result.amountMicro).toBe(1_000_000_000);
    expect(result.creator.next.balanceMicro).toBe(4_000_000_000);
    expect(result.bot.next.ownerId).toBe(CREATOR);
    expect(holdingOf(result.bot.next, MARKET_1)).toEqual({ yesMicro: 1_000_000_000, noMicro: 1_000_000_000 });
    expect(result.bot.next.balanceMicro).toBe(0);
  });

  it("refuses a funding above the balance, a funded bot account and a bot account of another market", () => {
    const creator = { ...emptyUserAccount(CREATOR), balanceMicro: 999_999_999, version: 1 };
    expect(codeOf(() => decideFunding(creator, emptyBotAccount(MARKET_1), { marketId: MARKET_1, creatorId: CREATOR, credits: 1000 }))).toBe("insufficient_credits");
    const rich = { ...creator, balanceMicro: 5_000_000_000 };
    const funded = { ...emptyBotAccount(MARKET_1, CREATOR), version: 1 };
    expect(codeOf(() => decideFunding(rich, funded, { marketId: MARKET_1, creatorId: CREATOR, credits: 1 }))).toBe("invariant_violated");
    expect(codeOf(() => decideFunding(rich, emptyBotAccount(MARKET_1), { marketId: "018f3c1e-7a00-7000-8000-000000000999", creatorId: CREATOR, credits: 1 }))).toBe("invariant_violated");
  });

  it("never applies a user decision to a bot account", () => {
    expect(codeOf(() => decideDeposit(emptyBotAccount(MARKET_1), { depositId: "d", credits: 1 }))).toBe("invariant_violated");
  });
});
