import { describe, expect, it } from "vitest";
import type { AccountState } from "../../src/domain/ledger.js";
import { ReplayLedger } from "../../src/usecases/replay-ledger.js";
import { CREATOR, CREDIT, MARKET_1, TENANT_A, TENANT_B, TRADER, accountsOf, createCore, grant, marketResolved, openMarket, order, wrapRepositories } from "./core.js";
import type { Core } from "./core.js";

const OTHER = "trader-2";
const WITHDRAWAL = "018f3c1e-7a00-7000-8000-0000000000d1";

/** Funding, trades, a withdrawal and a deposit: every kind of stream and most event types. */
async function scenario(): Promise<Core> {
  const core = await createCore();
  await openMarket(core);
  await grant(core, TRADER, 200);
  await grant(core, OTHER, 100);
  await order(core, TRADER, { amount: 40 });
  await order(core, OTHER, { side: "NO", amount: 30 });
  await core.useCases.debitWithdrawal.execute({ caller: { client: "payments", correlationId: "c", causationId: "r" }, idempotencyKey: undefined, withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: OTHER, amount: 10 });
  return core;
}

async function tamper(core: Core, streamId: string, change: (state: AccountState) => AccountState): Promise<void> {
  const tenant = await core.store.forTenant(TENANT_A);
  await tenant?.transaction(async (repositories) => {
    const state = await repositories.accounts.load(streamId);
    if (state === null) throw new Error(`no account ${streamId}`);
    await repositories.accounts.save(change(state), core.clock.now());
  });
}

const sorted = (accounts: AccountState[]) => [...accounts].sort((a, b) => (a.streamId < b.streamId ? -1 : 1));

