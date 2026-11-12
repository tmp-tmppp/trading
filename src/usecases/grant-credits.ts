import { decideGrant } from "../domain/accounts.js";
import { emptyUserAccount, parseUserId, userStreamId } from "../domain/ledger.js";
import { parseTenantId } from "../domain/tenant.js";
import { parseCreditAmount } from "../domain/units.js";
import { TenantNotReady, ValidationFailed, guardDomain } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { withConflictRetry } from "./support.js";
import type { GrantCreditsInput, GrantCreditsUseCase } from "./use-cases.js";

const GRANT_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Test credits for a user: seed data only (plan 6.2), never a starting bonus. The grant id is the business key, so the
 * same seed run twice credits once: the ledger's UNIQUE (type, business_key) is the last guard (DM-10) and a lost race
 * decides again and finds the earlier grant.
 */
export class GrantCredits implements GrantCreditsUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: GrantCreditsInput): Promise<"granted" | "duplicate"> {
    const { store, clock, logger } = this.deps;
    const tenantId = guardDomain(() => parseTenantId(input.tenantId));
    const userId = guardDomain(() => parseUserId(input.userId));
    const amount = guardDomain(() => parseCreditAmount(input.amount));
    if (!GRANT_ID_PATTERN.test(input.grantId)) throw new ValidationFailed([{ field: "grantId", message: "grantId must be 1 to 128 visible ASCII characters" }]);
    if (input.reason.trim() === "") throw new ValidationFailed([{ field: "reason", message: "reason must not be empty" }]);
    const tenant = await store.forTenant(tenantId);
    if (!tenant) throw new TenantNotReady();

    const result = await withConflictRetry(() =>
      tenant.transaction(async (repositories) => {
        if ((await repositories.ledger.findByKey("CreditsGranted", input.grantId)) !== null) return "duplicate" as const;
        const now = clock.now();
        const account = (await repositories.accounts.load(userStreamId(userId), { lock: true, marketIds: [] })) ?? emptyUserAccount(userId);
        const decided = guardDomain(() => decideGrant(account, { grantId: input.grantId, credits: amount, reason: input.reason }));
        await repositories.ledger.append({
          streamId: decided.streamId,
          expectedVersion: decided.expectedVersion,
          events: decided.events,
          meta: { correlationId: input.grantId, causationId: input.grantId, actor: "seed" },
          recordedAt: now,
        });
        await repositories.accounts.save(decided.next, now);
        return "granted" as const;
      }),
    );
    logger.info({ tenantId, userId, grantId: input.grantId, result }, result === "granted" ? "Credits granted" : "The grant was credited before; nothing changed");
    return result;
  }
}
