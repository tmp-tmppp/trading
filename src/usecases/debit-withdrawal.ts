import { decideDebit } from "../domain/accounts.js";
import type { StreamDecision } from "../domain/accounts.js";
import { DomainError } from "../domain/errors.js";
import { emptyUserAccount, parseUserId, userStreamId } from "../domain/ledger.js";
import { parseTenantId } from "../domain/tenant.js";
import { parseCreditAmount } from "../domain/units.js";
import { IdempotencyKeyReused, ValidationFailed, fromDomainError, guardDomain } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { DEBIT_SCOPE, requestHash, serviceMeta, withConflictRetry } from "./support.js";
import type { DebitInput, DebitResult, DebitWithdrawalUseCase } from "./use-cases.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * FL-C step 2, called by payments' withdrawal saga: debit whole credits from the user's balance. Idempotent by the
 * withdrawal id (the body's id; the optional Idempotency-Key header must equal it) and definitive both ways: a debit
 * and a refusal for too few credits are stored under the id and committed, so a repeat answers the same and a later
 * deposit never turns an old refusal into a debit. The tenant comes from payments (trusted): `ensureTenant`.
 * `withdrawalDirectory` remembers the withdrawal's tenant, because the key lives in the tenant's schema and cannot see
 * a first call made for another tenant: the same id with another tenant is idempotency_key_reused.
 */
export class DebitWithdrawal implements DebitWithdrawalUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: DebitInput): Promise<DebitResult> {
    const { store, clock, logger } = this.deps;
    const withdrawalId = input.withdrawalId.toLowerCase();
    if (!UUID_PATTERN.test(withdrawalId)) throw new ValidationFailed([{ field: "withdrawalId", message: "withdrawalId must be a UUID" }]);
    const tenantId = guardDomain(() => parseTenantId(input.tenantId));
    const userId = guardDomain(() => parseUserId(input.userId));
    const amount = guardDomain(() => parseCreditAmount(input.amount));
    if (input.idempotencyKey !== undefined && input.idempotencyKey.toLowerCase() !== withdrawalId) {
      throw new ValidationFailed([{ field: "Idempotency-Key", message: "The Idempotency-Key header must equal the withdrawalId" }]);
    }
    const hash = requestHash({ withdrawalId, tenantId, userId, amount });
    const tenant = await store.ensureTenant(tenantId, clock.now());

    const result = await withConflictRetry(() =>
      tenant.transaction(async (repositories): Promise<DebitResult> => {
        const now = clock.now();
        if ((await repositories.withdrawalDirectory.register(withdrawalId, tenantId, now)) !== tenantId) {
          throw new IdempotencyKeyReused("The withdrawal was debited in another tenant");
        }
        const claim = await repositories.idempotency.claim({ scope: DEBIT_SCOPE, key: withdrawalId, requestHash: hash, now });
        if (claim.kind === "mismatch") throw new IdempotencyKeyReused();
        if (claim.kind === "replay") return claim.result as DebitResult;

        const account = (await repositories.accounts.load(userStreamId(userId), { lock: true, marketIds: [] })) ?? emptyUserAccount(userId);
        let debited: StreamDecision;
        try {
          debited = decideDebit(account, { withdrawalId, credits: amount });
        } catch (error) {
          if (error instanceof DomainError && error.code === "insufficient_credits") {
            // Definitive: stored and committed, nothing was debited.
            const refusal: DebitResult = { kind: "insufficient_credits", withdrawalId };
            await repositories.idempotency.complete(DEBIT_SCOPE, withdrawalId, refusal);
            return refusal;
          }
          if (error instanceof DomainError) throw fromDomainError(error);
          throw error;
        }
        await repositories.ledger.append({
          streamId: debited.streamId,
          expectedVersion: debited.expectedVersion,
          events: debited.events,
          meta: serviceMeta(input.caller),
          recordedAt: now,
        });
        await repositories.accounts.save(debited.next, now);
        const done: DebitResult = { kind: "debited", withdrawalId };
        await repositories.idempotency.complete(DEBIT_SCOPE, withdrawalId, done);
        return done;
      }),
    );
    logger.info({ tenantId, withdrawalId, correlationId: input.caller.correlationId, client: input.caller.client, outcome: result.kind }, "Withdrawal debit answered");
    return result;
  }
}
