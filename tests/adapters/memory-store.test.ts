import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import type { AccountState, LedgerEvent } from "../../src/domain/ledger.js";
import { newFundedMarket } from "../../src/domain/market-state.js";
import type { MarketState } from "../../src/domain/market-state.js";
import { LedgerConflict } from "../../src/usecases/errors.js";
import type { OutboxMessage, TenantStore } from "../../src/usecases/ports.js";
import { MARKET_1, MARKET_2, RecordingLogger, TENANT_A, TENANT_B } from "../support/fakes.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const META = { correlationId: "c", causationId: "k", actor: "test" };
const BOT = `bot:${MARKET_1}`;

async function tenantOf(store: MemoryStore, tenantId = TENANT_A): Promise<TenantStore> {
  await store.repositories.tenants.provision(tenantId, NOW);
  const tenant = await store.forTenant(tenantId);
  if (!tenant) throw new Error("the tenant was just registered");
  return tenant;
}

const granted = (grantId: string, amountMicro = 5_000_000): LedgerEvent => ({ type: "CreditsGranted", data: { grantId, amountMicro, reason: "test" } });

const user = (userId: string, overrides: Partial<AccountState> = {}): AccountState => ({
  streamId: `account:${userId}`,
  kind: "user",
  ownerId: userId,
  marketId: null,
  balanceMicro: 10,
  positions: {},
  version: 1,
  ...overrides,
});

const bot = (overrides: Partial<AccountState> = {}): AccountState => ({ streamId: BOT, kind: "bot", ownerId: "admin-1", marketId: MARKET_1, balanceMicro: 0, positions: { [MARKET_1]: { yesMicro: 9, noMicro: 9 } }, version: 1, ...overrides });

const message = (id: string, seconds: number): OutboxMessage => ({
  id,
  aggregateId: "market-1",
  subject: `chance.trading.MarketFunded.${TENANT_A}`,
  type: "si.chance.trading.MarketFunded.v1",
  payload: {
    specversion: "1.0",
    id,
    source: "/chance/trading",
    type: "si.chance.trading.MarketFunded.v1",
    subject: "market/market-1",
    time: at(seconds).toISOString(),
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "c",
    causationid: "k",
    data: {},
  },
  createdAt: at(seconds),
});

describe("MemoryStore: tenants", () => {
  it("answers null for a tenant that has no schema, registers one on provision and lists the registry", async () => {
    const store = new MemoryStore();
    expect(await store.forTenant(TENANT_A)).toBeNull();

    await store.repositories.tenants.provision(TENANT_A, NOW);
    await store.repositories.tenants.provision(TENANT_A, NOW);
    await store.repositories.tenants.provision(TENANT_B, NOW);

    expect(await store.repositories.tenants.isRegistered(TENANT_A)).toBe(true);
    expect(await store.repositories.tenants.list()).toEqual([TENANT_A, TENANT_B]);
    expect((await store.forTenant(TENANT_A))?.tenantId).toBe(TENANT_A);
  });

  it("ensureTenant provisions an unknown tenant and returns its store", async () => {
    const store = new MemoryStore();

    const tenant = await store.ensureTenant(TENANT_A);
    await store.ensureTenant(TENANT_A);

    expect(tenant.tenantId).toBe(TENANT_A);
    expect(store.snapshot().tenants).toEqual([TENANT_A]);
    expect(Object.keys(store.snapshot().tenantData)).toEqual([TENANT_A]);
  });

  it("with autoProvision registers a tenant on its first use and logs it once", async () => {
    const logger = new RecordingLogger();
    const store = new MemoryStore({ autoProvision: true, logger });

    await store.forTenant(TENANT_A);
    await store.forTenant(TENANT_A);
    await store.forTenant(TENANT_B);

    expect(store.snapshot().tenants).toEqual([TENANT_A, TENANT_B]);
    expect(logger.lines).toEqual([
      expect.objectContaining({ level: "info", message: "APP_ENV=local: tenant provisioned on first use", fields: { tenantId: TENANT_A } }),
      expect.objectContaining({ level: "info", fields: { tenantId: TENANT_B } }),
    ]);
    expect(await new MemoryStore({ autoProvision: true }).forTenant(TENANT_A)).not.toBeNull();
  });

  it("keeps the data of one tenant invisible to the store of another", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store, TENANT_A);
    const b = await tenantOf(store, TENANT_B);
    await a.repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1")], meta: META, recordedAt: NOW });
    await a.repositories.accounts.save(user("u1"), NOW);

    expect(await b.repositories.ledger.readAll(0, 10)).toEqual([]);
    expect(await b.repositories.accounts.load("account:u1")).toBeNull();
    // The same business key is free in the other tenant's table.
    await b.repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1")], meta: META, recordedAt: NOW });
  });
});

