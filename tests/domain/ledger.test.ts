import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  LEDGER_EVENT_TYPES,
  botStreamId,
  businessKeyOf,
  emptyBotAccount,
  emptyUserAccount,
  evolve,
  evolveAll,
  holdingOf,
  initialStateOf,
  nonEmptyPositions,
  parseMarketId,
  parseStreamId,
  parseUserId,
  replayStream,
  userStreamId,
} from "../../src/domain/ledger.js";
import type { LedgerEvent } from "../../src/domain/ledger.js";
import { CREATOR, MARKET_1, MARKET_2, TRADER } from "../support/fakes.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

describe("streams", () => {
  it("names one stream per user account and one per market's bot account", () => {
    expect(userStreamId(TRADER)).toBe("account:trader-1");
    expect(botStreamId(MARKET_1.toUpperCase())).toBe(`bot:${MARKET_1}`);
    expect(parseStreamId("account:trader-1")).toEqual({ kind: "user", userId: "trader-1" });
    expect(parseStreamId(`bot:${MARKET_1}`)).toEqual({ kind: "bot", marketId: MARKET_1 });
    expect(parseStreamId("bot:not-a-uuid")).toBeNull();
    expect(parseStreamId("other:1")).toBeNull();
    expect(initialStateOf(`bot:${MARKET_1}`)).toMatchObject({ kind: "bot", marketId: MARKET_1, version: 0, ownerId: null });
    expect(codeOf(() => initialStateOf("other:1"))).toBe("invariant_violated");
  });

  it("validates user and market ids", () => {
    expect(parseUserId("8d0c6f0e-subject")).toBe("8d0c6f0e-subject");
    for (const bad of ["", " padded", "line\nbreak", "x".repeat(256), 7]) expect(codeOf(() => parseUserId(bad))).toBe("invalid_user_id");
    expect(parseMarketId(MARKET_1.toUpperCase())).toBe(MARKET_1);
    expect(codeOf(() => parseMarketId("market-1"))).toBe("invalid_market_id");
  });

  it("gives every event type a business key; a settlement is unique per market and owner", () => {
    const stream = userStreamId(TRADER);
    expect(businessKeyOf(stream, { type: "DepositCredited", data: { depositId: "d-1", amountMicro: 1 } })).toBe("d-1");
    expect(businessKeyOf(stream, { type: "PositionSettled", data: { marketId: MARKET_1, outcome: "YES", yesMicro: 0, noMicro: 0, payoutMicro: 0 } })).toBe(
      `${MARKET_1}/${stream}`,
    );
    expect(businessKeyOf(botStreamId(MARKET_1), { type: "BotFunded", data: { marketId: MARKET_1, creatorId: CREATOR, amountMicro: 1 } })).toBe(MARKET_1);
    // One redemption may touch the user's and the bot's stream: the keys must differ or UNIQUE (type, business_key) fires.
    const redeemed: LedgerEvent = { type: "PairsRedeemed", data: { redemptionId: "r-1", marketId: MARKET_1, pairsMicro: 1 } };
    expect(businessKeyOf(stream, redeemed)).toBe(`r-1/${stream}`);
    expect(businessKeyOf(botStreamId(MARKET_1), redeemed)).toBe(`r-1/${botStreamId(MARKET_1)}`);
    expect(LEDGER_EVENT_TYPES).toContain("PairsRedeemed");
    expect(new Set(LEDGER_EVENT_TYPES).size).toBe(LEDGER_EVENT_TYPES.length);
  });
});

