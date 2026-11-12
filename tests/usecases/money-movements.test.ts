import { describe, expect, it } from "vitest";
import type { DebitInput } from "../../src/usecases/use-cases.js";
import { PAYMENT_EVENTS_CONSUMER } from "../../src/usecases/support.js";
import { serviceCaller } from "../support/fakes.js";
import { CREATOR, CREDIT, TENANT_A, TENANT_B, TRADER, balanceOf, createCore, depositSucceeded, expectReplayEqual, grant, systemValue, withdrawalFailed } from "./core.js";
import type { Core } from "./core.js";

const WITHDRAWAL = "018f3c1e-7a00-7000-8000-0000000000d1";
const WITHDRAWAL_2 = "018f3c1e-7a00-7000-8000-0000000000d2";

const debit = (overrides: Partial<DebitInput> = {}): DebitInput => ({
  caller: serviceCaller("payments"),
  idempotencyKey: undefined,
  withdrawalId: WITHDRAWAL,
  tenantId: TENANT_A,
  userId: TRADER,
  amount: 40,
  ...overrides,
});

const ledgerOf = (core: Core, tenantId = TENANT_A) => core.store.snapshot().tenantData[tenantId]?.ledger ?? [];

describe("GrantCredits", () => {
  it("credits a user once per grant id", async () => {
    const core = await createCore();

    expect(await core.useCases.grantCredits.execute({ tenantId: TENANT_A, userId: TRADER, amount: 250, grantId: "seed-1", reason: "demo" })).toBe("granted");
    expect(await core.useCases.grantCredits.execute({ tenantId: TENANT_A, userId: TRADER, amount: 250, grantId: "seed-1", reason: "demo" })).toBe("duplicate");

    expect(balanceOf(core, TRADER)).toBe(250 * CREDIT);
    expect(ledgerOf(core)).toEqual([expect.objectContaining({ type: "CreditsGranted", businessKey: "seed-1", data: { grantId: "seed-1", amountMicro: 250 * CREDIT, reason: "demo" }, meta: expect.objectContaining({ actor: "seed" }) })]);
    await expectReplayEqual(core);
  });

  it("refuses bad input and an unregistered tenant", async () => {
    const core = await createCore({ provision: false });
    const grantOf = (input: Partial<Parameters<typeof core.useCases.grantCredits.execute>[0]>) =>
      core.useCases.grantCredits.execute({ tenantId: TENANT_A, userId: TRADER, amount: 5, grantId: "g", reason: "r", ...input });

    await expect(grantOf({})).rejects.toMatchObject({ kind: "unavailable", code: "tenant_not_ready" });
    await expect(grantOf({ tenantId: "x" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "tenantId" }] });
    await expect(grantOf({ userId: "" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "userId" }] });
    await expect(grantOf({ amount: 0 })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "amount" }] });
    await expect(grantOf({ grantId: "has space" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "grantId" }] });
    await expect(grantOf({ reason: "  " })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "reason" }] });
  });
});

