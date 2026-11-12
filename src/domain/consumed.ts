import { DomainError } from "./errors.js";
import { isMarketId, isUserId } from "./ledger.js";
import type { ClosedFacts, OpenedFacts, ResolvedFacts } from "./market-state.js";
import { isTenantId } from "./tenant.js";
import { decimalPriceToMicro, isCreditAmount, isOutcome } from "./units.js";

// The events trading consumes from other services, read defensively: unknown fields are ignored (a new optional field
// never breaks this consumer), a breaking change arrives as a new type and is ignored as well, and a malformed event is
// reported as "ignored" so the consumer logs it and acknowledges it (a poison message must not block the stream). The
// tenant comes from the "tenantid" attribute, never from the data alone (plan section 9).
// markets: contracts/asyncapi.yaml of markets (MarketOpened, MarketClosed, MarketResolved, stream MARKETS).
// payments: contracts/asyncapi.yaml of payments (DepositSucceeded, WithdrawalFailed, stream PAYMENTS).

export const MARKET_OPENED_TYPE = "si.chance.markets.MarketOpened.v1";
export const MARKET_CLOSED_TYPE = "si.chance.markets.MarketClosed.v1";
export const MARKET_RESOLVED_TYPE = "si.chance.markets.MarketResolved.v1";
export const DEPOSIT_SUCCEEDED_TYPE = "si.chance.payments.DepositSucceeded.v1";
export const WITHDRAWAL_FAILED_TYPE = "si.chance.payments.WithdrawalFailed.v1";

/** The envelope fields every consumer keeps: the inbox key, the tenant and the ids for tracing. */
export interface ConsumedEnvelope {
  /** The CloudEvent id: the inbox deduplication key. */
  eventId: string;
  eventType: string;
  /** From "tenantid", lower case. */
  tenantId: string;
  /** From "correlationid"; null when the event has none (the consumer then uses the event id). */
  correlationId: string | null;
}

export type MarketEventNotice =
  | (ConsumedEnvelope & { kind: "market_opened"; facts: OpenedFacts; fundingAmount: number })
  | (ConsumedEnvelope & { kind: "market_closed"; facts: ClosedFacts; closedBy: string })
  | (ConsumedEnvelope & { kind: "market_resolved"; facts: ResolvedFacts; resolvedBy: string });

export type PaymentEventNotice =
  | (ConsumedEnvelope & { kind: "deposit_succeeded"; depositId: string; userId: string; amount: number })
  | (ConsumedEnvelope & { kind: "withdrawal_failed"; withdrawalId: string; userId: string; amount: number; reason: string });