describe("ReplayLedger", () => {
  it("finds the projections equal to the replay of the whole ledger (the proof of DM-07)", async () => {
    const core = await scenario();
    const ledger = core.store.snapshot().tenantData[TENANT_A]?.ledger ?? [];

    const report = await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: false });

    expect(report).toEqual({ tenantId: TENANT_A, events: ledger.length, streams: new Set(ledger.map((event) => event.streamId)).size, differences: [], rebuilt: false });
    expect(report.streams).toBe(4);
  });

  it("stays equal after the market is settled, and reads the ledger in several round trips", async () => {
    const core = await scenario();
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));
    const small = new ReplayLedger(core.deps, 2);

    const report = await small.execute({ tenantId: TENANT_A, rebuild: false });

    expect(report.differences).toEqual([]);
    expect(report.events).toBe((core.store.snapshot().tenantData[TENANT_A]?.ledger ?? []).length);
  });

  it("reports nothing for a tenant with an empty ledger and refuses a tenant that is not registered", async () => {
    const core = await createCore();

    expect(await core.useCases.replayLedger.execute({ tenantId: TENANT_B, rebuild: false })).toEqual({ tenantId: TENANT_B, events: 0, streams: 0, differences: [], rebuilt: false });
    await expect(core.useCases.replayLedger.execute({ tenantId: "018f3c1e-7a00-7000-8000-0000000000cc", rebuild: false })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("detects a tampered balance, version and position", async () => {
    const core = await scenario();
    await tamper(core, `account:${TRADER}`, (state) => ({ ...state, balanceMicro: state.balanceMicro + 1 }));
    await tamper(core, `account:${OTHER}`, (state) => ({ ...state, version: state.version + 1 }));
    await tamper(core, `account:${CREATOR}`, (state) => ({ ...state, positions: { [MARKET_1]: { yesMicro: 7, noMicro: 0 } } }));

    const { differences } = await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: false });

    expect(differences).toEqual([
      { streamId: `account:${CREATOR}`, what: "position", marketId: MARKET_1, expected: null, actual: { yesMicro: 7, noMicro: 0 } },
      { streamId: `account:${TRADER}`, what: "balance", expected: 160 * CREDIT, actual: 160 * CREDIT + 1 },
      { streamId: `account:${OTHER}`, what: "version", expected: 3, actual: 4 },
    ]);
  });

  it("detects a changed holding of a market the replay holds, a projection that is missing and one that is extra", async () => {
    const core = await scenario();
    await tamper(core, `account:${TRADER}`, (state) => ({ ...state, positions: { [MARKET_1]: { yesMicro: 99_999_999, noMicro: 0 } } }));
    const tenant = await core.store.forTenant(TENANT_A);
    await tenant?.transaction(async (repositories) => {
      const all = await repositories.accounts.all();
      await repositories.accounts.clear();
      for (const state of all) if (state.streamId !== `account:${OTHER}`) await repositories.accounts.save(state, core.clock.now());
      await repositories.accounts.save({ streamId: "account:ghost", kind: "user", ownerId: "ghost", marketId: null, balanceMicro: 5, positions: {}, version: 1 }, core.clock.now());
    });

    const { differences } = await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: false });

    expect(differences).toEqual([
      { streamId: "account:ghost", what: "extra", expected: null, actual: { balanceMicro: 5, version: 1 } },
      { streamId: `account:${TRADER}`, what: "position", marketId: MARKET_1, expected: { yesMicro: 100_000_000, noMicro: 0 }, actual: { yesMicro: 99_999_999, noMicro: 0 } },
      { streamId: `account:${OTHER}`, what: "missing", expected: { balanceMicro: 60 * CREDIT, version: 3 }, actual: null },
    ]);
  });

  it("rebuilds the projections from the ledger, reporting what it found, and a second run finds nothing", async () => {
    const core = await scenario();
    const original = sorted(accountsOf(core));
    await tamper(core, `account:${TRADER}`, (state) => ({ ...state, balanceMicro: 1 }));
    await tamper(core, `bot:${MARKET_1}`, (state) => ({ ...state, positions: { [MARKET_1]: { yesMicro: 0, noMicro: 0 } } }));

    const rebuilt = await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: true });

    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.differences.map((difference) => [difference.streamId, difference.what])).toEqual([[`account:${TRADER}`, "balance"], [`bot:${MARKET_1}`, "position"]]);
    expect(sorted(accountsOf(core))).toEqual(original);
    expect((await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: false })).differences).toEqual([]);
  });

  it("reports a stream that cannot be folded and still compares the others; a rebuild is refused and rewrites nothing", async () => {
    const core = await createCore();
    await grant(core, TRADER, 10);
    await grant(core, OTHER, 5);
    // The projection drifts (a manual fix, a bug): the next debit is valid against it and invalid against the ledger.
    await tamper(core, `account:${TRADER}`, (state) => ({ ...state, balanceMicro: 100 * CREDIT }));
    await tamper(core, `account:${OTHER}`, (state) => ({ ...state, balanceMicro: state.balanceMicro + 1 }));
    await core.useCases.debitWithdrawal.execute({ caller: { client: "payments", correlationId: "c", causationId: "r" }, idempotencyKey: undefined, withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: TRADER, amount: 50 });
    const before = sorted(accountsOf(core));
    const unfoldable = { streamId: `account:${TRADER}`, what: "unfoldable", expected: expect.stringContaining(`account:${TRADER} would be -${40 * CREDIT}`) as unknown, actual: { balanceMicro: 50 * CREDIT, version: 2 } };
    const drifted = { streamId: `account:${OTHER}`, what: "balance", expected: 5 * CREDIT, actual: 5 * CREDIT + 1 };

    const compared = await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: false });
    const refused = await core.useCases.replayLedger.execute({ tenantId: TENANT_A, rebuild: true });

    expect(compared).toMatchObject({ events: 3, streams: 2, rebuilt: false, differences: [unfoldable, drifted] });
    expect(refused).toMatchObject({ rebuilt: false, differences: [unfoldable, drifted] });
    expect(sorted(accountsOf(core))).toEqual(before);
  });

  it("takes the table lock first, then reads, in one transaction", async () => {
    const core = await scenario();
    const calls: string[] = [];
    const spy = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      ledger: {
        ...repositories.ledger,
        lockForReplay: () => {
          calls.push("lock");
          return repositories.ledger.lockForReplay();
        },
        readAll: (after, limit) => {
          calls.push("readAll");
          return repositories.ledger.readAll(after, limit);
        },
      },
      accounts: {
        ...repositories.accounts,
        all: () => {
          calls.push("accounts.all");
          return repositories.accounts.all();
        },
      },
    }));

    await new ReplayLedger({ store: spy, clock: core.clock, logger: core.logger }).execute({ tenantId: TENANT_A, rebuild: false });

    expect(calls[0]).toBe("lock");
    expect(calls.slice(1)).toEqual(["readAll", "readAll", "accounts.all"]);
  });
});