describe("DebitWithdrawal", () => {
  it("debits whole credits, keeps the rest and records who asked", async () => {
    const core = await createCore();
    await grant(core, TRADER, 100);
    const valueBefore = systemValue(core);

    const result = await core.useCases.debitWithdrawal.execute(debit());

    expect(result).toEqual({ kind: "debited", withdrawalId: WITHDRAWAL });
    expect(balanceOf(core, TRADER)).toBe(60 * CREDIT);
    expect(systemValue(core)).toBe(valueBefore - 40 * CREDIT);
    expect(ledgerOf(core).at(-1)).toMatchObject({
      type: "WithdrawalDebited",
      businessKey: WITHDRAWAL,
      data: { withdrawalId: WITHDRAWAL, amountMicro: 40 * CREDIT },
      meta: { actor: "client:payments", correlationId: "corr-payments", causationId: "req-payments" },
    });
    expect(core.store.snapshot().withdrawals).toEqual({ [WITHDRAWAL]: TENANT_A });
    expect(core.store.snapshot().outbox).toEqual([]);
    await expectReplayEqual(core);
  });

  it("answers a repeat of the withdrawal id with the stored result and debits once", async () => {
    const core = await createCore();
    await grant(core, TRADER, 100);
    await core.useCases.debitWithdrawal.execute(debit());
    const before = core.store.snapshot();

    expect(await core.useCases.debitWithdrawal.execute(debit())).toEqual({ kind: "debited", withdrawalId: WITHDRAWAL });
    expect(await core.useCases.debitWithdrawal.execute(debit({ idempotencyKey: WITHDRAWAL }))).toEqual({ kind: "debited", withdrawalId: WITHDRAWAL });

    expect(core.store.snapshot()).toEqual(before);
    expect(balanceOf(core, TRADER)).toBe(60 * CREDIT);
  });

  it("stores a refusal for too few credits as definitive: a later deposit does not turn it into a debit", async () => {
    const core = await createCore();
    await grant(core, TRADER, 10);

    expect(await core.useCases.debitWithdrawal.execute(debit())).toEqual({ kind: "insufficient_credits", withdrawalId: WITHDRAWAL });
    expect(balanceOf(core, TRADER)).toBe(10 * CREDIT);
    await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, TRADER, 100));
    const before = core.store.snapshot();

    expect(await core.useCases.debitWithdrawal.execute(debit())).toEqual({ kind: "insufficient_credits", withdrawalId: WITHDRAWAL });

    expect(core.store.snapshot()).toEqual(before);
    expect(balanceOf(core, TRADER)).toBe(110 * CREDIT);
    expect(ledgerOf(core).some((event) => event.type === "WithdrawalDebited")).toBe(false);
  });

  it("treats a user without an account as a balance of zero", async () => {
    const core = await createCore();

    expect(await core.useCases.debitWithdrawal.execute(debit())).toEqual({ kind: "insufficient_credits", withdrawalId: WITHDRAWAL });
    expect(ledgerOf(core)).toEqual([]);
  });

  it("refuses the same withdrawal id with another request or in another tenant (422) without a trace", async () => {
    const core = await createCore();
    await grant(core, TRADER, 100);
    await grant(core, TRADER, 100, TENANT_B);
    await core.useCases.debitWithdrawal.execute(debit());
    const before = core.store.snapshot();

    await expect(core.useCases.debitWithdrawal.execute(debit({ amount: 41 }))).rejects.toMatchObject({ kind: "unprocessable", code: "idempotency_key_reused" });
    await expect(core.useCases.debitWithdrawal.execute(debit({ userId: "someone-else" }))).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(core.useCases.debitWithdrawal.execute(debit({ tenantId: TENANT_B }))).rejects.toMatchObject({ code: "idempotency_key_reused", message: "The withdrawal was debited in another tenant" });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("validates the ids, the amount and the optional header", async () => {
    const core = await createCore();
    const before = core.store.snapshot();

    await expect(core.useCases.debitWithdrawal.execute(debit({ withdrawalId: "w-1" }))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "withdrawalId" }] });
    await expect(core.useCases.debitWithdrawal.execute(debit({ tenantId: "t" }))).rejects.toMatchObject({ fields: [{ field: "tenantId" }] });
    await expect(core.useCases.debitWithdrawal.execute(debit({ userId: "" }))).rejects.toMatchObject({ fields: [{ field: "userId" }] });
    await expect(core.useCases.debitWithdrawal.execute(debit({ amount: 0 }))).rejects.toMatchObject({ fields: [{ field: "amount" }] });
    await expect(core.useCases.debitWithdrawal.execute(debit({ idempotencyKey: WITHDRAWAL_2 }))).rejects.toMatchObject({ fields: [{ field: "Idempotency-Key" }] });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("provisions a tenant whose TenantCreated never arrived", async () => {
    const core = await createCore({ provision: false });

    expect(await core.useCases.debitWithdrawal.execute(debit())).toMatchObject({ kind: "insufficient_credits" });

    expect(core.store.snapshot().tenants).toEqual([TENANT_A]);
  });
});