describe("MemoryStore: ledger", () => {
  it("appends events with positions, versions and business keys, and hands out copies", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);

    const first = await repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1"), granted("g2")], meta: META, recordedAt: at(1) });
    const second = await repositories.ledger.append({ streamId: BOT, expectedVersion: 0, events: [{ type: "BotFunded", data: { marketId: MARKET_1, creatorId: "admin-1", amountMicro: 9 } }], meta: META, recordedAt: at(2) });

    expect(first.map((event) => [event.position, event.version, event.businessKey])).toEqual([[1, 1, "g1"], [2, 2, "g2"]]);
    expect(second[0]).toMatchObject({ position: 3, version: 1, businessKey: MARKET_1, streamId: BOT, recordedAt: at(2) });
    first[0]!.meta.actor = "changed";
    expect((await repositories.ledger.readStream("account:u1"))[0]?.meta.actor).toBe("test");
  });

  it("refuses an append on a version another append took, and an event whose business key exists (LedgerConflict)", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    await repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1")], meta: META, recordedAt: NOW });

    await expect(repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g2")], meta: META, recordedAt: NOW })).rejects.toMatchObject({ reason: "version", streamId: "account:u1" });
    await expect(repositories.ledger.append({ streamId: "account:u2", expectedVersion: 0, events: [granted("g1")], meta: META, recordedAt: NOW })).rejects.toMatchObject({ reason: "business_key" });
    await expect(repositories.ledger.append({ streamId: "account:u2", expectedVersion: 0, events: [granted("g3"), granted("g3")], meta: META, recordedAt: NOW })).rejects.toBeInstanceOf(LedgerConflict);

    expect(await repositories.ledger.readAll(0, 10)).toHaveLength(1);
  });

  it("refuses a stream id that is not one of ours and meta without its keys, as the table's CHECKs would", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);

    await expect(repositories.ledger.append({ streamId: "other:1", expectedVersion: 0, events: [granted("g1")], meta: META, recordedAt: NOW })).rejects.toThrow("not one of ours");
    await expect(repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1")], meta: { correlationId: "c" } as never, recordedAt: NOW })).rejects.toThrow("meta needs");
  });

  it("reads a stream by version, filtered by type, capped and newest first on request; finds by key; reads after a position", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    await repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1"), { type: "DepositCredited", data: { depositId: "d1", amountMicro: 3 } }, granted("g2")], meta: META, recordedAt: NOW });

    expect((await repositories.ledger.readStream("account:u1")).map((event) => event.version)).toEqual([1, 2, 3]);
    expect((await repositories.ledger.readStream("account:u1", { order: "desc", limit: 2 })).map((event) => event.version)).toEqual([3, 2]);
    expect((await repositories.ledger.readStream("account:u1", { types: ["CreditsGranted"] })).map((event) => event.businessKey)).toEqual(["g1", "g2"]);
    expect((await repositories.ledger.findByKey("DepositCredited", "d1"))?.version).toBe(2);
    expect(await repositories.ledger.findByKey("DepositCredited", "nope")).toBeNull();
    expect((await repositories.ledger.readAll(1, 1)).map((event) => event.position)).toEqual([2]);
    await expect(repositories.ledger.lockForReplay()).resolves.toBeUndefined();
  });
});

