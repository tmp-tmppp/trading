import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JetStreamConsumer, MARKETS_CONSUMER, PAYMENTS_CONSUMER, TENANTS_CONSUMER } from "../../src/adapters/nats/jetstream-consumer.js";
import type { ConsumerSpec } from "../../src/adapters/nats/jetstream-consumer.js";
import { handleMarketMessage, handlePaymentMessage, handleTenantCreatedMessage } from "../../src/adapters/nats/message-handlers.js";
import type { HandleResult } from "../../src/adapters/nats/message-handlers.js";
import { NatsEventPublisher, STREAM_NAME } from "../../src/adapters/nats/nats-event-publisher.js";
import { streamMaxAgeMs } from "../../src/adapters/retention.js";
import { DEPOSIT_SUCCEEDED_TYPE, MARKET_CLOSED_TYPE, WITHDRAWAL_FAILED_TYPE } from "../../src/domain/consumed.js";
import type { MarketEventNotice, PaymentEventNotice } from "../../src/domain/consumed.js";
import { EVENT_SOURCE, eventType, marketSubject, natsSubject } from "../../src/domain/events.js";
import type { CloudEvent } from "../../src/domain/events.js";
import { TENANT_CREATED_TYPE } from "../../src/domain/tenant.js";
import type { TenantCreatedNotice } from "../../src/domain/tenant.js";
import type { ParkedEvent } from "../../src/usecases/ports.js";
import type { MarketEventResult, PaymentEventResult, ProvisionTenantResult } from "../../src/usecases/use-cases.js";
import { MARKET_1, RecordingLogger, TENANT_A, TENANT_B } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They run against a real NATS server with
// JetStream, because the stream and consumer calls of the broker are what the adapters in src/adapters/nats consist of.

let container: StartedTestContainer;
let url: string;
let nc: NatsConnection;
let jsm: JetStreamManager;
let js: JetStreamClient;