/** Not an event trading acts on, or a malformed one: logged as a warning and acknowledged. */
export interface IgnoredEvent {
  kind: "ignored";
  reason: string;
  eventId: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class Malformed extends Error {}

function fail(reason: string): never {
  throw new Malformed(reason);
}

function text(data: Record<string, unknown>, name: string, check: (value: unknown) => boolean = (v) => typeof v === "string" && v !== ""): string {
  const value = data[name];
  if (!check(value)) fail(`data.${name} is missing or invalid`);
  return value as string;
}

function dateTime(data: Record<string, unknown>, name: string): Date {
  const value = data[name];
  if (typeof value !== "string" || !DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) fail(`data.${name} is not an RFC 3339 date-time`);
  return new Date(value);
}

function positiveInteger(data: Record<string, unknown>, name: string): number {
  const value = data[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`data.${name} must be a positive integer`);
  return value;
}

function amount(data: Record<string, unknown>): number {
  const value = data["amount"];
  if (!isCreditAmount(value)) fail("data.amount must be a whole number of credits from 1 to 1000000");
  return value;
}

/** Reads the CloudEvent envelope; returns the data object or the reason the event is ignored. */
function envelopeOf(body: unknown, types: readonly string[]): { envelope: ConsumedEnvelope; data: Record<string, unknown> } | IgnoredEvent {
  if (!isObject(body)) return { kind: "ignored", reason: "The message is not a JSON object", eventId: null };
  const eventId = typeof body["id"] === "string" && UUID_PATTERN.test(body["id"]) ? body["id"].toLowerCase() : null;
  if (body["specversion"] !== "1.0") return { kind: "ignored", reason: "The message is not a CloudEvent 1.0", eventId };
  const type = body["type"];
  if (typeof type !== "string" || !types.includes(type)) return { kind: "ignored", reason: `Unknown event type ${String(type)}`, eventId };
  if (eventId === null) return { kind: "ignored", reason: "The event id is missing or not a UUID", eventId: null };
  if (!isTenantId(body["tenantid"])) return { kind: "ignored", reason: "The tenantid attribute is missing or not a UUID", eventId };
  const tenantId = body["tenantid"].toLowerCase();
  const data = body["data"];
  if (!isObject(data)) return { kind: "ignored", reason: "The event has no data object", eventId };
  const dataTenant = data["tenantId"];
  if (dataTenant !== undefined && (typeof dataTenant !== "string" || dataTenant.toLowerCase() !== tenantId)) {
    return { kind: "ignored", reason: "data.tenantId differs from the tenantid attribute", eventId };
  }
  const correlationId = typeof body["correlationid"] === "string" && body["correlationid"] !== "" ? body["correlationid"] : null;
  return { envelope: { eventId, eventType: type, tenantId, correlationId }, data };
}

function guarded<T>(eventId: string, read: () => T): T | IgnoredEvent {
  try {
    return read();
  } catch (error) {
    if (error instanceof Malformed) return { kind: "ignored", reason: error.message, eventId };
    if (error instanceof DomainError) return { kind: "ignored", reason: error.message, eventId };
    throw error;
  }
}

const marketId = (data: Record<string, unknown>): string => text(data, "marketId", isMarketId).toLowerCase();
const userId = (data: Record<string, unknown>, name: string): string => text(data, name, isUserId);

/** A message of the MARKETS stream. */
export function readMarketEvent(body: unknown): MarketEventNotice | IgnoredEvent {
  const read = envelopeOf(body, [MARKET_OPENED_TYPE, MARKET_CLOSED_TYPE, MARKET_RESOLVED_TYPE]);
  if ("kind" in read) return read;
  const { envelope, data } = read;
  return guarded(envelope.eventId, (): MarketEventNotice => {
    switch (envelope.eventType) {
      case MARKET_OPENED_TYPE: {
        const question = text(data, "question", (v) => typeof v === "string" && v.trim().length >= 1);
        const startingPrice = data["startingPrice"];
        if (typeof startingPrice !== "number") fail("data.startingPrice must be a number");
        return {
          ...envelope,
          kind: "market_opened",
          facts: {
            marketId: marketId(data),
            version: positiveInteger(data, "version"),
            question,
            closeTime: dateTime(data, "closeTime"),
            startingPriceMicro: decimalPriceToMicro(startingPrice, "data.startingPrice"),
            creatorId: userId(data, "creatorId"),
            openedAt: dateTime(data, "openedAt"),
          },
          fundingAmount: positiveInteger(data, "fundingAmount"),
        };
      }
      case MARKET_CLOSED_TYPE:
        return {
          ...envelope,
          kind: "market_closed",
          facts: { marketId: marketId(data), version: positiveInteger(data, "version"), closedAt: dateTime(data, "closedAt") },
          closedBy: userId(data, "closedBy"),
        };
      default: {
        const outcome = data["outcome"];
        if (!isOutcome(outcome)) fail("data.outcome must be YES, NO or INVALID");
        return {
          ...envelope,
          kind: "market_resolved",
          facts: {
            marketId: marketId(data),
            version: positiveInteger(data, "version"),
            outcome,
            resolvedAt: dateTime(data, "resolvedAt"),
            creatorId: userId(data, "creatorId"),
          },
          resolvedBy: userId(data, "resolvedBy"),
        };
      }
    }
  });
}

/** A message of the PAYMENTS stream; only DepositSucceeded and WithdrawalFailed concern trading. */
export function readPaymentEvent(body: unknown): PaymentEventNotice | IgnoredEvent {
  const read = envelopeOf(body, [DEPOSIT_SUCCEEDED_TYPE, WITHDRAWAL_FAILED_TYPE]);
  if ("kind" in read) return read;
  const { envelope, data } = read;
  return guarded(envelope.eventId, (): PaymentEventNotice => {
    if (envelope.eventType === DEPOSIT_SUCCEEDED_TYPE) {
      return {
        ...envelope,
        kind: "deposit_succeeded",
        depositId: text(data, "depositId", (v) => typeof v === "string" && UUID_PATTERN.test(v)).toLowerCase(),
        userId: userId(data, "userId"),
        amount: amount(data),
      };
    }
    return {
      ...envelope,
      kind: "withdrawal_failed",
      withdrawalId: text(data, "withdrawalId", (v) => typeof v === "string" && UUID_PATTERN.test(v)).toLowerCase(),
      userId: userId(data, "userId"),
      amount: amount(data),
      reason: typeof data["reason"] === "string" ? data["reason"] : "unknown",
    };
  });
}