describe("RecordPaymentEvent: deposits", () => {
  it("credits a deposit once, whether the event or its deposit id comes again", async () => {
    const core = await createCore();
    const first = depositSucceeded(core, TRADER, 250);
    const valueBefore = systemValue(core);

    expect(await core.useCases.recordPaymentEvent.execute(first)).toBe("credited");
    expect(balanceOf(core, TRADER)).toBe(250 * CREDIT);
    expect(systemValue(core)).toBe(valueBefore + 250 * CREDIT);
    expect(await core.useCases.recordPaymentEvent.execute(first)).toBe("duplicate");
    if (first.kind !== "deposit_succeeded") throw new Error("a deposit");
    expect(await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, TRADER, 250, { depositId: first.depositId }))).toBe("duplicate");

    expect(balanceOf(core, TRADER)).toBe(250 * CREDIT);
    expect(ledgerOf(core)).toEqual([
      expect.objectContaining({ type: "DepositCredited", businessKey: first.depositId, meta: { correlationId: "corr-payments", causationId: first.eventId, actor: "system" } }),
    ]);
    // The redelivered event is stopped by its inbox entry; the second event with the same deposit id is stopped by the ledger key.
    expect(core.store.snapshot().inbox.map((entry) => entry.consumer)).toEqual([PAYMENT_EVENTS_CONSUMER, PAYMENT_EVENTS_CONSUMER]);
    await expectReplayEqual(core);
  });

  it("credits two users and two tenants independently and adds to an existing balance", async () => {
    const core = await createCore();

    await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, TRADER, 100));
    await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, TRADER, 50));
    await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, CREATOR, 7));
    await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, TRADER, 9, { tenantId: TENANT_B }));

    expect(balanceOf(core, TRADER)).toBe(150 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(7 * CREDIT);
    expect(balanceOf(core, TRADER, TENANT_B)).toBe(9 * CREDIT);
  });

  it("provisions a tenant whose TenantCreated never arrived", async () => {
    const core = await createCore({ provision: false });

    expect(await core.useCases.recordPaymentEvent.execute(depositSucceeded(core, TRADER, 5))).toBe("credited");

    expect(balanceOf(core, TRADER)).toBe(5 * CREDIT);
  });
});

