import { describe, expect, it } from "vitest";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import type { CloudEvent } from "../../src/domain/events.js";
import { RecordingLogger } from "../support/fakes.js";

const event: CloudEvent<unknown> = {
  specversion: "1.0",
  id: "event-1",
  source: "/chance/trading",
  type: "si.chance.trading.MarketFunded.v1",
  subject: "market/m-1",
  time: "2026-11-01T10:00:00.000Z",
  datacontenttype: "application/json",
  tenantid: "t-1",
  correlationid: "c",
  causationid: "k",
  data: {},
};

describe("MemoryEventPublisher", () => {
  it("collects what it publishes and logs it when given a logger", async () => {
    const logger = new RecordingLogger();
    const publisher = new MemoryEventPublisher(logger);

    await publisher.publish("chance.trading.MarketFunded.t-1", event, "event-1");

    expect(publisher.published).toEqual([{ subject: "chance.trading.MarketFunded.t-1", event, messageId: "event-1" }]);
    expect(logger.lines).toEqual([expect.objectContaining({ level: "info", fields: { subject: "chance.trading.MarketFunded.t-1", eventId: "event-1", type: event.type } })]);
  });

  it("publishes silently without a logger", async () => {
    const publisher = new MemoryEventPublisher();

    await publisher.publish("s", event, "event-1");

    expect(publisher.published).toHaveLength(1);
  });

  it("fails the next calls it was told to fail, like an unreachable broker, and then works again", async () => {
    const publisher = new MemoryEventPublisher();
    publisher.failNext = 2;

    await expect(publisher.publish("s", event, "a")).rejects.toThrow("told to fail");
    await expect(publisher.publish("s", event, "b")).rejects.toThrow("told to fail");
    await publisher.publish("s", event, "c");

    expect(publisher.published.map((message) => message.messageId)).toEqual(["c"]);
  });
});
