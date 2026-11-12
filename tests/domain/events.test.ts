import { describe, expect, it } from "vitest";
import {
  DEPOSIT_SUCCEEDED_TYPE,
  MARKET_CLOSED_TYPE,
  MARKET_OPENED_TYPE,
  MARKET_RESOLVED_TYPE,
  WITHDRAWAL_FAILED_TYPE,
  readMarketEvent,
  readPaymentEvent,
} from "../../src/domain/consumed.js";
import { eventType, marketFundedEvent, marketSettledEvent, natsSubject, tradeExecutedEvent, withdrawalRefundedEvent, yesPriceOf } from "../../src/domain/events.js";
import { CREATOR, MARKET_1, TENANT_A, TENANT_B, TRADER } from "../support/fakes.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const ctx = { eventId: "00000000-0000-7000-8000-000000000001", tenantId: TENANT_A, now: NOW, correlationId: "corr-1", causationId: "req-1" };
const EVENT_ID = "018f3c1e-7a00-7000-8000-00000000e001";
const WITHDRAWAL = "018f3c1e-7a00-7000-8000-00000000a001";

function cloudEvent(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { specversion: "1.0", id: EVENT_ID, source: "/chance/x", type, subject: "x", time: NOW.toISOString(), tenantid: TENANT_A.toUpperCase(), correlationid: "corr-9", data, ...extra };
}

describe("TradeExecuted prices", () => {
  const base = { tradeId: "t-2", marketId: MARKET_1, userId: TRADER, sharesMicro: 10, costMicro: 3, averagePriceMicro: 300_000, tradeSequence: 1, executedAt: NOW.toISOString(), kind: "buy" as const };

  it("describes a sale (UC-08) as the buy of the other side with kind sale: the YES price moves as for that buy", () => {
    // Selling YES buys NO: a NO level at 300000 is a YES price of 700000, exactly as a NO buy at that level.
    const sale = tradeExecutedEvent({ ...base, side: "NO", lastPriceMicro: 300_000, kind: "sale" }, ctx).data;
    expect(sale).toMatchObject({ side: "NO", kind: "sale", yesPriceMicro: 700_000 });
  });

  it("carries the last price as the YES price for market-data: equal for YES, the complement for NO", () => {
    expect(tradeExecutedEvent({ ...base, side: "YES", lastPriceMicro: 300_000 }, ctx).data.yesPriceMicro).toBe(300_000);
    expect(tradeExecutedEvent({ ...base, side: "NO", lastPriceMicro: 300_000 }, ctx).data.yesPriceMicro).toBe(700_000);
    expect(yesPriceOf("NO", 990_000)).toBe(10_000);
    expect(yesPriceOf("YES", 10_000)).toBe(10_000);
  });
});

describe("published events", () => {
  it("are CloudEvents on chance.trading.<Event>.<tenantId> with the market or withdrawal as subject", () => {
    const trade = tradeExecutedEvent(
      {
        tradeId: "t-1",
        marketId: MARKET_1,
        userId: TRADER,
        side: "YES",
        sharesMicro: 10,
        costMicro: 6,
        averagePriceMicro: 600_000,
        lastPriceMicro: 600_000,
        kind: "buy",
        tradeSequence: 4,
        executedAt: NOW.toISOString(),
      },
      ctx,
    );
    expect(trade).toMatchObject({
      specversion: "1.0",
      id: ctx.eventId,
      source: "/chance/trading",
      type: "si.chance.trading.TradeExecuted.v1",
      subject: `market/${MARKET_1}`,
      time: NOW.toISOString(),
      datacontenttype: "application/json",
      tenantid: TENANT_A,
      correlationid: "corr-1",
      causationid: "req-1",
    });
    expect(natsSubject("TradeExecuted", TENANT_A)).toBe(`chance.trading.TradeExecuted.${TENANT_A}`);
    expect(marketFundedEvent({ marketId: MARKET_1, creatorId: CREATOR, amount: 30, fundedAt: NOW.toISOString() }, ctx).type).toBe(eventType("MarketFunded"));
    expect(
      marketSettledEvent(
        { marketId: MARKET_1, outcome: "NO", creatorId: CREATOR, payoutTotalMicro: 1, payoutCount: 1, returnedToCreatorMicro: 2, settledAt: NOW.toISOString() },
        ctx,
      ).subject,
    ).toBe(`market/${MARKET_1}`);
    const refunded = withdrawalRefundedEvent({ withdrawalId: WITHDRAWAL, userId: TRADER, amount: 25, refundedAt: NOW.toISOString() }, ctx);
    expect(refunded.subject).toBe(`withdrawal/${WITHDRAWAL}`);
    expect(refunded.data).toEqual({ withdrawalId: WITHDRAWAL, userId: TRADER, amount: 25, refundedAt: NOW.toISOString() });
  });
});

