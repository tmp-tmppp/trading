import * as grpc from "@grpc/grpc-js";
import type { Logger as PinoLogger } from "pino";
import { v7 as uuidv7 } from "uuid";
import { InsufficientCredits } from "../../usecases/errors.js";
import type { DebitWithdrawalUseCase } from "../../usecases/use-cases.js";
import { CORRELATION_ID } from "../context.js";
import { assertClient, serviceVerifier } from "../service-auth.js";
import type { ServiceAuthOptions } from "../service-auth.js";
import { loadDebitsService } from "./debits-proto.js";
import type { DebitReplyMessage, DebitRequestMessage } from "./debits-proto.js";
import { CallEnded, failureOf } from "./failure.js";
import type { Failure } from "./failure.js";

/** A debit is a few dozen bytes; the library refuses a message above this size before the handler sees it. */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** How long a close waits for the calls in flight before it cuts the connections (the shutdown's own limit is 10 seconds). */
export const CLOSE_GRACE_MS = 5000;

export interface DebitsServerDeps {
  logger: PinoLogger;
  /** The same use case object as the REST endpoint's: one idempotency store keyed by withdrawalId, so the transports never disagree. */
  debitWithdrawal: DebitWithdrawalUseCase;
  /** The service-token settings of the internal REST port: the same issuer, keys, audience and client ids. */
  auth: ServiceAuthOptions;
  /** Milliseconds since the epoch; the tests replace it. */
  now?: () => number;
}

type DebitCall = grpc.ServerUnaryCall<DebitRequestMessage, DebitReplyMessage>;
type DebitCallback = grpc.sendUnaryData<DebitReplyMessage>;

/** The value of `authorization`, or undefined. HTTP/2 allows this header once (Node refuses a second value), as REST has one. */
function authorizationOf(metadata: grpc.Metadata): string | undefined {
  const [value] = metadata.get("authorization");
  return typeof value === "string" ? value : undefined;
}

/** The caller's x-correlation-id when it is well formed (as for REST), else a new id. */
function correlationIdOf(metadata: grpc.Metadata): string {
  const [sent] = metadata.get("x-correlation-id");
  return typeof sent === "string" && CORRELATION_ID.test(sent) ? sent : uuidv7();
}

/** The status of a failed call, with the trailing metadata `chance-problem-code`, `retry-after` and `x-correlation-id`. */
function statusOf(failure: Failure, correlationId: string): Partial<grpc.StatusObject> {
  const metadata = new grpc.Metadata();
  metadata.set("chance-problem-code", failure.reason);
  metadata.set("x-correlation-id", correlationId);
  if (failure.retryAfterSeconds !== undefined) metadata.set("retry-after", String(failure.retryAfterSeconds));
  return { code: failure.code, details: failure.message, metadata };
}

/**
 * The gRPC server of the debit (REQ-17, ADR-023), the second transport of DebitWithdrawal: contracts/trading-debit.proto
 * is its contract and the file it is built from. It owns no rule: authentication is the REST port's (the same
 * serviceVerifier and assertClient, client `payments` only), validation, idempotency and the debit itself are the use
 * case's, and failureOf maps what comes out to a status.
 */
export class DebitsGrpcServer {
  private readonly server = new grpc.Server({ "grpc.max_receive_message_length": MAX_MESSAGE_BYTES, "grpc.max_send_message_length": MAX_MESSAGE_BYTES });
  private readonly verify: ReturnType<typeof serviceVerifier>;
  private readonly now: () => number;
  private closing: Promise<void> | null = null;

  constructor(private readonly deps: DebitsServerDeps) {
    this.verify = serviceVerifier(deps.auth);
    this.now = deps.now ?? Date.now;
    this.server.addService(loadDebitsService(), {
      DebitCredits: (call: DebitCall, callback: DebitCallback) => {
        void this.debitCredits(call, callback);
      },
    });
  }

  /** Listens on host:port (port 0 picks a free one) and returns the port. The server needs no start() after this. */
  start(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (error, bound) => {
        if (error) reject(error);
        else resolve(bound);
      });
    });
  }

  /**
   * Graceful close: no new connections or calls, the calls in flight finish (their debits are committed and answered),
   * and when they take longer than `graceMs` the connections are cut. Resolves when the server is down.
   */
  close(graceMs: number = CLOSE_GRACE_MS): Promise<void> {
    // A second call waits for the first one's close: the server shuts down once.
    this.closing ??= new Promise((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.deps.logger.warn({ graceMs }, "The gRPC calls in flight did not finish in time; cutting the connections");
        this.server.forceShutdown();
        finish();
      }, graceMs);
      this.server.tryShutdown(() => finish());
    });
    return this.closing;
  }

  private async debitCredits(call: DebitCall, callback: DebitCallback): Promise<void> {
    const correlationId = correlationIdOf(call.metadata);
    const callId = uuidv7();
    const log = this.deps.logger.child({ transport: "grpc", rpc: "DebitCredits", correlationId, callId });
    try {
      const reply = await this.answer(call, log, correlationId, callId);
      const trailer = new grpc.Metadata();
      trailer.set("x-correlation-id", correlationId);
      callback(null, reply, trailer);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === grpc.status.INTERNAL) log.error({ err: error }, "The debit failed");
      else if (failure.code === grpc.status.UNAVAILABLE) log.warn({ reason: failure.reason }, "The debit cannot be answered now");
      else log.info({ code: grpc.status[failure.code], reason: failure.reason }, "The debit call was refused");
      callback(statusOf(failure, correlationId), null);
    }
  }

  private async answer(call: DebitCall, log: PinoLogger, correlationId: string, callId: string): Promise<DebitReplyMessage> {
    // 401 (UNAUTHENTICATED) or 503 (UNAVAILABLE) first, then 403 (PERMISSION_DENIED), then the input: the order of the REST port.
    const identity = await this.verify(authorizationOf(call.metadata), log);
    assertClient(identity, "payments");
    const callLog = log.child({ client: identity.clientId });
    this.assertAlive(call);

    const request = call.request;
    const result = await this.deps.debitWithdrawal.execute({
      caller: { client: "payments", correlationId, causationId: callId },
      // The withdrawal id is the key; there is no header to compare it with.
      idempotencyKey: undefined,
      withdrawalId: request.withdrawal_id,
      tenantId: request.tenant_id,
      userId: request.user_id,
      amount: request.amount,
    });
    if (call.cancelled) {
      // A debit that began is finished and committed (idempotent: the repeat returns it); only the answer has no reader.
      callLog.info({ withdrawalId: result.withdrawalId, outcome: result.kind }, "The debit finished after the call had ended");
    }
    // Definitive and stored like REST's 409: the same status for every repeat.
    if (result.kind === "insufficient_credits") throw new InsufficientCredits("The user's credits are too few for this withdrawal");
    return { withdrawal_id: result.withdrawalId, status: "DEBIT_STATUS_DEBITED", amount: request.amount };
  }

  /** A call that is cancelled or past its deadline starts no work. The library ends the call itself when the deadline passes. */
  private assertAlive(call: DebitCall): void {
    if (call.cancelled) throw new CallEnded(grpc.status.CANCELLED, "The call was cancelled before the debit started");
    const deadline = call.getDeadline();
    const at = deadline instanceof Date ? deadline.getTime() : deadline;
    if (at <= this.now()) throw new CallEnded(grpc.status.DEADLINE_EXCEEDED, "The deadline passed before the debit started");
  }
}