beforeAll(async () => {
  container = await new GenericContainer("nats:2.15.2-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  url = `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`;
  nc = await connect({ servers: url });
  jsm = await jetstreamManager(nc);
  js = jetstream(nc);
}, 180_000);

afterAll(async () => {
  await nc?.drain().catch(() => undefined);
  await container?.stop();
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isStreamMissing = (error: unknown): boolean => error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

async function deleteStream(name: string): Promise<void> {
  try {
    await jsm.streams.delete(name);
  } catch (error) {
    if (!isStreamMissing(error)) throw error;
  }
}

const eventId = (n: number): string => `018f3c1e-7a00-7000-8000-${String(n).padStart(12, "0")}`;
const publish = (subject: string, body: unknown): Promise<unknown> => js.publish(subject, new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));

// Not the default of 30 days, so that the tests show that the configured value is the one that reaches the stream.
const MAX_AGE_MS = streamMaxAgeMs(45);

describe("NatsEventPublisher", () => {
  let publisher: NatsEventPublisher;
  const logger = new RecordingLogger();

  beforeEach(async () => {
    await deleteStream(STREAM_NAME);
    publisher = new NatsEventPublisher(url, logger, MAX_AGE_MS);
  });
  afterEach(async () => {
    await publisher.close();
  });

  const funded = (id: string): CloudEvent<unknown> => ({
    specversion: "1.0",
    id,
    source: EVENT_SOURCE,
    type: eventType("MarketFunded"),
    subject: marketSubject(MARKET_1),
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    causationid: "req-1",
    data: { marketId: MARKET_1, creatorId: "admin-1", amount: 500, fundedAt: "2026-11-01T10:00:00.000Z" },
  });

  it("creates the TRADING stream on the first publish: subjects chance.trading.>, file storage, the configured max age", async () => {
    await publisher.publish(natsSubject("MarketFunded", TENANT_A), funded(eventId(1)), eventId(1));

    const { config } = await jsm.streams.info(STREAM_NAME);
    expect(STREAM_NAME).toBe("TRADING");
    expect(config.subjects).toEqual(["chance.trading.>"]);
    expect(config.storage).toBe("file");
    expect(config.max_age).toBe(nanos(MAX_AGE_MS));
  });

  it("publishes the CloudEvent as JSON on the subject, with the event id as Nats-Msg-Id, and a repeat of the id stores nothing new", async () => {
    const event = funded(eventId(2));
    await publisher.publish(natsSubject("MarketFunded", TENANT_A), event, eventId(2));
    await publisher.publish(natsSubject("MarketFunded", TENANT_A), event, eventId(2));
    await publisher.publish(natsSubject("MarketFunded", TENANT_B), funded(eventId(3)), eventId(3));

    expect((await jsm.streams.info(STREAM_NAME)).state.messages).toBe(2);
    const consumer = await js.consumers.get(STREAM_NAME);
    const message = await consumer.next({ expires: 3000 });
    expect(message?.subject).toBe(`chance.trading.MarketFunded.${TENANT_A}`);
    expect(message?.headers?.get("Nats-Msg-Id")).toBe(eventId(2));
    expect(message?.json()).toEqual(event);
  });

  it("updates the stream it finds instead of failing, and reconnects after close()", async () => {
    await jsm.streams.add({ name: STREAM_NAME, subjects: ["chance.trading.>"], max_age: nanos(1000) });

    await publisher.publish(natsSubject("MarketFunded", TENANT_A), funded(eventId(4)), eventId(4));
    expect((await jsm.streams.info(STREAM_NAME)).config.max_age).toBe(nanos(MAX_AGE_MS));

    await publisher.close();
    await publisher.publish(natsSubject("MarketFunded", TENANT_A), funded(eventId(5)), eventId(5));
    expect((await jsm.streams.info(STREAM_NAME)).state.messages).toBe(2);
  });

  it("brings the existing stream to the configured max age at every start, up to the longest setting and down again", async () => {
    for (const [index, days] of [365, 7, 30].entries()) {
      const maxAgeMs = streamMaxAgeMs(days);
      const restarted = new NatsEventPublisher(url, logger, maxAgeMs);
      const id = eventId(10 + index);
      await restarted.publish(natsSubject("MarketFunded", TENANT_A), funded(id), id);

      expect((await jsm.streams.info(STREAM_NAME)).config.max_age, `${String(days)} days`).toBe(nanos(maxAgeMs));
      await restarted.close();
    }
  });

  it("rejects a publish while the broker is unreachable, so the relay keeps the row in the outbox", async () => {
    const unreachable = new NatsEventPublisher("nats://127.0.0.1:1", logger, MAX_AGE_MS);

    await expect(unreachable.publish(natsSubject("MarketFunded", TENANT_A), funded(eventId(6)), eventId(6))).rejects.toThrow();
  });
});

/** What the consumer hands to its handler; the first `failures` calls answer nak, like a use case that cannot commit. */
class RecordingHandler {
  readonly bodies: string[] = [];
  failures = 0;
  /** Only bodies that start with this text count against `failures` (the messages are not handled in a fixed order once one of them is nak'd). */
  failPrefix = "";
  readonly handle = (data: Uint8Array): Promise<HandleResult> => {
    const body = new TextDecoder().decode(data);
    this.bodies.push(body);
    if (this.failures > 0 && body.startsWith(this.failPrefix)) {
      this.failures -= 1;
      return Promise.resolve({ kind: "nak", reason: "database is down" });
    }
    return Promise.resolve({ kind: "ack" });
  };
}

describe("JetStreamConsumer", () => {
  let handler: RecordingHandler;
  let logger: RecordingLogger;
  let parked: ParkedEvent[];
  let parkFailures: number;
  let consumers: JetStreamConsumer[];

  const startConsumer = (spec: ConsumerSpec, options: Partial<ConstructorParameters<typeof JetStreamConsumer>[0]> = {}): JetStreamConsumer => {
    const consumer = new JetStreamConsumer({
      url,
      spec,
      handle: handler.handle,
      park: (event) => {
        if (parkFailures > 0) {
          parkFailures -= 1;
          return Promise.reject(new Error("database is down"));
        }
        parked.push(event);
        return Promise.resolve();
      },
      logger,
      nakDelayMs: 50,
      reconnectDelayMs: 50,
      ...options,
    });
    consumers.push(consumer);
    consumer.start();
    return consumer;
  };
  const createStream = (spec: ConsumerSpec, subjects: string[]) => jsm.streams.add({ name: spec.stream, subjects });
  const info = (spec: ConsumerSpec) => jsm.consumers.info(spec.stream, spec.durable);
  const settled = (spec: ConsumerSpec) => async (): Promise<boolean> => {
    const current = await info(spec);
    return current.num_ack_pending === 0 && current.num_pending === 0;
  };

  beforeEach(async () => {
    for (const spec of [TENANTS_CONSUMER, MARKETS_CONSUMER, PAYMENTS_CONSUMER]) await deleteStream(spec.stream);
    handler = new RecordingHandler();
    logger = new RecordingLogger();
    parked = [];
    parkFailures = 0;
    consumers = [];
  });
  afterEach(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });

  it("uses the names of the convention: three streams, one durable called trading, and the filters of the spec", () => {
    expect([TENANTS_CONSUMER, MARKETS_CONSUMER, PAYMENTS_CONSUMER].map((s) => [s.stream, s.durable, s.consumer, s.maxAckPending])).toEqual([
      ["TENANTS", "trading", "tenant-created", 10],
      ["MARKETS", "trading", "market-events", 10],
      ["PAYMENTS", "trading", "payment-events", 10],
    ]);
    expect(TENANTS_CONSUMER.filterSubjects).toEqual(["chance.tenants.TenantCreated.*"]);
    expect(MARKETS_CONSUMER.filterSubjects).toEqual(["chance.markets.>"]);
    expect(PAYMENTS_CONSUMER.filterSubjects).toEqual(["chance.payments.DepositSucceeded.*", "chance.payments.WithdrawalFailed.*"]);
  });

  it.each([
    [TENANTS_CONSUMER, "chance.tenants.>"],
    [MARKETS_CONSUMER, "chance.markets.>"],
    [PAYMENTS_CONSUMER, "chance.payments.>"],
  ])("creates the durable pull consumer on %#: explicit acks, deliver all, the filters, ack wait 30 s, max ack pending 10, unlimited deliveries", async (spec, subjects) => {
    await createStream(spec, [subjects]);

    startConsumer(spec);
    await waitFor(async () => (await jsm.consumers.info(spec.stream, spec.durable).catch(() => null)) !== null);

    const { config } = await info(spec);
    expect(config).toMatchObject({ durable_name: "trading", ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: nanos(30_000), max_ack_pending: 10, max_deliver: -1 });
    expect([...(config.filter_subjects ?? [config.filter_subject])].sort()).toEqual([...spec.filterSubjects].sort());
  });

  it("brings a consumer that exists with another configuration to the spec, also from one filter to two", async () => {
    await createStream(PAYMENTS_CONSUMER, ["chance.payments.>"]);
    await jsm.consumers.add(PAYMENTS_CONSUMER.stream, {
      durable_name: PAYMENTS_CONSUMER.durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: "chance.payments.DepositSucceeded.*",
      ack_wait: nanos(5000),
      max_ack_pending: 100,
    });

    startConsumer(PAYMENTS_CONSUMER, { ackWaitMs: 20_000 });
    await waitFor(async () => (await info(PAYMENTS_CONSUMER)).config.max_ack_pending === 10);

    const { config } = await info(PAYMENTS_CONSUMER);
    expect(config).toMatchObject({ ack_wait: nanos(20_000), max_ack_pending: 10 });
    expect([...(config.filter_subjects ?? [])].sort()).toEqual([...PAYMENTS_CONSUMER.filterSubjects].sort());
    expect(config.filter_subject).toBeUndefined();
  });

  it("delivers only the filtered subjects of the PAYMENTS stream, in order, from the first message", async () => {
    await createStream(PAYMENTS_CONSUMER, ["chance.payments.>"]);
    await publish(`chance.payments.DepositSucceeded.${TENANT_A}`, "first");
    await publish(`chance.payments.DepositFailed.${TENANT_A}`, "not ours");
    await publish(`chance.payments.WithdrawalFailed.${TENANT_A}`, "second");

    startConsumer(PAYMENTS_CONSUMER);
    await waitFor(() => handler.bodies.length === 2);
    await waitFor(settled(PAYMENTS_CONSUMER));

    expect(handler.bodies).toEqual(["first", "second"]);
    expect((await info(PAYMENTS_CONSUMER)).ack_floor.stream_seq).toBe(3);
  });

  it("asks the broker to deliver again after a nak, and acknowledges when the handler works", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    handler.failures = 2;
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "event");

    startConsumer(MARKETS_CONSUMER);
    await waitFor(() => handler.bodies.length === 3);
    await waitFor(settled(MARKETS_CONSUMER));

    expect(handler.bodies).toEqual(["event", "event", "event"]);
    expect(parked).toEqual([]);
  });

  it("parks a message after parkAfter failed deliveries, acknowledges it, and the next message still arrives", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    handler.failures = 3;
    handler.failPrefix = "{\"stuck";
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "{\"stuck\":true}");
    await publish(`chance.markets.MarketClosed.${TENANT_B}`, "next");

    startConsumer(MARKETS_CONSUMER, { parkAfter: 3 });
    await waitFor(() => parked.length === 1);
    await waitFor(() => handler.bodies.includes("next"));
    await waitFor(settled(MARKETS_CONSUMER));

    // The next message is handled while the stuck one waits for its redelivery: another market's event is not held back.
    expect(handler.bodies.filter((body) => body !== "next")).toEqual(["{\"stuck\":true}", "{\"stuck\":true}", "{\"stuck\":true}"]);
    expect(handler.bodies.indexOf("next")).toBeLessThan(handler.bodies.lastIndexOf("{\"stuck\":true}"));
    expect(parked).toEqual([
      {
        consumer: "market-events",
        streamSequence: 1,
        subject: `chance.markets.MarketClosed.${TENANT_A}`,
        payload: "{\"stuck\":true}",
        reason: "database is down",
        deliveries: 3,
        parkedAt: expect.any(Date) as Date,
      },
    ]);
    expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(2);
  });

  it("keeps a message on the broker while parking fails, and parks it when the database is back", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    handler.failures = 100;
    parkFailures = 2;
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "stuck");

    startConsumer(MARKETS_CONSUMER, { parkAfter: 2 });
    await waitFor(() => parked.length === 1);
    await waitFor(settled(MARKETS_CONSUMER));

    expect(parked[0]?.deliveries).toBeGreaterThanOrEqual(4);
    expect(logger.lines.filter((line) => line.message === "An event could not be parked; it will be delivered again")).toHaveLength(2);
  });

  it("remembers its position across a restart: acknowledged events are not handled again", async () => {
    await createStream(TENANTS_CONSUMER, ["chance.tenants.>"]);
    await publish(`chance.tenants.TenantCreated.${TENANT_A}`, "one");
    const first = startConsumer(TENANTS_CONSUMER);
    await waitFor(() => handler.bodies.length === 1);
    await waitFor(settled(TENANTS_CONSUMER));
    await first.stop();

    await publish(`chance.tenants.TenantCreated.${TENANT_B}`, "two");
    startConsumer(TENANTS_CONSUMER);
    await waitFor(() => handler.bodies.length === 2);
    await waitFor(settled(TENANTS_CONSUMER));

    expect(handler.bodies).toEqual(["one", "two"]);
  });

  it("starts without the stream, says so, and picks the events up when the stream appears", async () => {
    startConsumer(PAYMENTS_CONSUMER);
    await waitFor(() => logger.messages("warn").includes("The PAYMENTS stream does not exist yet; trying again"));
    expect(handler.bodies).toEqual([]);

    await createStream(PAYMENTS_CONSUMER, ["chance.payments.>"]);
    await publish(`chance.payments.DepositSucceeded.${TENANT_A}`, "late");
    await waitFor(() => handler.bodies.length === 1);

    expect(handler.bodies).toEqual(["late"]);
  });

  it("goes on consuming after the stream was deleted and created again while the service runs", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "before");
    startConsumer(MARKETS_CONSUMER);
    await waitFor(() => handler.bodies.length === 1);
    await waitFor(settled(MARKETS_CONSUMER));

    await jsm.streams.delete(MARKETS_CONSUMER.stream);
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    await publish(`chance.markets.MarketClosed.${TENANT_B}`, "after");
    await waitFor(() => handler.bodies.length === 2);

    expect(handler.bodies).toEqual(["before", "after"]);
  });
});