describe("MemoryStore: accounts and positions", () => {
  it("saves absolute values, loads positions of the wanted markets only, and deletes a position with no shares", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);

    await repositories.accounts.save(user("u1", { positions: { [MARKET_1]: { yesMicro: 4, noMicro: 0 }, [MARKET_2]: { yesMicro: 0, noMicro: 6 } } }), NOW);

    expect((await repositories.accounts.load("account:u1"))?.positions).toEqual({ [MARKET_1]: { yesMicro: 4, noMicro: 0 }, [MARKET_2]: { yesMicro: 0, noMicro: 6 } });
    expect((await repositories.accounts.load("account:u1", { marketIds: [MARKET_2] }))?.positions).toEqual({ [MARKET_2]: { yesMicro: 0, noMicro: 6 } });
    expect((await repositories.accounts.load("account:u1", { marketIds: [] }))?.positions).toEqual({});
    expect(await repositories.accounts.load("account:nobody")).toBeNull();

    await repositories.accounts.save(user("u1", { balanceMicro: 77, version: 2, positions: { [MARKET_1]: { yesMicro: 0, noMicro: 0 } } }), NOW);
    const loaded = await repositories.accounts.load("account:u1");
    expect(loaded).toMatchObject({ balanceMicro: 77, version: 2 });
    // An empty positions object leaves the stored ones alone; only the positions named are written.
    expect(loaded?.positions).toEqual({ [MARKET_2]: { yesMicro: 0, noMicro: 6 } });
  });

  it("refuses what the CHECKs of the tables refuse", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);

    await expect(repositories.accounts.save(user("u1", { balanceMicro: -1 }), NOW)).rejects.toThrow("balance");
    await expect(repositories.accounts.save(user("u1", { version: 0 }), NOW)).rejects.toThrow("version");
    await expect(repositories.accounts.save(user("u1", { marketId: MARKET_1 }), NOW)).rejects.toThrow("only a bot account has a market");
    await expect(repositories.accounts.save(bot({ marketId: null }), NOW)).rejects.toThrow("only a bot account has a market");
    await expect(repositories.accounts.save(user("u1", { positions: { [MARKET_1]: { yesMicro: -1, noMicro: 0 } } }), NOW)).rejects.toThrow("negative");
    expect(await repositories.accounts.all()).toEqual([]);
  });

  it("returns the holders of a market: users with a position, never the bot account, plus the streams named, each once, by stream id", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    await repositories.accounts.save(bot(), NOW);
    await repositories.accounts.save(user("b-holder", { positions: { [MARKET_1]: { yesMicro: 1, noMicro: 0 }, [MARKET_2]: { yesMicro: 2, noMicro: 0 } } }), NOW);
    await repositories.accounts.save(user("a-holder", { positions: { [MARKET_1]: { yesMicro: 0, noMicro: 3 } } }), NOW);
    await repositories.accounts.save(user("c-other-market", { positions: { [MARKET_2]: { yesMicro: 5, noMicro: 0 } } }), NOW);
    await repositories.accounts.save(user("creator"), NOW);

    const holders = await repositories.accounts.holdersOf(MARKET_1, { lock: true, alsoStreamIds: ["account:creator", "account:a-holder", "account:ghost"] });

    expect(holders.map((holder) => holder.streamId)).toEqual(["account:a-holder", "account:b-holder", "account:creator"]);
    expect(holders[1]?.positions).toEqual({ [MARKET_1]: { yesMicro: 1, noMicro: 0 } });
    expect(holders[2]?.positions).toEqual({});
    expect((await repositories.accounts.holdersOf(MARKET_1)).map((holder) => holder.streamId)).toEqual(["account:a-holder", "account:b-holder"]);
  });

  it("lists the bot accounts of an owner, every account sorted, and clears them all", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    await repositories.accounts.save(user("u2"), NOW);
    await repositories.accounts.save(bot(), NOW);
    await repositories.accounts.save(bot({ streamId: `bot:${MARKET_2}`, marketId: MARKET_2, ownerId: "admin-2", positions: {} }), NOW);
    await repositories.accounts.save(user("u1"), NOW);

    expect((await repositories.accounts.botAccountsOwnedBy("admin-1")).map((account) => account.streamId)).toEqual([BOT]);
    expect((await repositories.accounts.all()).map((account) => account.streamId)).toEqual(["account:u1", "account:u2", BOT, `bot:${MARKET_2}`]);

    await repositories.accounts.clear();

    expect(await repositories.accounts.all()).toEqual([]);
  });
});

