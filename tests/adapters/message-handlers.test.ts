import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import {
  describeError,
  handleMarketMessage,
  handlePaymentMessage,
  handleTenantCreatedMessage,
  payloadText,
  settleMessage,
} from "../../src/adapters/nats/message-handlers.js";
import type { SettleableMessage, SettleOptions } from "../../src/adapters/nats/message-handlers.js";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, DEPOSIT_SUCCEEDED_TYPE, WITHDRAWAL_FAILED_TYPE } from "../../src/domain/consumed.js";
import type { MarketEventNotice, PaymentEventNotice } from "../../src/domain/consumed.js";
import { TENANT_CREATED_TYPE } from "../../src/domain/tenant.js";
import type { ParkedEvent } from "../../src/usecases/ports.js";
import { ConcurrentUpdate } from "../../src/usecases/errors.js";
import { PARK_AFTER_DELIVERIES } from "../../src/usecases/support.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import type { MarketEventResult, PaymentEventResult, RecordMarketEventUseCase, RecordPaymentEventUseCase } from "../../src/usecases/use-cases.js";
import { MARKET_1, RecordingLogger, TENANT_A, TestClock } from "../support/fakes.js";

const EVENT = "018f3c1e-7a00-7000-8000-000000000e01";
const DEPOSIT = "018f3c1e-7a00-7000-8000-000000000d01";
const WITHDRAWAL = "018f3c1e-7a00-7000-8000-000000000f01";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

/** A CloudEvent envelope as the other services publish it. */
function envelope(type: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specversion: "1.0",
    id: EVENT,
    source: "/chance/test",
    type,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    causationid: "req-1",
    data,
    ...overrides,
  };
}

const opened = (): Record<string, unknown> =>
  envelope(MARKET_OPENED_TYPE, {
    marketId: MARKET_1,
    version: 2,
    question: "Will the new bridge open before 2027?",
    closeTime: "2026-12-01T10:00:00.000Z",
    startingPrice: 0.4,
    fundingAmount: 500,
    creatorId: "admin-1",
    openedAt: "2026-11-01T10:00:00.000Z",
  });
const closed = (): Record<string, unknown> =>
  envelope(MARKET_CLOSED_TYPE, { marketId: MARKET_1, version: 3, closedAt: "2026-12-01T10:00:00.000Z", closedBy: "admin-1" });
const resolved = (): Record<string, unknown> =>
  envelope(MARKET_RESOLVED_TYPE, { marketId: MARKET_1, version: 4, outcome: "YES", resolvedAt: "2026-12-02T10:00:00.000Z", creatorId: "admin-1", resolvedBy: "admin-1" });
const depositSucceeded = (): Record<string, unknown> => envelope(DEPOSIT_SUCCEEDED_TYPE, { depositId: DEPOSIT, userId: "trader-1", amount: 700 });
const withdrawalFailed = (): Record<string, unknown> =>
  envelope(WITHDRAWAL_FAILED_TYPE, { withdrawalId: WITHDRAWAL, userId: "trader-1", amount: 300, reason: "provider_error" });

class RecordingMarketUseCase implements RecordMarketEventUseCase {
  readonly notices: MarketEventNotice[] = [];
  result: MarketEventResult = "applied";
  failure: Error | null = null;
  execute(notice: MarketEventNotice): Promise<MarketEventResult> {
    this.notices.push(notice);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.result);
  }
}

class RecordingPaymentUseCase implements RecordPaymentEventUseCase {
  readonly notices: PaymentEventNotice[] = [];
  result: PaymentEventResult = "credited";
  failure: Error | null = null;
  execute(notice: PaymentEventNotice): Promise<PaymentEventResult> {
    this.notices.push(notice);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.result);
  }
}

describe("describeError", () => {
  it("names the code and the message of a use-case or database error", () => {
    expect(describeError(new ConcurrentUpdate())).toMatch(/^concurrent_update: /);
    expect(describeError(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED: connection refused");
  });

  it("falls back to the error name, a plain value and a limit on the length", () => {
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(new Error("x".repeat(2000)))).toHaveLength(500);
  });
});

describe("payloadText", () => {
  it("decodes UTF-8 and replaces the NUL character, which a text column cannot hold", () => {
    expect(payloadText(encode("{\"a\":\"č\"}"))).toBe("{\"a\":\"č\"}");
    expect(payloadText(new Uint8Array([97, 0, 98]))).toBe("a�b");
  });
});

describe("handleTenantCreatedMessage", () => {
  const tenantCreated = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    envelope(TENANT_CREATED_TYPE, { tenantId: TENANT_A, slug: "acme" }, { subject: `tenant/${TENANT_A}`, ...overrides });

  it("provisions the tenant through the use case and acknowledges", async () => {
    const store = new MemoryStore();
    const logger = new RecordingLogger();
    const provision = new ProvisionTenant({ store, clock: new TestClock(), logger });

    expect(await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger)).toEqual({ kind: "ack" });

    expect(store.snapshot().tenants).toEqual([TENANT_A]);
    expect(logger.lines.some((line) => line.level === "info" && (line.fields as { result?: string }).result === "provisioned")).toBe(true);
  });

  it("acknowledges what is not JSON or not a usable event with a warning, and calls nothing", async () => {
    const logger = new RecordingLogger();
    const provision = { execute: () => Promise.reject(new Error("must not be called")) };

    expect(await handleTenantCreatedMessage(encode("{not json"), provision, logger)).toEqual({ kind: "ack" });
    expect(await handleTenantCreatedMessage(encode(tenantCreated({ tenantid: "nope" })), provision, logger)).toEqual({ kind: "ack" });

    expect(logger.lines.filter((line) => line.level === "warn")).toHaveLength(2);
  });

  it("naks with the error code and message when the use case fails, and logs an error", async () => {
    const logger = new RecordingLogger();
    const provision = { execute: () => Promise.reject(Object.assign(new Error("database is down"), { code: "57P01" })) };

    const result = await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger);

    expect(result).toEqual({ kind: "nak", reason: "57P01: database is down" });
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(1);
  });
});

