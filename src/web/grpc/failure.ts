import { status } from "@grpc/grpc-js";
import { UseCaseError, Unavailable } from "../../usecases/errors.js";
import type { FieldError, UseCaseErrorKind } from "../../usecases/errors.js";
import { HttpError } from "../problems.js";

// The mapping of the errors of the use cases and of the authentication to gRPC statuses, here and nowhere else (the
// counterpart of problems.ts for HTTP). The table is the one in contracts/trading-debit.proto and README.md.

/** What the client is told: the status, a text for people, the stable reason code, and the seconds to wait (503 only). */
export interface Failure {
  code: status;
  message: string;
  /** The code of the REST problem with the same meaning (`insufficient_credits`, ...), sent as the trailing metadata `reason`. */
  reason: string;
  retryAfterSeconds?: number;
}

/** The call ended before the debit started: the client cancelled it, or its deadline passed. No work was done. */
export class CallEnded extends Error {
  constructor(readonly code: status.CANCELLED | status.DEADLINE_EXCEEDED, message: string) {
    super(message);
    this.name = "CallEnded";
  }
}

const STATUS_OF_KIND: Record<UseCaseErrorKind, status> = {
  validation: status.INVALID_ARGUMENT,
  forbidden: status.PERMISSION_DENIED,
  not_found: status.NOT_FOUND,
  // The only conflict of the debit is insufficient_credits; any other is the same kind of answer: a precondition.
  conflict: status.FAILED_PRECONDITION,
  // idempotency_key_reused: the withdrawal id already exists with another body (HTTP 422).
  unprocessable: status.ALREADY_EXISTS,
  unavailable: status.UNAVAILABLE,
};

const STATUS_OF_HTTP: Readonly<Record<number, status>> = {
  401: status.UNAUTHENTICATED,
  403: status.PERMISSION_DENIED,
  503: status.UNAVAILABLE,
};

/** The text of an unexpected failure: the cause stays in the log, the client learns nothing about the inside. */
const INTERNAL_MESSAGE = "The service failed to handle the request";

/** `withdrawalId` -> `withdrawal_id`: the name of the field as the proto writes it. */
export function protoFieldName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** The field errors of a validation failure, named as the proto names the fields (the use cases use the REST names). */
function describeFields(fields: readonly FieldError[]): string {
  return fields
    .map(({ field, message }) => {
      const name = protoFieldName(field);
      return message.includes(field) ? message.replaceAll(field, name) : `${name}: ${message}`;
    })
    .join("; ");
}

function retryAfterOf(error: HttpError): number | undefined {
  const seconds = Number(error.headers["retry-after"]);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** The status of any error a call can end with. An error that is nobody's fault but ours is INTERNAL, and says nothing else. */
export function failureOf(error: unknown): Failure {
  if (error instanceof CallEnded) return { code: error.code, message: error.message, reason: error.code === status.CANCELLED ? "cancelled" : "deadline_exceeded" };
  if (error instanceof HttpError) {
    const code = STATUS_OF_HTTP[error.status];
    if (code === undefined) return { code: status.INTERNAL, message: INTERNAL_MESSAGE, reason: "internal_error" };
    const retryAfterSeconds = retryAfterOf(error);
    return { code, message: error.message, reason: error.code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
  }
  if (error instanceof UseCaseError) {
    const message = error.kind === "validation" && error.fields.length > 0 ? `The request is invalid: ${describeFields(error.fields)}` : error.message;
    return {
      code: STATUS_OF_KIND[error.kind],
      message,
      reason: error.code,
      ...(error instanceof Unavailable ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
  return { code: status.INTERNAL, message: INTERNAL_MESSAGE, reason: "internal_error" };
}
