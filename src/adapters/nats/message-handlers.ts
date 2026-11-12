import { readMarketEvent, readPaymentEvent } from "../../domain/consumed.js";
import { readTenantCreated } from "../../domain/tenant.js";
import type { Logger, ParkedEvent } from "../../usecases/ports.js";
import type { ProvisionTenantUseCase, RecordMarketEventUseCase, RecordPaymentEventUseCase } from "../../usecases/use-cases.js";

// What a consumer does with one message, without any NATS type, so that the rules are unit-tested (ADR-053 inbox).
// The consumer acknowledges a message only after the handler returned "ack", which is after the transaction of the use
// case committed; an error is a "nak" with its reason, and after PARK_AFTER_DELIVERIES of them the message is parked.

/** What the consumer does with the message: acknowledge it, or ask the broker to deliver it again later. */
export type HandleResult = { kind: "ack" } | { kind: "nak"; reason: string };

const ACK: HandleResult = { kind: "ack" };

const MAX_REASON_LENGTH = 500;

/** The error code and message of a failure, for the log, the parked row and the next delivery: never a token or a body. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, MAX_REASON_LENGTH);
  // UseCaseError and DomainError carry a stable `code`; a database error carries its SQLSTATE; the rest has its name.
  const { code } = error as Error & { code?: unknown };
  const label = typeof code === "string" && code !== "" ? code : error.name;
  return `${label}: ${error.message}`.slice(0, MAX_REASON_LENGTH);
}

/** The message body as text; a NUL character is replaced because a PostgreSQL text column cannot hold it. */
export const payloadText = (data: Uint8Array): string => new TextDecoder().decode(data).replaceAll("\u0000", "�");

function parseBody(data: Uint8Array): { ok: true; body: unknown } | { ok: false } {
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(data)) as unknown };
  } catch {
    return { ok: false };
  }
}

/** A well-formed event of a type trading does not act on is normal on a wide filter; anything else wrong with a message is a warning. */
function logIgnored(logger: Logger, stream: string, event: { reason: string; eventId: string | null }): void {
  const fields = { eventId: event.eventId, reason: event.reason };
  if (event.reason.startsWith("Unknown event type")) logger.info(fields, `A message of the ${stream} stream is not an event trading acts on; it is acknowledged and skipped`);
  else logger.warn(fields, `A message of the ${stream} stream is not a usable event; it is acknowledged and skipped`);
}

/**
 * One message of the TENANTS stream.
 *  - A message that is not JSON, not a CloudEvent 1.0, of another type or malformed: a warning and "ack". A poison
 *    message must never block the consumer, and redelivering it would change nothing.
 *  - TenantCreated: the use case records the event id in the inbox, creates and migrates the tenant's schema and
 *    registers it, in one transaction. "provisioned" and "duplicate" (a redelivery) both end in "ack".
 *  - Any error of the use case (database down, a migration failing): an error log and "nak" with the reason, so the
 *    broker delivers it again after a delay. The transaction was rolled back, so nothing is half done.
 */
export async function handleTenantCreatedMessage(data: Uint8Array, provision: ProvisionTenantUseCase, logger: Logger): Promise<HandleResult> {
  const parsed = parseBody(data);
  if (!parsed.ok) {
    logger.warn({ bytes: data.byteLength }, "A message of the TENANTS stream is not JSON; it is acknowledged and skipped");
    return ACK;
  }
  const event = readTenantCreated(parsed.body);
  if (event.kind === "ignored") {
    logIgnored(logger, "TENANTS", event);
    return ACK;
  }
  const { notice } = event;
  try {
    const result = await provision.execute(notice);
    logger.info({ tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId, result }, "TenantCreated handled");
    return ACK;
  } catch (error) {
    logger.error(
      { tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId, err: error },
      "TenantCreated could not be processed; it will be delivered again",
    );
    return { kind: "nak", reason: describeError(error) };
  }
}

/**
 * One message of the MARKETS stream (the filter is chance.markets.>, so most types are not ours: acknowledged at info
 * level). MarketOpened, MarketClosed and MarketResolved go to RecordMarketEvent; its transaction holds the inbox entry,
 * the market copy and, for a resolution, the settlement, so an ack follows only a commit.
 */
