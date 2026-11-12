import type { TenantCreatedNotice } from "../domain/tenant.js";
import type { Clock, Logger, Store } from "./ports.js";
import { TENANT_CREATED_CONSUMER } from "./support.js";
import type { ProvisionTenantResult, ProvisionTenantUseCase } from "./use-cases.js";

/**
 * Handles one TenantCreated event, exactly as markets does: the inbox entry, the tenant's schema with all tenant
 * migrations, and the registration commit together or not at all. A redelivered event finds its id in the inbox and
 * changes nothing (DM-06); an error propagates, the consumer naks and the broker redelivers, so a crash between the
 * steps never leaves a half-provisioned tenant.
 */
export class ProvisionTenant implements ProvisionTenantUseCase {
  constructor(private readonly deps: { store: Store; clock: Clock; logger: Logger }) {}

  async execute(notice: TenantCreatedNotice): Promise<ProvisionTenantResult> {
    const { store, clock, logger } = this.deps;
    const now = clock.now();
    const result = await store.transaction(async (repositories): Promise<ProvisionTenantResult> => {
      const fresh = await repositories.inbox.record({
        consumer: TENANT_CREATED_CONSUMER,
        eventId: notice.eventId,
        eventType: notice.eventType,
        processedAt: now,
      });
      if (!fresh) return "duplicate";
      await repositories.tenants.provision(notice.tenantId, now);
      return "provisioned";
    });
    const fields = { tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId };
    if (result === "duplicate") logger.info(fields, "TenantCreated was processed before; nothing changed");
    else logger.info(fields, "Tenant provisioned");
    return result;
  }
}
