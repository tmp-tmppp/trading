import type { FastifyInstance } from "fastify";
import { DEPOSIT_SUCCEEDED_TYPE, MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, WITHDRAWAL_FAILED_TYPE, readMarketEvent, readPaymentEvent } from "../../domain/consumed.js";
import { TENANT_CREATED_TYPE, readTenantCreated } from "../../domain/tenant.js";
import { ValidationFailed } from "../../usecases/errors.js";
import type { ProvisionTenantUseCase, RecordMarketEventUseCase, RecordPaymentEventUseCase } from "../../usecases/use-cases.js";
import type { RequestHook } from "../auth.js";
import { schemas } from "../schemas.js";
import { requireAnyClient } from "../service-auth.js";

/** The three consumers' use cases: the local events route runs the same ones the JetStream consumers do. */
export interface LocalEventUseCases {
  recordMarketEvent: RecordMarketEventUseCase;
  recordPaymentEvent: RecordPaymentEventUseCase;
  provisionTenant: ProvisionTenantUseCase;
}

const MARKET_TYPES: readonly string[] = [MARKET_OPENED_TYPE, MARKET_CLOSED_TYPE, MARKET_RESOLVED_TYPE];
const PAYMENT_TYPES: readonly string[] = [DEPOSIT_SUCCEEDED_TYPE, WITHDRAWAL_FAILED_TYPE];

const rejected = (reason: string) => new ValidationFailed([{ field: "event", message: reason }], `The event is not accepted: ${reason}`);

/**
 * Local mode only (APP_ENV=local without NATS, where no consumer runs): `POST /v1/internal/local/events` takes one
 * CloudEvent (TenantCreated, the three market events, DepositSucceeded, WithdrawalFailed) and runs it through the use
 * case of its consumer, so a developer can drive the whole flow with curl. Any of the three service clients may call
 * it. It is not in contracts/internal.openapi.yaml: it is never deployed. A consumer would acknowledge a malformed event
 * after a warning; here the caller is told why it was refused (400).
 */
export function registerLocalEventRoutes(app: FastifyInstance, local: LocalEventUseCases, authenticate: RequestHook): void {
  app.post<{ Body: Record<string, unknown> }>(
    "/v1/internal/local/events",
    { schema: schemas.localEvent, onRequest: authenticate, preValidation: requireAnyClient },
    async (request) => {
      const body = request.body;
      const type = body["type"];
      if (type === TENANT_CREATED_TYPE) {
        const read = readTenantCreated(body);
        if (read.kind === "ignored") throw rejected(read.reason);
        return { kind: read.kind, result: await local.provisionTenant.execute(read.notice) };
      }
      if (typeof type === "string" && MARKET_TYPES.includes(type)) {
        const read = readMarketEvent(body);
        if (read.kind === "ignored") throw rejected(read.reason);
        return { kind: read.kind, result: await local.recordMarketEvent.execute(read) };
      }
      if (typeof type === "string" && PAYMENT_TYPES.includes(type)) {
        const read = readPaymentEvent(body);
        if (read.kind === "ignored") throw rejected(read.reason);
        return { kind: read.kind, result: await local.recordPaymentEvent.execute(read) };
      }
      throw new ValidationFailed([{ field: "type", message: "is not an event type trading consumes" }]);
    },
  );
}