describe("RecordPaymentEvent: failed withdrawals", () => {
  async function debited(core: Core, credits = 100, amount = 40) {
    await grant(core, TRADER, credits);
    await core.useCases.debitWithdrawal.execute(debit({ amount }));
  }

  it("refunds exactly the debited amount once and publishes WithdrawalRefunded", async () => {
    const core = await createCore();
    await debited(core);
    const valueBefore = systemValue(core);
    const failed = withdrawalFailed(core, WITHDRAWAL, TRADER, 40);

    expect(await core.useCases.recordPaymentEvent.execute(failed)).toBe("refunded");

    expect(balanceOf(core, TRADER)).toBe(100 * CREDIT);
    expect(systemValue(core)).toBe(valueBefore + 40 * CREDIT);
    expect(ledgerOf(core).at(-1)).toMatchObject({ type: "WithdrawalRefunded", businessKey: WITHDRAWAL, data: { withdrawalId: WITHDRAWAL, amountMicro: 40 * CREDIT }, streamId: `account:${TRADER}` });
    expect(core.store.snapshot().outbox).toHaveLength(1);
    expect(core.store.snapshot().outbox[0]).toMatchObject({
      subject: `chance.trading.WithdrawalRefunded.${TENANT_A}`,
      aggregateId: WITHDRAWAL,
      payload: {
        type: "si.chance.trading.WithdrawalRefunded.v1",
        subject: `withdrawal/${WITHDRAWAL}`,
        correlationid: "corr-payments",
        causationid: failed.eventId,
        data: { withdrawalId: WITHDRAWAL, userId: TRADER, amount: 40, refundedAt: core.clock.now().toISOString() },
      },
    });
    await expectReplayEqual(core);
  });

  it("refunds only once: the same event, or another event for the same withdrawal, changes nothing", async () => {
    const core = await createCore();
    await debited(core);
    const failed = withdrawalFailed(core, WITHDRAWAL, TRADER, 40);
    await core.useCases.recordPaymentEvent.execute(failed);

    expect(await core.useCases.recordPaymentEvent.execute(failed)).toBe("duplicate");
    expect(await core.useCases.recordPaymentEvent.execute(withdrawalFailed(core, WITHDRAWAL, TRADER, 40))).toBe("duplicate");

    expect(balanceOf(core, TRADER)).toBe(100 * CREDIT);
    expect(core.store.snapshot().outbox).toHaveLength(1);
    expect(ledgerOf(core).filter((event) => event.type === "WithdrawalRefunded")).toHaveLength(1);
  });

  it("refunds the debited stream with the debited amount, whatever the event names", async () => {
    const core = await createCore();
    await debited(core);
    await grant(core, CREATOR, 5);
    core.logger.lines.length = 0;

    expect(await core.useCases.recordPaymentEvent.execute(withdrawalFailed(core, WITHDRAWAL, CREATOR, 90))).toBe("refunded");

    expect(balanceOf(core, TRADER)).toBe(100 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(5 * CREDIT);
    expect(core.store.snapshot().outbox[0]?.payload.data).toMatchObject({ userId: TRADER, amount: 40 });
    expect(core.logger.lines.filter((line) => line.level === "error")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("differs from the debit") as unknown, fields: expect.objectContaining({ eventUserId: CREATOR, debitedUserId: TRADER, eventAmount: 90 }) as unknown }),
    ]);
  });

  it("logs an error and refunds nothing when trading never debited the withdrawal", async () => {
    const core = await createCore();
    await grant(core, TRADER, 100);
    core.logger.lines.length = 0;

    expect(await core.useCases.recordPaymentEvent.execute(withdrawalFailed(core, WITHDRAWAL, TRADER, 40))).toBe("no_debit");

    expect(balanceOf(core, TRADER)).toBe(100 * CREDIT);
    expect(core.store.snapshot().outbox).toEqual([]);
    expect(ledgerOf(core).map((event) => event.type)).toEqual(["CreditsGranted"]);
    expect(core.logger.lines.filter((line) => line.level === "error")).toHaveLength(1);
  });

  it("refuses a debit that is not on a user stream (corrupt data fails, the consumer retries and parks)", async () => {
    const core = await createCore();
    await debited(core);
    const tenant = await core.store.forTenant(TENANT_A);
    const failed = withdrawalFailed(core, WITHDRAWAL_2, TRADER, 5);
    if (failed.kind !== "withdrawal_failed" || tenant === null) throw new Error("a failed withdrawal");
    // A debit of another withdrawal that sits on a bot stream: no flow writes this, so it is a corrupt ledger.
    await tenant.transaction(async (repositories) => {
      await repositories.ledger.append({
        streamId: `bot:018f3c1e-7a00-7000-8000-000000000101`,
        expectedVersion: 0,
        events: [{ type: "WithdrawalDebited", data: { withdrawalId: WITHDRAWAL_2, amountMicro: 5 * CREDIT } }],
        meta: { correlationId: "c", causationId: "c", actor: "test" },
        recordedAt: core.clock.now(),
      });
    });

    await expect(core.useCases.recordPaymentEvent.execute(failed)).rejects.toThrow("not on a user stream");
  });

  it("refunds the whole debit when the balance since fell to zero", async () => {
    const core = await createCore();
    await debited(core, 40, 40);
    expect(balanceOf(core, TRADER)).toBe(0);

    expect(await core.useCases.recordPaymentEvent.execute(withdrawalFailed(core, WITHDRAWAL, TRADER, 40))).toBe("refunded");

    expect(balanceOf(core, TRADER)).toBe(40 * CREDIT);
  });
});