describe("handleMarketMessage", () => {
  it.each([
    ["MarketOpened", opened(), "market_opened"],
    ["MarketClosed", closed(), "market_closed"],
    ["MarketResolved", resolved(), "market_resolved"],
  ])("hands %s to the use case as a notice and acknowledges", async (_name, body, kind) => {
    const record = new RecordingMarketUseCase();
    const logger = new RecordingLogger();

    expect(await handleMarketMessage(encode(body), record, logger)).toEqual({ kind: "ack" });

    expect(record.notices).toHaveLength(1);
    expect(record.notices[0]).toMatchObject({ kind, tenantId: TENANT_A, eventId: EVENT, correlationId: "corr-1", facts: { marketId: MARKET_1 } });
    expect(logger.lines.find((line) => line.message === "A market event was handled")?.fields).toMatchObject({ marketId: MARKET_1, result: "applied" });
  });

  it("acknowledges the result of a duplicate or a settlement alike", async () => {
    const record = new RecordingMarketUseCase();
    const logger = new RecordingLogger();
    for (const result of ["duplicate", "settled", "stale", "filled"] as const) {
      record.result = result;
      expect(await handleMarketMessage(encode(resolved()), record, logger)).toEqual({ kind: "ack" });
    }
    expect(record.notices).toHaveLength(4);
  });

  it("acknowledges another type of the wide MARKETS filter at info level, without calling the use case", async () => {
    const record = new RecordingMarketUseCase();
    const logger = new RecordingLogger();

    const result = await handleMarketMessage(encode(envelope("si.chance.markets.MarketCreated.v1", { marketId: MARKET_1 })), record, logger);

    expect(result).toEqual({ kind: "ack" });
    expect(record.notices).toEqual([]);
    expect(logger.lines.map((line) => line.level)).toEqual(["info"]);
  });

  it("acknowledges a body that is not JSON, and a malformed event, with a warning", async () => {
    const record = new RecordingMarketUseCase();
    const logger = new RecordingLogger();
    const noQuestion = envelope(MARKET_OPENED_TYPE, { marketId: MARKET_1, version: 2 });

    expect(await handleMarketMessage(encode("<xml/>"), record, logger)).toEqual({ kind: "ack" });
    expect(await handleMarketMessage(encode(noQuestion), record, logger)).toEqual({ kind: "ack" });
    expect(await handleMarketMessage(encode(JSON.stringify([1, 2])), record, logger)).toEqual({ kind: "ack" });

    expect(record.notices).toEqual([]);
    expect(logger.lines.map((line) => line.level)).toEqual(["warn", "warn", "warn"]);
  });

  it("naks with the reason when the use case fails, never acknowledging before the commit", async () => {
    const record = new RecordingMarketUseCase();
    record.failure = new ConcurrentUpdate();
    const logger = new RecordingLogger();

    const result = await handleMarketMessage(encode(closed()), record, logger);

    expect(result.kind).toBe("nak");
    expect(result).toMatchObject({ reason: expect.stringMatching(/^concurrent_update: /) as string });
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(1);
  });
});

describe("handlePaymentMessage", () => {
  it.each([
    ["DepositSucceeded", depositSucceeded(), "deposit_succeeded"],
    ["WithdrawalFailed", withdrawalFailed(), "withdrawal_failed"],
  ])("hands %s to the use case and acknowledges", async (_name, body, kind) => {
    const record = new RecordingPaymentUseCase();
    const logger = new RecordingLogger();

    expect(await handlePaymentMessage(encode(body), record, logger)).toEqual({ kind: "ack" });

    expect(record.notices[0]).toMatchObject({ kind, tenantId: TENANT_A, eventId: EVENT, userId: "trader-1" });
  });

  it("acknowledges a refund without a debit (no_debit): redelivery would change nothing", async () => {
    const record = new RecordingPaymentUseCase();
    record.result = "no_debit";

    expect(await handlePaymentMessage(encode(withdrawalFailed()), record, new RecordingLogger())).toEqual({ kind: "ack" });
  });

  it("acknowledges other payment events, bad JSON and malformed events without calling the use case", async () => {
    const record = new RecordingPaymentUseCase();
    const logger = new RecordingLogger();

    expect(await handlePaymentMessage(encode(envelope("si.chance.payments.DepositFailed.v1", { depositId: DEPOSIT })), record, logger)).toEqual({ kind: "ack" });
    expect(await handlePaymentMessage(encode("nope"), record, logger)).toEqual({ kind: "ack" });
    expect(await handlePaymentMessage(encode(envelope(DEPOSIT_SUCCEEDED_TYPE, { depositId: DEPOSIT, userId: "trader-1", amount: 0 })), record, logger)).toEqual({ kind: "ack" });

    expect(record.notices).toEqual([]);
    expect(logger.lines.map((line) => line.level)).toEqual(["info", "warn", "warn"]);
  });

  it("naks with the reason when the use case fails", async () => {
    const record = new RecordingPaymentUseCase();
    record.failure = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const logger = new RecordingLogger();

    expect(await handlePaymentMessage(encode(depositSucceeded()), record, logger)).toEqual({ kind: "nak", reason: "40P01: deadlock detected" });
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(1);
  });
});

