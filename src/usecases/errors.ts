import { DomainError } from "../domain/errors.js";

// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes (GP-6.28): validation 400,
// forbidden 403, not_found 404, conflict 409, unprocessable 422, unavailable 503 with Retry-After. The problem type of
// an answer is urn:chance:problem:<code with dashes>, for example ...:insufficient-credits; `details` become extension
// members of the problem (RFC 9457), for example {"maxAmount": 120} of insufficient-liquidity.
export type UseCaseErrorKind = "validation" | "forbidden" | "not_found" | "conflict" | "unprocessable" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "insufficient_credits". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid", code = "validation_failed") {
    super("validation", code, message, fields);
  }
}

/** The caller's role or service account does not allow the action. */
export class Forbidden extends UseCaseError {
  constructor(message: string) {
    super("forbidden", "forbidden", message);
  }
}

/** No such market in the caller's tenant (another tenant's market is simply not found, plan section 9). */
export class NotFound extends UseCaseError {
  constructor(message = "No such market") {
    super("not_found", "not_found", message);
  }
}

export class Conflict extends UseCaseError {
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("conflict", code, message, [], details);
  }
}

/** The market takes no orders or offers now: not open yet, closed, resolved, unfunded or past its close time. */
export class MarketNotOpen extends Conflict {
  constructor(message = "The market does not take orders now", details: Readonly<Record<string, unknown>> = {}) {
    super("market_not_open", message, details);
  }
}

/** The balance is lower than the amount (orders, funding, debits). */
export class InsufficientCredits extends Conflict {
  constructor(message = "The balance is lower than the amount", details: Readonly<Record<string, unknown>> = {}) {
    super("insufficient_credits", message, details);
  }
}

/**
 * The bot's offers cannot fill the order or the sale: `details.maxAmount` is the largest whole amount they can take
 * (orders), `details.maxSharesMicro` the most shares of the other side they hold (sales).
 */
export class InsufficientLiquidity extends Conflict {
  constructor(details: Readonly<Record<string, unknown>> = { maxAmount: 0 }) {
    super("insufficient_liquidity", "The market maker's offers cannot fill this now", details);
  }
}

/** DM-18: the average price would be above maxAveragePriceMicro; `details.quote` is a fresh quote. */
export class PriceLimitExceeded extends Conflict {
  constructor(details: Readonly<Record<string, unknown>>) {
    super("price_limit_exceeded", "The price moved above maxAveragePriceMicro; nothing was bought", details);
  }
}

/** UC-08: the position holds fewer shares of the side than the sale; `details.heldMicro` is what it holds. */
export class InsufficientShares extends Conflict {
  constructor(message = "The position holds fewer shares than the sale", details: Readonly<Record<string, unknown>> = {}) {
    super("insufficient_shares", message, details);
  }
}

/** UC-08, DM-18's counterpart: the proceeds would be below minProceedsMicro (or zero); `details.quote` is a fresh sale quote. */
export class ProceedsBelowMinimum extends Conflict {
  constructor(details: Readonly<Record<string, unknown>>) {
    super("proceeds_below_minimum", "The proceeds would be below minProceedsMicro; nothing was sold", details);
  }
}

/** ADR-041: a trade happened since the book the bot priced on; `details.tradeSequence` is the current one. */
export class StaleSequence extends Conflict {
  constructor(tradeSequence: number) {
    super("stale_sequence", "A trade happened since basedOnSequence; read the book again", { tradeSequence });
  }
}

/** The same Idempotency-Key was used before with another request (HTTP 422). */
export class IdempotencyKeyReused extends UseCaseError {
  constructor(message = "The Idempotency-Key was used before with another request") {
    super("unprocessable", "idempotency_key_reused", message);
  }
}

/** Worth retrying after `retryAfterSeconds` (HTTP 503 with Retry-After). */
export class Unavailable extends UseCaseError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super("unavailable", code, message);
  }
}

/** Seconds a client waits when its tenant's schema does not exist yet. */
export const TENANT_NOT_READY_RETRY_AFTER_SECONDS = 5;

/** The tenant's TenantCreated event has not been processed yet, so it has no schema (plan section 9). */
export class TenantNotReady extends Unavailable {
  constructor(retryAfterSeconds = TENANT_NOT_READY_RETRY_AFTER_SECONDS) {
    super("tenant_not_ready", "The tenant is being set up in this service; try again shortly", retryAfterSeconds);
  }
}

/** The runtime setting ORDERS_ENABLED=false pauses new orders (ADR-037). */
export class OrdersPaused extends Unavailable {
  constructor(retryAfterSeconds = 30) {
    super("orders_paused", "New orders are paused; try again later", retryAfterSeconds);
  }
}

/** Concurrent appends kept winning over this request (after the retries of withConflictRetry). */
export class ConcurrentUpdate extends Unavailable {
  constructor(retryAfterSeconds = 1) {
    super("concurrent_update", "The accounts changed while the request was decided; try again", retryAfterSeconds);
  }
}

/**
 * Thrown by a LedgerRepository when an append lost: another transaction took the expected version of the stream or the
 * business key (DM-07, DM-10). Not a UseCaseError: withConflictRetry decides the request again, and when the retries
 * run out it becomes ConcurrentUpdate (or the earlier answer, for a business key that another request completed).
 */
export class LedgerConflict extends Error {
  constructor(
    readonly reason: "version" | "business_key",
    readonly streamId: string,
    message = `Another append to ${streamId} won (${reason})`,
  ) {
    super(message);
    this.name = "LedgerConflict";
  }
}

/** Turns a rule violation of the domain into the use-case error a caller can act on. */
export function fromDomainError(error: DomainError): Error {
  const field = error.field ?? "request";
  const details = error.details ?? {};
  switch (error.code) {
    case "invalid_amount":
    case "invalid_side":
    case "invalid_price":
    case "invalid_shares":
    case "invalid_offers":
    case "invalid_market_id":
    case "invalid_user_id":
    case "invalid_tenant_id":
    case "invalid_outcome":
      return new ValidationFailed([{ field, message: error.message }]);
    case "crossed_offers":
      return new ValidationFailed([{ field, message: error.message }], error.message, "crossed_offers");
    case "insufficient_credits":
      return new InsufficientCredits(error.message, details);
    case "insufficient_liquidity":
      return new InsufficientLiquidity(typeof details["maxSharesMicro"] === "number" ? { maxSharesMicro: details["maxSharesMicro"] } : { maxAmount: typeof details["maxAmount"] === "number" ? details["maxAmount"] : 0 });
    case "insufficient_holdings":
      return new Conflict("insufficient_holdings", error.message, details);
    case "price_limit_exceeded":
      return new PriceLimitExceeded(details);
    case "insufficient_shares":
      return new InsufficientShares(error.message, details);
    case "proceeds_below_minimum":
      return new ProceedsBelowMinimum(details);
    case "market_not_open":
      return new MarketNotOpen(error.message, details);
    case "market_closed":
      return new Conflict("market_closed", error.message, details);
    case "amount_out_of_range":
    case "invariant_violated":
      // A bug or corrupt data, never the caller's fault: an internal error (500), logged with the stack.
      return new Error(`${error.code}: ${error.message}`, { cause: error });
  }
}

/** Runs domain code and reports its rule violations as use-case errors. */
export function guardDomain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DomainError) throw fromDomainError(error);
    throw error;
  }
}