describe("MemoryStore: market copies and offers", () => {
  const funded = (marketId = MARKET_1): MarketState => newFundedMarket(marketId, "admin-1", 5_000_000, NOW);

  it("inserts once (false for a repeat), updates, lists by status after an id and finds many", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);

    expect(await repositories.marketStates.insert(funded(MARKET_2))).toBe(true);
    expect(await repositories.marketStates.insert(funded(MARKET_2))).toBe(false);
    expect(await repositories.marketStates.insert(funded(MARKET_1))).toBe(true);
    await repositories.marketStates.update({ ...funded(MARKET_1), status: "open", version: 1 });

    expect((await repositories.marketStates.find(MARKET_1))?.status).toBe("open");
    expect(await repositories.marketStates.find("nope")).toBeNull();
    expect((await repositories.marketStates.listByStatus("funded", { limit: 10, afterId: null })).map((market) => market.marketId)).toEqual([MARKET_2]);
    expect((await repositories.marketStates.listByStatus("open", { limit: 10, afterId: null })).map((market) => market.marketId)).toEqual([MARKET_1]);
    expect(await repositories.marketStates.listByStatus("open", { limit: 10, afterId: MARKET_1 })).toEqual([]);
    expect((await repositories.marketStates.findMany([MARKET_2, "nope", MARKET_1])).map((market) => market.marketId)).toEqual([MARKET_1, MARKET_2]);
    await expect(repositories.marketStates.update(funded("018f3c1e-7a00-7000-8000-000000000999"))).rejects.toThrow("no row to update");
  });

  it("refuses what the CHECKs of market_state refuse", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    const insert = (changes: Partial<MarketState>) => repositories.marketStates.insert({ ...funded(), ...changes });

    await expect(insert({ outcome: "YES" })).rejects.toThrow("outcome");
    await expect(insert({ status: "resolved" })).rejects.toThrow("outcome");
    await expect(insert({ settledAt: NOW })).rejects.toThrow("settled");
    await expect(insert({ tradeSequence: -1 })).rejects.toThrow("trade sequence");
    await expect(insert({ fundingMicro: 0 })).rejects.toThrow("funding");
    await expect(insert({ startingPriceMicro: 405_000 })).rejects.toThrow("grid");
    await expect(insert({ question: "" })).rejects.toThrow("question");
    await expect(insert({ question: "q".repeat(201) })).rejects.toThrow("question");
    await expect(insert({ status: "gone" as never })).rejects.toThrow("Unknown market status");
    expect(await insert({ status: "resolved", outcome: "NO", settledAt: NOW })).toBe(true);
  });

  it("keeps one book per market, sorted, priced on a sequence, and an empty replacement leaves no book", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    await repositories.marketStates.insert(funded());

    expect(await repositories.botOrders.get(MARKET_1)).toEqual({ marketId: MARKET_1, offers: [], pricedOnSequence: null, placedAt: null });
    await repositories.botOrders.replace(MARKET_1, [{ side: "NO", priceMicro: 600_000, sharesMicro: 5 }, { side: "YES", priceMicro: 400_000, sharesMicro: 7 }], 3, at(9));

    expect(await repositories.botOrders.get(MARKET_1)).toEqual({
      marketId: MARKET_1,
      offers: [{ side: "YES", priceMicro: 400_000, sharesMicro: 7 }, { side: "NO", priceMicro: 600_000, sharesMicro: 5 }],
      pricedOnSequence: 3,
      placedAt: at(9),
    });
    await repositories.botOrders.replace(MARKET_1, [], null, at(10));
    expect((await repositories.botOrders.get(MARKET_1)).offers).toEqual([]);
    await repositories.botOrders.replace(MARKET_1, [{ side: "YES", priceMicro: 400_000, sharesMicro: 7 }], 4, at(11));
    await repositories.botOrders.clear(MARKET_1);
    await repositories.botOrders.clear(MARKET_2);
    expect(store.snapshot().tenantData[TENANT_A]?.botOrders).toEqual([]);
  });

  it("refuses offers of a market without a copy and offers that break a CHECK or the key", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    const offer = { side: "YES" as const, priceMicro: 400_000, sharesMicro: 7 };

    await expect(repositories.botOrders.replace(MARKET_1, [offer], 0, NOW)).rejects.toThrow("no market_state row");
    await repositories.marketStates.insert(funded());
    await expect(repositories.botOrders.replace(MARKET_1, [{ ...offer, priceMicro: 405_000 }], 0, NOW)).rejects.toThrow("CHECK");
    await expect(repositories.botOrders.replace(MARKET_1, [{ ...offer, sharesMicro: 0 }], 0, NOW)).rejects.toThrow("CHECK");
    await expect(repositories.botOrders.replace(MARKET_1, [{ ...offer, side: "MAYBE" as never }], 0, NOW)).rejects.toThrow("CHECK");
    await expect(repositories.botOrders.replace(MARKET_1, [offer, offer], 0, NOW)).rejects.toThrow("share the key");
  });
});

