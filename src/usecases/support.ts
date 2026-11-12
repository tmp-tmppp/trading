import { createHash } from "node:crypto";
import { natsSubject } from "../domain/events.js";
import type { CloudEvent, EventContext, EventName } from "../domain/events.js";
import type { LedgerMeta } from "../domain/ledger.js";
import { ConcurrentUpdate, Forbidden, LedgerConflict, ValidationFailed } from "./errors.js";
import type { Caller, IdGenerator, OutboxMessage, ServiceCaller, TradingRole } from "./ports.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** The market maker's list of open markets: larger pages, it walks all tenants every 30-60 s (ADR-041). */
export const DEFAULT_BOT_PAGE_SIZE = 100;
export const MAX_BOT_PAGE_SIZE = 500;

// Inbox consumer names (shared.inbox.consumer): one per kind of consumed event (ADR-053).
export const TENANT_CREATED_CONSUMER = "tenant-created";
export const MARKET_EVENTS_CONSUMER = "market-events";
export const PAYMENT_EVENTS_CONSUMER = "payment-events";

/**
 * A consumed event that failed this many deliveries in a row is parked (shared.parked_events) and acked, so it cannot
 * hold back the rest of its stream. With the consumers' nak delay of 5 s that is about two minutes of retries: longer
 * than a lost race or a pod restart, shorter than an outage of a whole tenant's processing. While the database itself is
 * down parking fails too and the event stays on the broker (max_deliver stays unlimited: the broker never drops it).
 */
export const PARK_AFTER_DELIVERIES = 20;

/** Max ack pending of all three durable consumers: DM-04's version guards make market events independent of order. */
export const CONSUMER_MAX_ACK_PENDING = 10;

// Idempotency scopes (REL-03). An order key belongs to its user, so two users may pick the same key.
export const FUNDING_SCOPE = "funding";
export const DEBIT_SCOPE = "debit";
export const ORDER_SCOPE_PREFIX = "order:";

export function orderScope(userId: string): string {
  return `${ORDER_SCOPE_PREFIX}${userId}`;
}

/** How long an order's Idempotency-Key is kept; funding and debit keys are business keys and stay. */
export const ORDER_KEY_RETENTION_MS = 7 * 24 * 3_600_000;

/** An Idempotency-Key of an order: 8 to 128 visible ASCII characters (a UUID fits). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;

export function parseIdempotencyKey(value: string | undefined): string {
  if (value === undefined || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ValidationFailed([{ field: "Idempotency-Key", message: "The Idempotency-Key header is required: 8 to 128 visible ASCII characters" }]);
  }
  return value;
}

/** JSON with the keys of every object sorted, so equal requests hash equally whatever their key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The fingerprint of a request stored with its Idempotency-Key: the same key with another request is refused (422). */
export function requestHash(request: unknown): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

export function eventContext(deps: { ids: IdGenerator }, tenantId: string, ids: { correlationId: string; causationId: string }, now: Date): EventContext {
  return { eventId: deps.ids.newId(), tenantId, now, correlationId: ids.correlationId, causationId: ids.causationId };
}

export function outboxMessage(name: EventName, event: CloudEvent<unknown>, aggregateId: string, now: Date): OutboxMessage {
  return { id: event.id, aggregateId, subject: natsSubject(name, event.tenantid), type: event.type, payload: event, createdAt: now };
}

/** Ledger meta of a user's request. */
export function userMeta(caller: Caller): LedgerMeta {
  return { correlationId: caller.correlationId, causationId: caller.causationId, actor: caller.userId };
}

/** Ledger meta of a service call ("client:payments", ...). */
export function serviceMeta(caller: ServiceCaller): LedgerMeta {
  return { correlationId: caller.correlationId, causationId: caller.causationId, actor: `client:${caller.client}` };
}

/** Ledger meta of a consumed event: its correlation id travels on, the event itself is the cause. */
export function eventMeta(event: { eventId: string; correlationId: string | null }): LedgerMeta {
  return { correlationId: event.correlationId ?? event.eventId, causationId: event.eventId, actor: "system" };
}

/** Orders are for traders: tenant admins resolve the markets, so they do not trade (plan 6.2, question 9). */
export function requireTrader(role: TradingRole): void {
  if (role !== "trader") throw new Forbidden("Tenant admins resolve markets and do not trade in them");
}

/** How many times a request is decided again after a LedgerConflict before it answers ConcurrentUpdate (503). */
export const CONFLICT_ATTEMPTS = 3;

/**
 * Runs `work` (one whole transaction) again when an append lost to a concurrent one (LedgerConflict): the next attempt
 * reads the new state, finds a completed idempotency key or business key, and answers from it. Other errors pass.
 */
export async function withConflictRetry<T>(work: () => Promise<T>, attempts = CONFLICT_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof LedgerConflict)) throw error;
      if (attempt >= attempts) throw new ConcurrentUpdate();
    }
  }
}

/** Stream ids in lock order (bot accounts sort before user accounts: "bot:" < "account:" is false, so sort explicitly). */
export function lockOrder(streamIds: readonly string[]): string[] {
  const rank = (id: string): number => (id.startsWith("bot:") ? 0 : 1);
  return [...new Set(streamIds)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

// Cursors are opaque to clients: base64url of a small JSON object. They are checked completely, so a crafted one is a
// 400, never a database error.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MarketCursor {
  tenantId: string;
  marketId: string;
}

export function encodeMarketCursor(position: MarketCursor): string {
  return Buffer.from(JSON.stringify({ t: position.tenantId, m: position.marketId }), "utf8").toString("base64url");
}

export function decodeMarketCursor(cursor: string | undefined): MarketCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; m?: unknown };
    if (typeof parsed.t === "string" && typeof parsed.m === "string" && UUID_PATTERN.test(parsed.t) && UUID_PATTERN.test(parsed.m)) {
      return { tenantId: parsed.t, marketId: parsed.m };
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new ValidationFailed([{ field: "cursor", message: "The cursor is not valid" }]);
}

/** A page size from the query: an integer from 1 to `max`, `fallback` when absent. */
export function pageSize(limit: number | undefined, fallback: number, max: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new ValidationFailed([{ field: "limit", message: `limit must be an integer from 1 to ${max}` }]);
  return value;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}