export async function handleMarketMessage(data: Uint8Array, record: RecordMarketEventUseCase, logger: Logger): Promise<HandleResult> {
  const parsed = parseBody(data);
  if (!parsed.ok) {
    logger.warn({ bytes: data.byteLength }, "A message of the MARKETS stream is not JSON; it is acknowledged and skipped");
    return ACK;
  }
  const notice = readMarketEvent(parsed.body);
  if (notice.kind === "ignored") {
    logIgnored(logger, "MARKETS", notice);
    return ACK;
  }
  try {
    const result = await record.execute(notice);
    logger.info(
      { tenantId: notice.tenantId, eventId: notice.eventId, marketId: notice.facts.marketId, eventType: notice.eventType, correlationId: notice.correlationId, result },
      "A market event was handled",
    );
    return ACK;
  } catch (error) {
    logger.error(
      { tenantId: notice.tenantId, eventId: notice.eventId, marketId: notice.facts.marketId, eventType: notice.eventType, correlationId: notice.correlationId, err: error },
      "A market event could not be processed; it will be delivered again",
    );
    return { kind: "nak", reason: describeError(error) };
  }
}

/**
 * One message of the PAYMENTS stream: DepositSucceeded credits the user once, WithdrawalFailed refunds the debited
 * amount once (RecordPaymentEvent). A result "no_debit" (a failed withdrawal trading never debited) is an error that
 * the use case has logged, and the message is acknowledged: redelivering it would change nothing.
 */
export async function handlePaymentMessage(data: Uint8Array, record: RecordPaymentEventUseCase, logger: Logger): Promise<HandleResult> {
  const parsed = parseBody(data);
  if (!parsed.ok) {
    logger.warn({ bytes: data.byteLength }, "A message of the PAYMENTS stream is not JSON; it is acknowledged and skipped");
    return ACK;
  }
  const notice = readPaymentEvent(parsed.body);
  if (notice.kind === "ignored") {
    logIgnored(logger, "PAYMENTS", notice);
    return ACK;
  }
  try {
    const result = await record.execute(notice);
    logger.info(
      { tenantId: notice.tenantId, eventId: notice.eventId, eventType: notice.eventType, correlationId: notice.correlationId, result },
      "A payment event was handled",
    );
    return ACK;
  } catch (error) {
    logger.error(
      { tenantId: notice.tenantId, eventId: notice.eventId, eventType: notice.eventType, correlationId: notice.correlationId, err: error },
      "A payment event could not be processed; it will be delivered again",
    );
    return { kind: "nak", reason: describeError(error) };
  }
}

/** The part of a JetStream message the settle step needs (a `JsMsg` fits). */
export interface SettleableMessage {
  /** The stream sequence: unique per stream, known even for a body that is not JSON. */
  seq: number;
  subject: string;
  data: Uint8Array;
  info: { deliveryCount: number };
  ack(): void;
  nak(millis?: number): void;
}

export interface SettleOptions {
  /** The inbox name of the consumer ("tenant-created", "market-events", "payment-events"). */
  consumer: string;
  /** Deliveries after which a failing message is parked (PARK_AFTER_DELIVERIES). */
  parkAfter: number;
  nakDelayMs: number;
  park: (event: ParkedEvent) => Promise<void>;
  logger: Logger;
  now: () => Date;
}

/**
 * Applies a handler's result to the message. "ack" acknowledges it. A "nak" asks for a new delivery after `nakDelayMs`,
 * unless this was already delivery number `parkAfter` or later: then the message is written to the parked events and
 * acknowledged, so one failing event never holds back the other markets or tenants of its stream. When parking fails
 * too (the database is down) the message is nak'd and stays on the broker, which never drops it (max_deliver unlimited).
 */
export async function settleMessage(message: SettleableMessage, result: HandleResult, options: SettleOptions): Promise<"acked" | "naked" | "parked"> {
  if (result.kind === "ack") {
    message.ack();
    return "acked";
  }
  const deliveries = message.info.deliveryCount;
  if (deliveries >= options.parkAfter) {
    const fields = { consumer: options.consumer, streamSequence: message.seq, subject: message.subject, deliveries };
    try {
      await options.park({
        consumer: options.consumer,
        streamSequence: message.seq,
        subject: message.subject,
        payload: payloadText(message.data),
        reason: result.reason,
        deliveries,
        parkedAt: options.now(),
      });
      options.logger.error({ ...fields, reason: result.reason }, "An event failed too many deliveries; it was parked and acknowledged (npm run parked lists it)");
      message.ack();
      return "parked";
    } catch (error) {
      options.logger.error({ ...fields, err: error }, "An event could not be parked; it will be delivered again");
    }
  }
  message.nak(options.nakDelayMs);
  return "naked";
}