describe("MemoryStore: idempotency keys", () => {
  const claim = { scope: "order:u1", key: "key-0001", requestHash: "h1", now: NOW };

  it("claims a new key, answers a completed one with its stored result (as JSON) or a mismatch", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);

    expect(await repositories.idempotency.claim(claim)).toEqual({ kind: "claimed" });
    await expect(repositories.idempotency.claim(claim)).rejects.toThrow("claimed by this transaction already");
    await repositories.idempotency.complete("order:u1", "key-0001", { when: at(5), n: 1 });

    expect(await repositories.idempotency.claim({ ...claim, now: at(99) })).toEqual({ kind: "replay", result: { when: at(5).toISOString(), n: 1 }, createdAt: NOW });
    expect(await repositories.idempotency.claim({ ...claim, requestHash: "h2" })).toEqual({ kind: "mismatch" });
    await expect(repositories.idempotency.complete("order:u1", "other-key", {})).rejects.toThrow("was not claimed");
  });

  it("drops a claim whose transaction fails, and purges old keys of one scope prefix only", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    await expect(
      tenant.transaction(async (repositories) => {
        await repositories.idempotency.claim(claim);
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(store.snapshot().tenantData[TENANT_A]?.idempotency).toEqual([]);

    const { repositories } = tenant;
    for (const [scope, key, seconds] of [["order:u1", "key-0001", 0], ["order:u2", "key-0002", 100], ["funding", "m-1", 0]] as const) {
      await repositories.idempotency.claim({ scope, key, requestHash: "h", now: at(seconds) });
      await repositories.idempotency.complete(scope, key, {});
    }

    expect(await repositories.idempotency.purge("order:", at(50))).toBe(1);
    expect(store.snapshot().tenantData[TENANT_A]?.idempotency.map((row) => row.scope)).toEqual(["order:u2", "funding"]);
  });
});