describe("evolve", () => {
  const trader = emptyUserAccount(TRADER);

  it("folds a user's stream: balance, positions and version", () => {
    const events: LedgerEvent[] = [
      { type: "DepositCredited", data: { depositId: "d-1", amountMicro: 100_000_000 } },
      {
        type: "SharesBought",
        data: { tradeId: "t-1", marketId: MARKET_1, side: "YES", sharesMicro: 20_000_000, costMicro: 10_000_000, tradeSequence: 1, fills: [] },
      },
      {
        type: "SharesBought",
        data: { tradeId: "t-2", marketId: MARKET_2, side: "NO", sharesMicro: 5_000_000, costMicro: 2_000_000, tradeSequence: 1, fills: [] },
      },
      { type: "WithdrawalDebited", data: { withdrawalId: "w-1", amountMicro: 8_000_000 } },
      { type: "PositionSettled", data: { marketId: MARKET_1, outcome: "YES", yesMicro: 20_000_000, noMicro: 0, payoutMicro: 20_000_000 } },
      { type: "HoldingsReturned", data: { marketId: MARKET_2, amountMicro: 1 } },
    ];
    const state = evolveAll(trader, events);
    expect(state.version).toBe(6);
    expect(state.balanceMicro).toBe(100_000_000 - 10_000_000 - 2_000_000 - 8_000_000 + 20_000_000 + 1);
    expect(nonEmptyPositions(state)).toEqual({ [MARKET_2]: { yesMicro: 0, noMicro: 5_000_000 } });
    expect(holdingOf(state, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 0 });
    expect(replayStream(trader.streamId, events)).toEqual(state);
  });

  it("folds a bot account: funding pairs, a sale with pairs created from credits, settlement and return", () => {
    const bot = emptyBotAccount(MARKET_1);
    const funded = evolve(bot, { type: "BotFunded", data: { marketId: MARKET_1, creatorId: CREATOR, amountMicro: 10_000_000 } });
    expect(funded.ownerId).toBe(CREATOR);
    // Sells 12 YES although it holds 10: receives 6 credits, turns 2 of them into pairs.
    const sold = evolve(funded, {
      type: "BotSharesSold",
      data: { tradeId: "t-1", side: "YES", sharesMicro: 12_000_000, costMicro: 6_000_000, pairsCreatedMicro: 2_000_000, tradeSequence: 1 },
    });
    expect(sold.balanceMicro).toBe(4_000_000);
    expect(holdingOf(sold, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 12_000_000 });
    const settled = evolve(sold, { type: "BotSettled", data: { marketId: MARKET_1, outcome: "NO", yesMicro: 0, noMicro: 12_000_000, payoutMicro: 12_000_000 } });
    expect(settled.balanceMicro).toBe(16_000_000);
    const returned = evolve(settled, { type: "BotHoldingsReturned", data: { marketId: MARKET_1, creatorId: CREATOR, amountMicro: 16_000_000 } });
    expect(returned.balanceMicro).toBe(0);
    expect(nonEmptyPositions(returned)).toEqual({});
    expect(returned.version).toBe(4);
  });

  it("is ready for redeeming pairs (selling, UC-08)", () => {
    const holder = { ...trader, positions: { [MARKET_1]: { yesMicro: 3, noMicro: 5 } }, version: 2 };
    const next = evolve(holder, { type: "PairsRedeemed", data: { redemptionId: "r-1", marketId: MARKET_1, pairsMicro: 3 } });
    expect(next.balanceMicro).toBe(3);
    expect(holdingOf(next, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 2 });
  });

  it("never lets a balance or a holding go below zero", () => {
    expect(codeOf(() => evolve(trader, { type: "WithdrawalDebited", data: { withdrawalId: "w", amountMicro: 1 } }))).toBe("invariant_violated");
    const funded = evolve(emptyBotAccount(MARKET_1), { type: "BotFunded", data: { marketId: MARKET_1, creatorId: CREATOR, amountMicro: 10 } });
    expect(
      codeOf(() =>
        evolve(funded, { type: "BotSharesSold", data: { tradeId: "t", side: "YES", sharesMicro: 11, costMicro: 0, pairsCreatedMicro: 0, tradeSequence: 1 } }),
      ),
    ).toBe("invariant_violated");
    expect(codeOf(() => evolve(funded, { type: "PairsRedeemed", data: { redemptionId: "r", marketId: MARKET_1, pairsMicro: 11 } }))).toBe("invariant_violated");
  });

  it("refuses events of the wrong stream kind, market or settlement amounts", () => {
    expect(codeOf(() => evolve(trader, { type: "BotFunded", data: { marketId: MARKET_1, creatorId: CREATOR, amountMicro: 1 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(emptyBotAccount(MARKET_1), { type: "DepositCredited", data: { depositId: "d", amountMicro: 1 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(emptyBotAccount(MARKET_1), { type: "BotFunded", data: { marketId: MARKET_2, creatorId: CREATOR, amountMicro: 1 } }))).toBe(
      "invariant_violated",
    );
    const holder = { ...trader, positions: { [MARKET_1]: { yesMicro: 3, noMicro: 0 } } };
    expect(
      codeOf(() => evolve(holder, { type: "PositionSettled", data: { marketId: MARKET_1, outcome: "YES", yesMicro: 4, noMicro: 0, payoutMicro: 4 } })),
    ).toBe("invariant_violated");
  });

  it("applies the INVALID events (UC-16): PositionRefunded voids the position and credits the refund, BotVoided releases and pays", () => {
    const holder = { ...trader, balanceMicro: 5, positions: { [MARKET_1]: { yesMicro: 3, noMicro: 1 } } };
    const refunded = evolve(holder, { type: "PositionRefunded", data: { marketId: MARKET_1, yesMicro: 3, noMicro: 1, paidMicro: 9, returnedMicro: 2, refundMicro: 7 } });
    expect(refunded).toMatchObject({ balanceMicro: 12, version: holder.version + 1 });
    expect(holdingOf(refunded, MARKET_1)).toEqual({ yesMicro: 0, noMicro: 0 });
    expect(businessKeyOf(userStreamId(TRADER), { type: "PositionRefunded", data: { marketId: MARKET_1, yesMicro: 0, noMicro: 0, paidMicro: 0, returnedMicro: 0, refundMicro: 0 } })).toBe(
      `${MARKET_1}/${userStreamId(TRADER)}`,
    );

    const bot = { ...emptyBotAccount(MARKET_1, CREATOR), balanceMicro: 4, positions: { [MARKET_1]: { yesMicro: 6, noMicro: 2 } } };
    const voided = evolve(bot, { type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 6, noMicro: 2, releasedMicro: 10, refundedMicro: 7 } });
    expect(voided).toMatchObject({ balanceMicro: 7, version: bot.version + 1 });
    expect(nonEmptyPositions(voided)).toEqual({});
    expect(businessKeyOf(botStreamId(MARKET_1), { type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 0, noMicro: 0, releasedMicro: 0, refundedMicro: 0 } })).toBe(MARKET_1);
    expect(LEDGER_EVENT_TYPES).toEqual(expect.arrayContaining(["PositionRefunded", "BotVoided"]));

    // A position or holding that does not match, a refund below zero, more refunds than the bot account holds, the wrong
    // stream kind or market: all refused.
    expect(codeOf(() => evolve(holder, { type: "PositionRefunded", data: { marketId: MARKET_1, yesMicro: 3, noMicro: 0, paidMicro: 0, returnedMicro: 0, refundMicro: 0 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(holder, { type: "PositionRefunded", data: { marketId: MARKET_1, yesMicro: 3, noMicro: 1, paidMicro: 0, returnedMicro: 0, refundMicro: -1 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(bot, { type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 6, noMicro: 1, releasedMicro: 0, refundedMicro: 0 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(bot, { type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 6, noMicro: 2, releasedMicro: 1, refundedMicro: 6 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(bot, { type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 6, noMicro: 2, releasedMicro: -1, refundedMicro: 0 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(bot, { type: "PositionRefunded", data: { marketId: MARKET_1, yesMicro: 6, noMicro: 2, paidMicro: 0, returnedMicro: 0, refundMicro: 0 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(holder, { type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 3, noMicro: 1, releasedMicro: 0, refundedMicro: 0 } }))).toBe("invariant_violated");
    expect(codeOf(() => evolve(bot, { type: "BotVoided", data: { marketId: MARKET_2, yesMicro: 0, noMicro: 0, releasedMicro: 0, refundedMicro: 0 } }))).toBe("invariant_violated");
  });
});
