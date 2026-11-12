import { describe, expect, it } from "vitest";
import { randomIds, systemClock } from "../../src/adapters/system.js";

describe("systemClock", () => {
  it("returns the current time as a new Date each call", () => {
    const before = Date.now();
    const first = systemClock.now();
    const second = systemClock.now();
    expect(first.getTime()).toBeGreaterThanOrEqual(before);
    expect(first).not.toBe(second);
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});

describe("randomIds", () => {
  it("makes UUIDv7 ids that are unique and grow with time", async () => {
    const first = randomIds.newId();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = randomIds.newId();

    for (const id of [first, second]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
    // The first 48 bits are the Unix time in milliseconds, so a later id sorts after an earlier one: the market list is
    // ordered by id and the cursor compares ids.
    expect(second > first).toBe(true);
  });

  it("makes many distinct ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomIds.newId()));
    expect(ids.size).toBe(500);
  });
});
