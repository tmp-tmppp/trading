import { decideDeposit, decideRefund } from "../domain/accounts.js";
import type { StreamDecision } from "../domain/accounts.js";
import type { PaymentEventNotice } from "../domain/consumed.js";
import { withdrawalRefundedEvent } from "../domain/events.js";
import { emptyUserAccount, parseStreamId, userStreamId } from "../domain/ledger.js";
import { wholeCredits } from "../domain/units.js";
import { guardDomain } from "./errors.js";
import type { TenantRepositories, UseCaseDeps } from "./ports.js";
import { PAYMENT_EVENTS_CONSUMER, eventContext, eventMeta, outboxMessage, withConflictRetry } from "./support.js";
import type { PaymentEventResult, RecordPaymentEventUseCase } from "./use-cases.js";

/**
 * DepositSucceeded and WithdrawalFailed of payments (FL-B step 4, FL-C step 7), each in one transaction with its inbox
 * entry. A deposit is credited once per deposit id and a failed withdrawal is refunded once per withdrawal id: the inbox
 * stops a redelivered event and the ledger's business key (DM-10) stops the same id arriving in another event.
 * The refund is exactly what the debit took, on the stream of that debit, whatever the event says, so a refund can
 * never create credits; a WithdrawalFailed for a withdrawal trading never debited is an error in the log and nothing
 * else (the event is acknowledged: a retry could not change it). The tenant comes from payments, a trusted service:
 * `ensureTenant`.
 */
export class RecordPaymentEvent implements RecordPaymentEventUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(notice: PaymentEventNotice): Promise<PaymentEventResult> {
    const { store, clock, logger } = this.deps;
    const tenant = await store.ensureTenant(notice.tenantId, clock.now());
    const result = await withConflictRetry(() =>
      tenant.transaction(async (repositories): Promise<PaymentEventResult> => {
        const now = clock.now();
        const fresh = await repositories.inbox.record({ consumer: PAYMENT_EVENTS_CONSUMER, eventId: notice.eventId, eventType: notice.eventType, processedAt: now });
        if (!fresh) return "duplicate";
        return notice.kind === "deposit_succeeded" ? this.credit(repositories, notice, now) : this.refund(repositories, notice, now);
      }),
    );
    logger.info(
      { tenantId: notice.tenantId, eventId: notice.eventId, kind: notice.kind, result, userId: notice.userId, correlationId: notice.correlationId },
      "Payment event processed",
    );
    return result;
  }

  private async credit(repositories: TenantRepositories, notice: PaymentEventNotice & { kind: "deposit_succeeded" }, now: Date): Promise<PaymentEventResult> {
    if ((await repositories.ledger.findByKey("DepositCredited", notice.depositId)) !== null) return "duplicate";
    const account = (await repositories.accounts.load(userStreamId(notice.userId), { lock: true, marketIds: [] })) ?? emptyUserAccount(notice.userId);
    const decided = guardDomain(() => decideDeposit(account, { depositId: notice.depositId, credits: notice.amount }));
    await this.write(repositories, decided, notice, now);
    return "credited";
  }

  private async refund(repositories: TenantRepositories, notice: PaymentEventNotice & { kind: "withdrawal_failed" }, now: Date): Promise<PaymentEventResult> {
    const { logger } = this.deps;
    if ((await repositories.ledger.findByKey("WithdrawalRefunded", notice.withdrawalId)) !== null) return "duplicate";
    const debit = await repositories.ledger.findByKey("WithdrawalDebited", notice.withdrawalId);
    if (debit === null) {
      logger.error({ tenantId: notice.tenantId, withdrawalId: notice.withdrawalId, userId: notice.userId, eventId: notice.eventId }, "WithdrawalFailed for a withdrawal trading never debited; nothing refunded");
      return "no_debit";
    }
    const owner = parseStreamId(debit.streamId);
    if (debit.type !== "WithdrawalDebited" || owner === null || owner.kind !== "user") throw new Error(`The debit of ${notice.withdrawalId} is not on a user stream`);
    if (owner.userId !== notice.userId || wholeCredits(debit.data.amountMicro) !== notice.amount) {
      logger.error(
        { tenantId: notice.tenantId, withdrawalId: notice.withdrawalId, eventUserId: notice.userId, debitedUserId: owner.userId, eventAmount: notice.amount, debitedMicro: debit.data.amountMicro },
        "WithdrawalFailed differs from the debit; refunding exactly what the debit took, to the debited account",
      );
    }
    const account = await repositories.accounts.load(debit.streamId, { lock: true, marketIds: [] });
    if (account === null) throw new Error(`The account ${debit.streamId} of a debit has no projection`);
    const decided = guardDomain(() => decideRefund(account, { withdrawalId: notice.withdrawalId, debitedMicro: debit.data.amountMicro }));
    await this.write(repositories, decided, notice, now);
    const event = withdrawalRefundedEvent(
      { withdrawalId: notice.withdrawalId, userId: owner.userId, amount: wholeCredits(debit.data.amountMicro), refundedAt: now.toISOString() },
      eventContext(this.deps, notice.tenantId, { correlationId: notice.correlationId ?? notice.eventId, causationId: notice.eventId }, now),
    );
    await repositories.outbox.add(outboxMessage("WithdrawalRefunded", event, notice.withdrawalId, now));
    return "refunded";
  }

  private async write(repositories: TenantRepositories, decided: StreamDecision, notice: PaymentEventNotice, now: Date): Promise<void> {
    await repositories.ledger.append({
      streamId: decided.streamId,
      expectedVersion: decided.expectedVersion,
      events: decided.events,
      meta: eventMeta(notice),
      recordedAt: now,
    });
    await repositories.accounts.save(decided.next, now);
  }
}