describe("MemoryStore: shared tables", () => {
  it("claims unpublished outbox rows in the order of writing, whatever their created time says, as copies, marks them, and purges published ones older than the cut-off", async () => {
    const store = new MemoryStore();
    // The second row carries an earlier time stamp than the first: an order that read the clock before it waited for the market lock.
    for (const [id, seconds] of [["late", 30], ["early", 10], ["middle", 20], ["failing", 40]] as const) await store.repositories.outbox.add(message(id, seconds));

    const claimed = await store.repositories.outbox.claimBatch(3);
    claimed[0]!.attempts = 99;
    expect(claimed.map((row) => row.id)).toEqual(["late", "early", "middle"]);
    expect(store.snapshot().outbox.find((row) => row.id === "late")?.attempts).toBe(0);

    await store.repositories.outbox.markPublished("late", at(100));
    await store.repositories.outbox.markPublished("middle", at(200));
    await store.repositories.outbox.markPublished("missing", at(1));
    await store.repositories.outbox.markFailed("failing", "broker down");
    await store.repositories.outbox.markFailed("failing", "broker down again");
    await store.repositories.outbox.markFailed("missing", "x");

    expect((await store.repositories.outbox.claimBatch(10)).map((row) => row.id)).toEqual(["early", "failing"]);
    expect(store.snapshot().outbox.find((row) => row.id === "failing")).toMatchObject({ attempts: 2, lastError: "broker down again" });
    expect(await store.repositories.outbox.purgePublished(at(150))).toBe(1);
    expect(store.snapshot().outbox.map((row) => row.id).sort()).toEqual(["early", "failing", "middle"]);
  });

  it("records an inbox entry once per consumer and event id, and purges the old ones", async () => {
    const store = new MemoryStore();
    const entry = (consumer: string, eventId: string, seconds: number) => ({ consumer, eventId, eventType: "t", processedAt: at(seconds) });

    expect(await store.repositories.inbox.record(entry("market-events", "e1", 10))).toBe(true);
    expect(await store.repositories.inbox.record(entry("market-events", "e1", 99))).toBe(false);
    expect(await store.repositories.inbox.record(entry("payment-events", "e1", 20))).toBe(true);
    expect(await store.repositories.inbox.record(entry("market-events", "e2", 30))).toBe(true);

    expect(await store.repositories.inbox.purge(at(25))).toBe(2);
    expect(store.snapshot().inbox.map((row) => `${row.consumer}/${row.eventId}`)).toEqual(["market-events/e2"]);
  });

  it("remembers the tenant of a market and of a withdrawal for good, and refuses an unregistered tenant (foreign key)", async () => {
    const store = new MemoryStore();
    await store.repositories.tenants.provision(TENANT_A, NOW);
    await store.repositories.tenants.provision(TENANT_B, NOW);

    expect(await store.repositories.marketDirectory.tenantOf(MARKET_1)).toBeNull();
    expect(await store.repositories.marketDirectory.register(MARKET_1, TENANT_A, NOW)).toBe(TENANT_A);
    expect(await store.repositories.marketDirectory.register(MARKET_1, TENANT_B, NOW)).toBe(TENANT_A);
    expect(await store.repositories.marketDirectory.tenantOf(MARKET_1)).toBe(TENANT_A);
    expect(await store.repositories.withdrawalDirectory.register("w-1", TENANT_B, NOW)).toBe(TENANT_B);
    expect(await store.repositories.withdrawalDirectory.register("w-1", TENANT_A, NOW)).toBe(TENANT_B);
    await expect(store.repositories.marketDirectory.register(MARKET_2, "018f3c1e-7a00-7000-8000-0000000000cc", NOW)).rejects.toThrow("not registered");
    await expect(store.repositories.withdrawalDirectory.register("w-2", "018f3c1e-7a00-7000-8000-0000000000cc", NOW)).rejects.toThrow("not registered");
  });

  it("parks an event once per consumer and stream sequence (an upsert), lists oldest first and removes it", async () => {
    const store = new MemoryStore();
    const parked = (consumer: string, streamSequence: number, seconds: number, reason = "boom") => ({ consumer, streamSequence, subject: "s", payload: "{}", reason, deliveries: 20, parkedAt: at(seconds) });

    await store.repositories.parkedEvents.park(parked("market-events", 7, 30));
    await store.repositories.parkedEvents.park(parked("payment-events", 3, 10));
    await store.repositories.parkedEvents.park({ ...parked("market-events", 7, 40, "again"), deliveries: 25 });

    expect((await store.repositories.parkedEvents.list(null, 10)).map((row) => [row.consumer, row.streamSequence, row.reason, row.deliveries])).toEqual([
      ["payment-events", 3, "boom", 20],
      ["market-events", 7, "again", 25],
    ]);
    expect((await store.repositories.parkedEvents.list("market-events", 10)).map((row) => row.streamSequence)).toEqual([7]);
    expect(await store.repositories.parkedEvents.list(null, 1)).toHaveLength(1);
    await store.repositories.parkedEvents.remove("market-events", 7);
    await store.repositories.parkedEvents.remove("market-events", 99);
    expect(store.snapshot().parked.map((row) => row.consumer)).toEqual(["payment-events"]);
  });

  it("never overwrites a parked event with a different message that reuses its stream sequence", async () => {
    const store = new MemoryStore();
    const parked = (payload: string, reason: string) => ({ consumer: "payment-events", streamSequence: 7, subject: "s", payload, reason, deliveries: 20, parkedAt: at(10) });
    await store.repositories.parkedEvents.park(parked("{\"deposit\":1}", "first"));

    await expect(store.repositories.parkedEvents.park(parked("{\"deposit\":2}", "second"))).rejects.toThrow("A different event is already parked under payment-events #7");

    expect(store.snapshot().parked).toEqual([parked("{\"deposit\":1}", "first")]);
    await store.repositories.parkedEvents.park(parked("{\"deposit\":1}", "first again"));
    expect(store.snapshot().parked.map((row) => row.reason)).toEqual(["first again"]);
  });
});

