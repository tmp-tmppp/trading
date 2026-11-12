/**
 * Time constants shared by the NATS adapter and the outbox relay, which do not import each other. Their value is one
 * startup setting, STREAM_MAX_AGE_DAYS (src/config.ts): main.ts turns it once into milliseconds with streamMaxAgeMs and
 * hands that one number to both, so they always agree.
 */
export const DAY_MS = 24 * 3_600_000;

/**
 * The default of STREAM_MAX_AGE_DAYS: how long a message of the TRADING stream is kept (its max age). 30 days, not 7,
 * so that a service that is started later still reads the older events from the stream (decision of 2026-11-11); once
 * every consumer is live the value can be lowered again. The bounds are repeated in the chart's values schema.
 */
export const DEFAULT_STREAM_MAX_AGE_DAYS = 30;
export const MIN_STREAM_MAX_AGE_DAYS = 1;
export const MAX_STREAM_MAX_AGE_DAYS = 365;

/**
 * The stream's max age in milliseconds. The relay keeps a published outbox row as long: a row that was published longer
 * ago than the stream keeps its messages is of no use any more.
 */
export function streamMaxAgeMs(days: number): number {
  return days * DAY_MS;
}

/** How much longer than the stream's max age an inbox entry is kept: the margin for clock differences and a consumer that was down. */
export const INBOX_MARGIN_MS = DAY_MS;

/**
 * How long an entry of the inbox is kept (DM-06): the max age and a day. The streams trading consumes (TENANTS, MARKETS, PAYMENTS) keep their messages for their own max age (every Chance service runs with the
 * same STREAM_MAX_AGE_DAYS), so a redelivery can only arrive within that time. An entry older than this can never match
 * a redelivered event, so it is purged.
 */
export function inboxRetentionFor(maxAgeMs: number): number {
  return maxAgeMs + INBOX_MARGIN_MS;
}
