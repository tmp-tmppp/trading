import { describe, expect, it } from "vitest";
import { DAY_MS, DEFAULT_STREAM_MAX_AGE_DAYS, INBOX_MARGIN_MS, MAX_STREAM_MAX_AGE_DAYS, MIN_STREAM_MAX_AGE_DAYS, inboxRetentionFor, streamMaxAgeMs } from "../../src/adapters/retention.js";

describe("stream retention", () => {
  it("defaults to 30 days and allows 1 to 365 days", () => {
    expect([DEFAULT_STREAM_MAX_AGE_DAYS, MIN_STREAM_MAX_AGE_DAYS, MAX_STREAM_MAX_AGE_DAYS]).toEqual([30, 1, 365]);
  });

  it("turns the days of the setting into milliseconds", () => {
    expect(streamMaxAgeMs(1)).toBe(DAY_MS);
    expect(streamMaxAgeMs(DEFAULT_STREAM_MAX_AGE_DAYS)).toBe(30 * 24 * 3_600_000);
  });

  it("keeps an inbox entry a day longer than the stream keeps a message, whatever the setting", () => {
    expect(INBOX_MARGIN_MS).toBe(DAY_MS);
    for (const days of [MIN_STREAM_MAX_AGE_DAYS, 7, DEFAULT_STREAM_MAX_AGE_DAYS, MAX_STREAM_MAX_AGE_DAYS]) {
      expect(inboxRetentionFor(streamMaxAgeMs(days))).toBe(streamMaxAgeMs(days + 1));
    }
  });
});