/** A JetStream message that records what was done with it. */
class FakeMessage implements SettleableMessage {
  readonly calls: string[] = [];
  constructor(
    readonly info: { deliveryCount: number },
    readonly data: Uint8Array = encode("{\"x\":1}"),
    readonly seq = 42,
    readonly subject = "chance.markets.MarketClosed.t",
  ) {}
  ack(): void {
    this.calls.push("ack");
  }
  nak(millis?: number): void {
    this.calls.push(`nak:${String(millis)}`);
  }
}

function settleSetup(overrides: Partial<SettleOptions> = {}) {
  const parked: ParkedEvent[] = [];
  const logger = new RecordingLogger();
  const options: SettleOptions = {
    consumer: "market-events",
    parkAfter: PARK_AFTER_DELIVERIES,
    nakDelayMs: 5000,
    park: (event) => {
      parked.push(event);
      return Promise.resolve();
    },
    logger,
    now: () => new Date("2026-11-01T10:00:00.000Z"),
    ...overrides,
  };
  return { parked, logger, options };
}

describe("settleMessage", () => {
  it("acknowledges an ack result", async () => {
    const { options, parked } = settleSetup();
    const message = new FakeMessage({ deliveryCount: 1 });

    expect(await settleMessage(message, { kind: "ack" }, options)).toBe("acked");
    expect(message.calls).toEqual(["ack"]);
    expect(parked).toEqual([]);
  });

  it("asks for a new delivery after the nak delay on a failed delivery before the limit", async () => {
    const { options, parked } = settleSetup();
    const message = new FakeMessage({ deliveryCount: PARK_AFTER_DELIVERIES - 1 });

    expect(await settleMessage(message, { kind: "nak", reason: "boom" }, options)).toBe("naked");
    expect(message.calls).toEqual(["nak:5000"]);
    expect(parked).toEqual([]);
  });

  it("parks the message on the 20th failed delivery and acknowledges it", async () => {
    expect(PARK_AFTER_DELIVERIES).toBe(20);
    const { options, parked, logger } = settleSetup();
    const message = new FakeMessage({ deliveryCount: 20 }, encode("{\"a\":\"č\"}"), 77, "chance.markets.MarketResolved.t");

    expect(await settleMessage(message, { kind: "nak", reason: "concurrent_update: lost the race" }, options)).toBe("parked");

    expect(message.calls).toEqual(["ack"]);
    expect(parked).toEqual([
      {
        consumer: "market-events",
        streamSequence: 77,
        subject: "chance.markets.MarketResolved.t",
        payload: "{\"a\":\"č\"}",
        reason: "concurrent_update: lost the race",
        deliveries: 20,
        parkedAt: new Date("2026-11-01T10:00:00.000Z"),
      },
    ]);
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(1);
  });

  it("parks a later delivery too (the broker may have counted more than the consumer saw)", async () => {
    const { options, parked } = settleSetup();
    const message = new FakeMessage({ deliveryCount: 31 });

    expect(await settleMessage(message, { kind: "nak", reason: "still failing" }, options)).toBe("parked");
    expect(parked.map((event) => event.deliveries)).toEqual([31]);
  });

  it("keeps the message on the broker when parking fails too: nak, not ack", async () => {
    const { options, logger } = settleSetup({ park: () => Promise.reject(new Error("database is down")) });
    const message = new FakeMessage({ deliveryCount: 25 });

    expect(await settleMessage(message, { kind: "nak", reason: "boom" }, options)).toBe("naked");

    expect(message.calls).toEqual(["nak:5000"]);
    expect(logger.lines.some((line) => line.level === "error" && line.message === "An event could not be parked; it will be delivered again")).toBe(true);
  });

  it("uses the configured limit", async () => {
    const { options, parked } = settleSetup({ parkAfter: 3 });

    expect(await settleMessage(new FakeMessage({ deliveryCount: 2 }), { kind: "nak", reason: "x" }, options)).toBe("naked");
    expect(await settleMessage(new FakeMessage({ deliveryCount: 3 }), { kind: "nak", reason: "x" }, options)).toBe("parked");
    expect(parked).toHaveLength(1);
  });
});