describe("readMarketEvent", () => {
  const openedData = {
    marketId: MARKET_1.toUpperCase(),
    question: "Will it snow in Ljubljana?",
    closeTime: "2026-12-01T12:00:00Z",
    startingPrice: 0.55,
    fundingAmount: 30,
    creatorId: CREATOR,
    version: 3,
    openedAt: "2026-11-01T10:00:00.000Z",
    somethingNew: "ignored",
  };

  it("reads MarketOpened, MarketClosed and MarketResolved with the tenant from tenantid", () => {
    const opened = readMarketEvent(cloudEvent(MARKET_OPENED_TYPE, openedData));
    expect(opened).toMatchObject({
      kind: "market_opened",
      eventId: EVENT_ID,
      tenantId: TENANT_A,
      correlationId: "corr-9",
      fundingAmount: 30,
      facts: { marketId: MARKET_1, version: 3, startingPriceMicro: 550_000, creatorId: CREATOR, closeTime: new Date("2026-12-01T12:00:00Z") },
    });
    const closed = readMarketEvent(cloudEvent(MARKET_CLOSED_TYPE, { marketId: MARKET_1, version: 4, closedAt: NOW.toISOString(), closedBy: CREATOR }));
    expect(closed).toMatchObject({ kind: "market_closed", closedBy: CREATOR, facts: { version: 4, closedAt: NOW } });
    const resolved = readMarketEvent(
      cloudEvent(MARKET_RESOLVED_TYPE, { marketId: MARKET_1, outcome: "NO", version: 5, resolvedAt: NOW.toISOString(), resolvedBy: CREATOR, creatorId: CREATOR }, { correlationid: "" }),
    );
    expect(resolved).toMatchObject({ kind: "market_resolved", correlationId: null, facts: { outcome: "NO", version: 5, creatorId: CREATOR } });
  });

  it("ignores what it cannot trust, keeping the event id when there is one", () => {
    expect(readMarketEvent("text")).toEqual({ kind: "ignored", reason: "The message is not a JSON object", eventId: null });
    expect(readMarketEvent(cloudEvent("si.chance.markets.MarketDrafted.v1", {}))).toMatchObject({ kind: "ignored", eventId: EVENT_ID });
    expect(readMarketEvent(cloudEvent(MARKET_OPENED_TYPE, openedData, { specversion: "0.3" }))).toMatchObject({ kind: "ignored" });
    expect(readMarketEvent(cloudEvent(MARKET_OPENED_TYPE, openedData, { id: "x" }))).toMatchObject({ kind: "ignored", eventId: null });
    expect(readMarketEvent(cloudEvent(MARKET_OPENED_TYPE, openedData, { tenantid: "acme" }))).toMatchObject({ kind: "ignored" });
    expect(readMarketEvent(cloudEvent(MARKET_OPENED_TYPE, openedData, { data: "x" }))).toMatchObject({ kind: "ignored" });
    for (const broken of [
      { ...openedData, startingPrice: 0.555 },
      { ...openedData, startingPrice: "0.55" },
      { ...openedData, version: 0 },
      { ...openedData, closeTime: "tomorrow" },
      { ...openedData, marketId: "m-1" },
      { ...openedData, creatorId: "" },
      { ...openedData, question: "" },
      { ...openedData, tenantId: TENANT_B },
    ]) {
      expect(readMarketEvent(cloudEvent(MARKET_OPENED_TYPE, broken))).toMatchObject({ kind: "ignored", eventId: EVENT_ID });
    }
    expect(readMarketEvent(cloudEvent(MARKET_RESOLVED_TYPE, { marketId: MARKET_1, outcome: "MAYBE", version: 5, resolvedAt: NOW.toISOString(), resolvedBy: CREATOR, creatorId: CREATOR }))).toMatchObject({
      kind: "ignored",
      reason: "data.outcome must be YES, NO or INVALID",
    });
    // UC-16: INVALID is the third outcome; lower case is not.
    expect(readMarketEvent(cloudEvent(MARKET_RESOLVED_TYPE, { marketId: MARKET_1, outcome: "INVALID", version: 5, resolvedAt: NOW.toISOString(), resolvedBy: CREATOR, creatorId: CREATOR }))).toMatchObject({
      kind: "market_resolved",
      facts: { outcome: "INVALID", version: 5 },
    });
    expect(readMarketEvent(cloudEvent(MARKET_RESOLVED_TYPE, { marketId: MARKET_1, outcome: "invalid", version: 5, resolvedAt: NOW.toISOString(), resolvedBy: CREATOR, creatorId: CREATOR }))).toMatchObject({
      kind: "ignored",
    });
  });
});

describe("readPaymentEvent", () => {
  it("reads DepositSucceeded and WithdrawalFailed in whole credits", () => {
    const deposit = readPaymentEvent(
      cloudEvent(DEPOSIT_SUCCEEDED_TYPE, { depositId: WITHDRAWAL.toUpperCase(), tenantId: TENANT_A, userId: TRADER, amount: 500, succeededAt: NOW.toISOString() }),
    );
    expect(deposit).toMatchObject({ kind: "deposit_succeeded", depositId: WITHDRAWAL, userId: TRADER, amount: 500, tenantId: TENANT_A });
    const failed = readPaymentEvent(
      cloudEvent(WITHDRAWAL_FAILED_TYPE, { withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: TRADER, amount: 25, reason: "forced", failedAt: NOW.toISOString() }),
    );
    expect(failed).toMatchObject({ kind: "withdrawal_failed", withdrawalId: WITHDRAWAL, amount: 25, reason: "forced" });
  });

  it("ignores other payment events and malformed amounts or tenants", () => {
    expect(readPaymentEvent(cloudEvent("si.chance.payments.DepositFailed.v1", {}))).toMatchObject({ kind: "ignored" });
    const base = { depositId: WITHDRAWAL, userId: TRADER, amount: 5 };
    for (const broken of [{ ...base, amount: 0 }, { ...base, amount: 1_000_001 }, { ...base, amount: 2.5 }, { ...base, depositId: "d-1" }, { ...base, tenantId: TENANT_B }]) {
      expect(readPaymentEvent(cloudEvent(DEPOSIT_SUCCEEDED_TYPE, broken))).toMatchObject({ kind: "ignored" });
    }
  });
});