describe("MemoryStore: transactions", () => {
  it("commits what the callback wrote, and leaves nothing behind when it fails", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);

    await tenant.transaction(async (repositories) => {
      await repositories.ledger.append({ streamId: "account:u1", expectedVersion: 0, events: [granted("g1")], meta: META, recordedAt: NOW });
      await repositories.outbox.add(message("event-1", 1));
    });
    await expect(
      tenant.transaction(async (repositories) => {
        await repositories.ledger.append({ streamId: "account:u2", expectedVersion: 0, events: [granted("g2")], meta: META, recordedAt: NOW });
        await repositories.outbox.add(message("event-2", 2));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(store.snapshot().tenantData[TENANT_A]?.ledger.map((event) => event.businessKey)).toEqual(["g1"]);
    expect(store.snapshot().outbox.map((row) => row.id)).toEqual(["event-1"]);
  });

  it("runs the shared transaction as one unit too, one by one, and keeps working after a failure", async () => {
    const store = new MemoryStore();

    await expect(
      store.transaction(async (repositories) => {
        await repositories.tenants.provision(TENANT_A, NOW);
        await repositories.inbox.record({ consumer: "c", eventId: "e", eventType: "t", processedAt: NOW });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.snapshot()).toMatchObject({ tenants: [], inbox: [], tenantData: {} });

    const counted = async () =>
      store.transaction(async (repositories) => {
        const seen = (await repositories.tenants.list()).length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await repositories.tenants.provision(`018f3c1e-7a00-7000-8000-0000000000${seen}0`, NOW);
        return seen;
      });
    expect(await Promise.all([counted(), counted(), counted()])).toEqual([0, 1, 2]);
    await expect(store.ping()).resolves.toBeUndefined();
  });

  it("makes a call outside a transaction wait for the one in progress, so that its write is not lost", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = tenant.transaction(async (repositories) => {
      await repositories.outbox.add(message("inside", 1));
      await gate;
    });
    let outsideDone = false;
    const outside = store.repositories.outbox.add(message("outside", 2)).then(() => (outsideDone = true));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outsideDone).toBe(false);
    release();
    await Promise.all([running, outside]);

    expect(store.snapshot().outbox.map((row) => row.id).sort()).toEqual(["inside", "outside"]);
  });

  it("hands out copies: a changed result or snapshot changes nothing in the store", async () => {
    const store = new MemoryStore();
    const { repositories } = await tenantOf(store);
    await repositories.marketStates.insert(newFundedMarket(MARKET_1, "admin-1", 5_000_000, NOW));

    const read = await repositories.marketStates.find(MARKET_1);
    read?.fundedAt?.setUTCFullYear(2030);
    store.snapshot().tenantData[TENANT_A]?.marketStates.splice(0);

    expect((await repositories.marketStates.find(MARKET_1))?.fundedAt?.toISOString()).toBe(NOW.toISOString());
  });
});