/** The real handlers on the real consumer: what the service wires in main. */
describe("the handlers on the consumers", () => {
  let logger: RecordingLogger;
  let consumers: JetStreamConsumer[];
  const noop = (): Promise<void> => Promise.resolve();

  beforeEach(async () => {
    for (const spec of [TENANTS_CONSUMER, MARKETS_CONSUMER, PAYMENTS_CONSUMER]) await deleteStream(spec.stream);
    logger = new RecordingLogger();
    consumers = [];
  });
  afterEach(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });

  const start = (spec: ConsumerSpec, handle: (data: Uint8Array) => Promise<HandleResult>): void => {
    const consumer = new JetStreamConsumer({ url, spec, handle, park: noop, logger, nakDelayMs: 50, reconnectDelayMs: 50 });
    consumers.push(consumer);
    consumer.start();
  };
  const envelope = (type: string, id: number, tenantId: string, data: Record<string, unknown>): Record<string, unknown> => ({
    specversion: "1.0",
    id: eventId(id),
    source: "/chance/test",
    type,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: `corr-${String(id)}`,
    causationid: "req-1",
    data,
  });

  it("TenantCreated reaches the provisioning use case", async () => {
    await jsm.streams.add({ name: "TENANTS", subjects: ["chance.tenants.>"] });
    const notices: TenantCreatedNotice[] = [];
    const provision = {
      execute: (notice: TenantCreatedNotice): Promise<ProvisionTenantResult> => {
        notices.push(notice);
        return Promise.resolve("provisioned");
      },
    };
    start(TENANTS_CONSUMER, (data) => handleTenantCreatedMessage(data, provision, logger));
    await publish(`chance.tenants.TenantCreated.${TENANT_A}`, envelope(TENANT_CREATED_TYPE, 1, TENANT_A, { tenantId: TENANT_A, slug: "acme" }));

    await waitFor(() => notices.length === 1);
    expect(notices[0]).toEqual({ eventId: eventId(1), eventType: TENANT_CREATED_TYPE, tenantId: TENANT_A, correlationId: "corr-1" });
  });

  it("market events reach the use case, and another type of the wide filter is acknowledged without it", async () => {
    await jsm.streams.add({ name: "MARKETS", subjects: ["chance.markets.>"] });
    const notices: MarketEventNotice[] = [];
    const record = {
      execute: (notice: MarketEventNotice): Promise<MarketEventResult> => {
        notices.push(notice);
        return Promise.resolve("applied");
      },
    };
    start(MARKETS_CONSUMER, (data) => handleMarketMessage(data, record, logger));
    await publish(`chance.markets.MarketCreated.${TENANT_A}`, envelope("si.chance.markets.MarketCreated.v1", 2, TENANT_A, { marketId: MARKET_1 }));
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, envelope(MARKET_CLOSED_TYPE, 3, TENANT_A, { marketId: MARKET_1, version: 3, closedAt: "2026-12-01T10:00:00.000Z", closedBy: "admin-1" }));

    await waitFor(() => notices.length === 1);
    await waitFor(async () => (await jsm.consumers.info("MARKETS", "trading")).num_ack_pending === 0);
    expect(notices[0]).toMatchObject({ kind: "market_closed", eventId: eventId(3), tenantId: TENANT_A, facts: { marketId: MARKET_1, version: 3 } });
    expect((await jsm.consumers.info("MARKETS", "trading")).ack_floor.stream_seq).toBe(2);
  });

  it("payment events reach the use case; a refund of a missing debit is acknowledged", async () => {
    await jsm.streams.add({ name: "PAYMENTS", subjects: ["chance.payments.>"] });
    const notices: PaymentEventNotice[] = [];
    const record = {
      execute: (notice: PaymentEventNotice): Promise<PaymentEventResult> => {
        notices.push(notice);
        return Promise.resolve(notice.kind === "withdrawal_failed" ? "no_debit" : "credited");
      },
    };
    start(PAYMENTS_CONSUMER, (data) => handlePaymentMessage(data, record, logger));
    await publish(`chance.payments.DepositSucceeded.${TENANT_B}`, envelope(DEPOSIT_SUCCEEDED_TYPE, 4, TENANT_B, { depositId: eventId(40), userId: "trader-1", amount: 700 }));
    await publish(`chance.payments.WithdrawalFailed.${TENANT_B}`, envelope(WITHDRAWAL_FAILED_TYPE, 5, TENANT_B, { withdrawalId: eventId(50), userId: "trader-1", amount: 300, reason: "provider_error" }));

    await waitFor(() => notices.length === 2);
    await waitFor(async () => (await jsm.consumers.info("PAYMENTS", "trading")).num_ack_pending === 0);
    expect(notices.map((notice) => notice.kind)).toEqual(["deposit_succeeded", "withdrawal_failed"]);
    expect((await jsm.consumers.info("PAYMENTS", "trading")).ack_floor.stream_seq).toBe(2);
  });
});
