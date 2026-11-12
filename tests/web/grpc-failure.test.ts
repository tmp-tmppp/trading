import { status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import {
  ConcurrentUpdate,
  Conflict,
  Forbidden,
  IdempotencyKeyReused,
  InsufficientCredits,
  NotFound,
  TenantNotReady,
  ValidationFailed,
} from "../../src/usecases/errors.js";
import { CallEnded, failureOf, protoFieldName } from "../../src/web/grpc/failure.js";
import { HttpError } from "../../src/web/problems.js";

// The mapping of errors to gRPC statuses, one row per kind of error: the table of contracts/trading-debit.proto.
describe("failureOf", () => {
  it("maps the errors of the use cases to the statuses of the proto, with the code of the REST problem as the reason", () => {
    expect(failureOf(new InsufficientCredits())).toMatchObject({ code: status.FAILED_PRECONDITION, reason: "insufficient_credits" });
    expect(failureOf(new Conflict("market_closed", "closed"))).toMatchObject({ code: status.FAILED_PRECONDITION, reason: "market_closed" });
    expect(failureOf(new IdempotencyKeyReused())).toMatchObject({ code: status.ALREADY_EXISTS, reason: "idempotency_key_reused" });
    expect(failureOf(new Forbidden("no"))).toMatchObject({ code: status.PERMISSION_DENIED, reason: "forbidden" });
    expect(failureOf(new NotFound())).toMatchObject({ code: status.NOT_FOUND, reason: "not_found" });
    expect(failureOf(new ConcurrentUpdate())).toEqual({ code: status.UNAVAILABLE, message: expect.any(String), reason: "concurrent_update", retryAfterSeconds: 1 });
    expect(failureOf(new TenantNotReady(7))).toMatchObject({ code: status.UNAVAILABLE, reason: "tenant_not_ready", retryAfterSeconds: 7 });
  });

  it("names the invalid fields as the proto does, once, whether or not the message repeats the field", () => {
    const failure = failureOf(
      new ValidationFailed([
        { field: "withdrawalId", message: "withdrawalId must be a UUID" },
        { field: "userId", message: "must not be empty" },
      ]),
    );
    expect(failure).toMatchObject({ code: status.INVALID_ARGUMENT, reason: "validation_failed" });
    expect(failure.message).toBe("The request is invalid: withdrawal_id must be a UUID; user_id: must not be empty");
    expect(failureOf(new ValidationFailed([]))).toMatchObject({ code: status.INVALID_ARGUMENT, message: "The request is invalid" });
    expect(protoFieldName("tenantId")).toBe("tenant_id");
    expect(protoFieldName("amount")).toBe("amount");
  });

  it("maps the failures of the authentication, with retry-after when the headers carry one", () => {
    expect(failureOf(new HttpError(401, "unauthorized", "no token"))).toEqual({ code: status.UNAUTHENTICATED, message: "no token", reason: "unauthorized" });
    expect(failureOf(new HttpError(403, "forbidden", "wrong client"))).toMatchObject({ code: status.PERMISSION_DENIED, reason: "forbidden" });
    expect(failureOf(new HttpError(503, "identity_provider_unavailable", "keys", { "retry-after": "5" }))).toMatchObject({
      code: status.UNAVAILABLE,
      reason: "identity_provider_unavailable",
      retryAfterSeconds: 5,
    });
    expect(failureOf(new HttpError(503, "identity_provider_unavailable", "keys", { "retry-after": "soon" }))).not.toHaveProperty("retryAfterSeconds");
    // An HTTP status the gRPC port never raises is a bug, not a status of the contract.
    expect(failureOf(new HttpError(418, "teapot", "short and stout"))).toEqual({ code: status.INTERNAL, message: expect.any(String), reason: "internal_error" });
  });

  it("maps a call that ended before the work began, and tells nothing of an unexpected error", () => {
    expect(failureOf(new CallEnded(status.CANCELLED, "gone"))).toEqual({ code: status.CANCELLED, message: "gone", reason: "cancelled" });
    expect(failureOf(new CallEnded(status.DEADLINE_EXCEEDED, "late"))).toEqual({ code: status.DEADLINE_EXCEEDED, message: "late", reason: "deadline_exceeded" });
    const unexpected = failureOf(new Error("relation ledger_events does not exist"));
    expect(unexpected).toEqual({ code: status.INTERNAL, message: "The service failed to handle the request", reason: "internal_error" });
    expect(failureOf("a thrown string")).toMatchObject({ code: status.INTERNAL });
  });
});
