import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { OutboxRelay } from "../../src/adapters/outbox/relay.js";
import { MIGRATIONS_DIRS, listTenantSchemas, migrateTenantSchema, runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { decideDeposit, decideFunding } from "../../src/domain/accounts.js";
import { botStreamId, emptyBotAccount, emptyUserAccount, nonEmptyPositions, replayStream, userStreamId } from "../../src/domain/ledger.js";
import type { AccountState, LedgerEvent, LedgerMeta } from "../../src/domain/ledger.js";
import { applyOpened, newFundedMarket, withTrade } from "../../src/domain/market-state.js";
import type { MarketState } from "../../src/domain/market-state.js";
import { decideBuy } from "../../src/domain/order-book.js";
import type { Offer } from "../../src/domain/order-book.js";
import { tenantSchemaIdentifier, tenantSchemaName } from "../../src/domain/tenant.js";
import { creditsToMicro } from "../../src/domain/units.js";
import { LedgerConflict } from "../../src/usecases/errors.js";
import type { TenantRepositories, TenantStore } from "../../src/usecases/ports.js";
import { withConflictRetry } from "../../src/usecases/support.js";
import { RecordingLogger, SequentialIds } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They are not part of "npm test". One PostgreSQL 18
// container serves the whole file; every test that needs rows uses a tenant (schema) of its own, so tests never see each
// other's data.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
let extraDir: string;
const logger = new RecordingLogger();
const now = new Date("2026-11-01T10:00:00.000Z");
const meta: LedgerMeta = { correlationId: "corr-1", causationId: "req-1", actor: "system" };
const tenantIds = Array.from({ length: 13 }, (_, index) => `00000000-0000-7000-8000-0000000000${(index + 1).toString(16).padStart(2, "0")}`);
const T = (n: number): string => tenantIds[n - 1] as string;
const marketId = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** The tenant migrations of the service, in order (002: UC-16, the INVALID outcome). */
const TENANT_FILES = ["001_init.sql", "002_invalid_outcome.sql", "003_sales.sql"];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("trading").start();
  pool = createPool(container.getConnectionUri(), 12, logger);
  extraDir = await mkdtemp(join(tmpdir(), "trading-tenant-migrations-"));
  for (const file of TENANT_FILES) await copyFile(fileURLToPath(new URL(file, MIGRATIONS_DIRS.tenant)), join(extraDir, file));
  store = new PostgresStore(pool, logger);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (extraDir) await rm(extraDir, { recursive: true, force: true });
});

const columns = async (schema: string, table: string): Promise<string[]> =>
  (
    await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [schema, table],
    )
  ).rows.map((row) => row.column_name);

const tablesOf = async (schema: string): Promise<string[]> =>
  (
    await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name", [schema])
  ).rows.map((row) => row.table_name);

/** "23514:ledger_events_version_positive": the SQLSTATE and the constraint (or column) a statement violated, or "none". */
const violation = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    const { code, constraint, column } = error as { code?: string; constraint?: string; column?: string };
    return `${code ?? "no code"}:${constraint ?? column ?? ""}`;
  }
  return "none";
};

const tenantStore = (tenantId: string): Promise<TenantStore> => store.ensureTenant(tenantId, now);

// ---- Scenario helpers (the shapes of the use cases, written on the repositories) -----------------------------------------

async function deposit(tenant: TenantStore, userId: string, credits: number, depositId: string): Promise<void> {
  await withConflictRetry(() =>
    tenant.transaction(async (r) => {
      const account = (await r.accounts.load(userStreamId(userId), { lock: true })) ?? emptyUserAccount(userId);
      const decision = decideDeposit(account, { depositId, credits });
      await r.ledger.append({ streamId: decision.streamId, expectedVersion: decision.expectedVersion, events: decision.events, meta, recordedAt: now });
      await r.accounts.save(decision.next, now);
    }),
  );
}

const YES_OFFER: Offer = { side: "YES", priceMicro: 500_000, sharesMicro: 1_000_000_000 };

/** A funded and open market with the creator's funding in the bot account and `offers` resting. */
async function openFundedMarket(tenant: TenantStore, id: string, creatorId: string, credits: number, offers: Offer[] = [YES_OFFER]): Promise<void> {
  await tenant.transaction(async (r) => {
    const funded = newFundedMarket(id, creatorId, creditsToMicro(credits), now);
    const open = applyOpened(
      funded,
      { marketId: id, version: 1, question: "Will the new bridge open before 2027?", closeTime: new Date(now.getTime() + 86_400_000), startingPriceMicro: 500_000, creatorId, openedAt: now },
      now,
    ).state;
    expect(await r.marketStates.insert(open)).toBe(true);
    const creator = (await r.accounts.load(userStreamId(creatorId), { lock: true })) ?? emptyUserAccount(creatorId);
    const funding = decideFunding(creator, emptyBotAccount(id, creatorId), { marketId: id, creatorId, credits });
    for (const part of [funding.creator, funding.bot]) {
      await r.ledger.append({ streamId: part.streamId, expectedVersion: part.expectedVersion, events: part.events, meta, recordedAt: now });
      await r.accounts.save(part.next, now);
    }
    await r.botOrders.replace(id, offers, 0, now);
  });
}

/** What PlaceOrder does, on the repositories: lock order market_state, bot, trader; one trade; projections; offers. */
async function buy(tenant: TenantStore, id: string, userId: string, credits: number, tradeId: string): Promise<void> {
  await withConflictRetry(() =>
    tenant.transaction(async (r) => {
      const market = await r.marketStates.find(id, { lock: true });
      if (market === null) throw new Error("no market");
      const book = await r.botOrders.get(id);
      const bot = await r.accounts.load(botStreamId(id), { lock: true, marketIds: [id] });
      if (bot === null) throw new Error("no bot account");
      const trader = (await r.accounts.load(userStreamId(userId), { lock: true, marketIds: [id] })) ?? emptyUserAccount(userId);
      const decision = decideBuy({ trader, bot, marketId: id, side: "YES", credits, maxAveragePriceMicro: null, offers: book.offers, tradeId, tradeSequence: market.tradeSequence + 1 });
      for (const part of [decision.bot, decision.trader]) {
        await r.ledger.append({ streamId: part.streamId, expectedVersion: part.expectedVersion, events: part.events, meta: { ...meta, actor: userId }, recordedAt: now });
        await r.accounts.save(part.next, now);
      }
      await r.botOrders.replace(id, decision.plan.remaining, book.pricedOnSequence, now);
      await r.marketStates.update(withTrade(market, now));
    }),
  );
}

/** The differences between the projections and the fold of the ledger, as one replay computes them (empty when equal). */
async function replayDifferences(tenant: TenantStore, rebuild = false): Promise<string[]> {
  return tenant.transaction(async (r) => {
    await r.ledger.lockForReplay();
    const byStream = new Map<string, Awaited<ReturnType<typeof r.ledger.readAll>>>();
    for (let after = 0; ; ) {
      const batch = await r.ledger.readAll(after, 2);
      const last = batch.at(-1);
      if (last === undefined) break;
      for (const event of batch) byStream.set(event.streamId, [...(byStream.get(event.streamId) ?? []), event]);
      after = last.position;
    }
    const replayed = new Map<string, AccountState>([...byStream].map(([streamId, events]) => [streamId, replayStream(streamId, events)]));
    const stored = new Map((await r.accounts.all()).map((account) => [account.streamId, account]));
    const differences: string[] = [];
    for (const streamId of new Set([...replayed.keys(), ...stored.keys()])) {
      const a = replayed.get(streamId);
      const b = stored.get(streamId);
      if (a === undefined || b === undefined) differences.push(`${streamId}: only in ${a === undefined ? "the projection" : "the ledger"}`);
      else if (a.balanceMicro !== b.balanceMicro || a.version !== b.version || JSON.stringify(nonEmptyPositions(a)) !== JSON.stringify(nonEmptyPositions(b))) differences.push(`${streamId}: differs`);
    }
    if (rebuild) {
      await r.accounts.clear();
      for (const account of replayed.values()) await r.accounts.save(account, now);
    }
    return differences;
  });
}

// ---- Migrations --------------------------------------------------------------------------------------------------------

describe("shared migrations", () => {
  it("create the shared tables and apply nothing on a second run", async () => {
    const first = await runMigrations(pool, logger);
    expect(first).toEqual({ shared: ["001_init.sql"], tenants: {} });
    expect(await tablesOf("shared")).toEqual(["inbox", "market_directory", "outbox", "parked_events", "schema_migrations", "tenant_registry", "withdrawal_directory"]);
    expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
  });

  it("guard the shared tables with constraints", async () => {
    const insertInbox = (consumer: string, eventId: string) =>
      pool.query("INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, 't', $3)", [consumer, eventId, now]);
    await insertInbox("market-events", "e1");
    expect(await violation(insertInbox("market-events", "e1"))).toBe("23505:inbox_pkey");
    await insertInbox("payment-events", "e1");
    expect(await violation(insertInbox("", "e2"))).toBe("23514:inbox_consumer_length");
    expect(await violation(insertInbox("market-events", ""))).toBe("23514:inbox_event_id_length");

    const register = (tenantId: string, schema: string) =>
      pool.query("INSERT INTO shared.tenant_registry (tenant_id, schema_name, created_at) VALUES ($1, $2, $3)", [tenantId, schema, now]);
    expect(await violation(register(T(1), "tenant_ffffffffffffffffffffffffffffffff"))).toBe("23514:tenant_registry_schema_matches_id");
    expect(await violation(register(T(1), "public"))).toBe("23514:tenant_registry_schema_format");

    const parked = (consumer: string, sequence: number, deliveries: number) =>
      pool.query("INSERT INTO shared.parked_events (consumer, stream_sequence, subject, payload, reason, deliveries, parked_at) VALUES ($1, $2, 's', 'p', 'r', $3, $4)", [
        consumer,
        sequence,
        deliveries,
        now,
      ]);
    await parked("market-events", 7, 20);
    expect(await violation(parked("market-events", 7, 20))).toBe("23505:parked_events_pkey");
    expect(await violation(parked("market-events", 0, 20))).toBe("23514:parked_events_stream_sequence_positive");
    expect(await violation(parked("market-events", 8, 0))).toBe("23514:parked_events_deliveries_positive");
    expect(await violation(parked("", 9, 20))).toBe("23514:parked_events_consumer_length");
    await pool.query("TRUNCATE shared.inbox, shared.parked_events");
  });

  it("refuse a file that was changed after it was applied, and leave no lock behind", async () => {
    const changed = await mkdtemp(join(tmpdir(), "trading-changed-shared-"));
    try {
      await writeFile(join(changed, "001_init.sql"), `${await readFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.shared)), "utf8")}\n-- edited\n`);
      await expect(runMigrations(pool, logger, { shared: pathToFileURL(`${changed}/`), tenant: MIGRATIONS_DIRS.tenant })).rejects.toThrow(
        "Migration 001_init.sql of schema shared was changed after it was applied",
      );
      expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
    } finally {
      await rm(changed, { recursive: true, force: true });
    }
  });

  it("let several instances start at once: one applies the files, the others find nothing to do", async () => {
    await pool.query("DROP DATABASE IF EXISTS fresh_probe WITH (FORCE)");
    await pool.query("CREATE DATABASE fresh_probe");
    const url = new URL(container.getConnectionUri());
    url.pathname = "/fresh_probe";
    const probe = createPool(url.toString(), 6, logger);
    try {
      const reports = await Promise.all([runMigrations(probe, logger), runMigrations(probe, logger), runMigrations(probe, logger)]);
      expect(reports.filter((report) => report.shared.length > 0)).toHaveLength(1);
      expect(reports.flatMap((report) => report.shared)).toEqual(["001_init.sql"]);
    } finally {
      await probe.end();
      await pool.query("DROP DATABASE IF EXISTS fresh_probe WITH (FORCE)");
    }
  });
});

describe("tenant migrations", () => {
  it("create the same tables in two tenant schemas, keep their rows apart, and apply nothing on a rerun", async () => {
    await tenantStore(T(1));
    await tenantStore(T(2));
    const tables = ["accounts", "bot_orders", "idempotency_keys", "ledger_events", "market_state", "positions", "schema_migrations"];
    expect(await tablesOf(tenantSchemaName(T(1)))).toEqual(tables);
    expect(await tablesOf(tenantSchemaName(T(2)))).toEqual(tables);
    expect(await columns(tenantSchemaName(T(1)), "ledger_events")).toEqual(["position", "stream_id", "version", "type", "business_key", "data", "meta", "recorded_at"]);
    expect((await listTenantSchemas(pool)).filter((name) => [T(1), T(2)].some((id) => tenantSchemaName(id) === name))).toEqual(
      [T(1), T(2)].map(tenantSchemaName).sort(),
    );

    await deposit(await tenantStore(T(1)), "alice", 10, marketId(901));
    expect((await (await tenantStore(T(2))).repositories.accounts.all()).length).toBe(0);
    expect((await (await tenantStore(T(1))).repositories.accounts.all()).length).toBe(1);

    expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
  });

  it("apply a new file to every registered tenant schema at startup, and refuse a changed one", async () => {
    await writeFile(join(extraDir, "003_extra.sql"), "CREATE TABLE extra_probe (id integer PRIMARY KEY);\n");
    const dirs = { shared: MIGRATIONS_DIRS.shared, tenant: pathToFileURL(`${extraDir}/`) };
    const report = await runMigrations(pool, logger, dirs);
    const registered = await listTenantSchemas(pool);
    expect(Object.keys(report.tenants).sort()).toEqual(registered);
    for (const files of Object.values(report.tenants)) expect(files).toEqual(["003_extra.sql"]);
    expect(await runMigrations(pool, logger, dirs)).toEqual({ shared: [], tenants: {} });

    await writeFile(join(extraDir, "001_init.sql"), `${await readFile(join(extraDir, "001_init.sql"), "utf8")}\n-- edited\n`);
    await expect(runMigrations(pool, logger, dirs)).rejects.toThrow("was changed after it was applied");
    await copyFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.tenant)), join(extraDir, "001_init.sql"));
    for (const schema of registered) await pool.query(`DROP TABLE "${schema}".extra_probe; DELETE FROM "${schema}".schema_migrations WHERE version = '003_extra.sql'`);
    await rm(join(extraDir, "003_extra.sql"));
  });

  it("provision a tenant once when many requests name it at the same time (ensureTenant)", async () => {
    expect(await store.forTenant(T(3))).toBeNull();
    const stores = await Promise.all(Array.from({ length: 5 }, () => store.ensureTenant(T(3), now)));
    expect(stores.map((s) => s.tenantId)).toEqual(Array(5).fill(T(3)));
    expect((await pool.query("SELECT count(*)::int AS n FROM shared.tenant_registry WHERE tenant_id = $1", [T(3)])).rows[0]).toEqual({ n: 1 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${tenantSchemaName(T(3))}".schema_migrations`)).rows[0]).toEqual({ n: TENANT_FILES.length });
    expect(await store.forTenant(T(3).toUpperCase())).not.toBeNull();
    expect(await store.forTenant("not-a-tenant")).toBeNull();
    await expect(store.ensureTenant("not-a-tenant", now)).rejects.toThrow();
    // A provision outside a transaction would run each statement on another connection: it refuses.
    await expect(store.repositories.tenants.provision(T(3), now)).rejects.toThrow("inside a transaction");
    expect(await store.repositories.tenants.list()).toContain(T(3));
  });

  it("migrate one schema on its own (migrateTenantSchema) and roll the registration back with a failed transaction", async () => {
    expect(await migrateTenantSchema(pool, T(4), now, logger)).toEqual(TENANT_FILES);
    expect(await migrateTenantSchema(pool, T(4), now, logger)).toEqual([]);
    await expect(
      store.transaction(async (repositories) => {
        await repositories.tenants.provision(T(5), now);
        throw new Error("the inbox entry could not be stored");
      }),
    ).rejects.toThrow("could not be stored");
    expect(await store.repositories.tenants.isRegistered(T(5))).toBe(false);
    expect((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [tenantSchemaName(T(5))])).rowCount).toBe(0);
  });
});

// ---- Constraints -------------------------------------------------------------------------------------------------------

describe("the ledger table", () => {
  let schema: string;
  const insert = (over: Partial<Record<"stream_id" | "version" | "type" | "business_key" | "data" | "meta", unknown>> = {}) => {
    const row = {
      stream_id: "account:alice",
      version: 1,
      type: "PairsRedeemed",
      business_key: "redemption-1/account:alice",
      data: JSON.stringify({ x: 1 }),
      meta: JSON.stringify(meta),
      ...over,
    };
    return pool.query(
      `INSERT INTO ${schema}.ledger_events (stream_id, version, type, business_key, data, meta, recorded_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [row.stream_id, row.version, row.type, row.business_key, row.data, row.meta, now],
    );
  };

  beforeAll(async () => {
    await tenantStore(T(6));
    schema = tenantSchemaIdentifier(T(6));
  });

  it("checks the stream id, the version, the type, the business key, the data and the meta", async () => {
    expect(await violation(insert())).toBe("none");
    expect(await violation(insert({ stream_id: "user:alice", business_key: "k1" }))).toBe("23514:ledger_events_stream_id_format");
    expect(await violation(insert({ stream_id: "account:", business_key: "k2" }))).toBe("23514:ledger_events_stream_id_format");
    expect(await violation(insert({ stream_id: "account:a\u0001b", business_key: "k3" }))).toBe("23514:ledger_events_stream_id_format");
    expect(await violation(insert({ stream_id: `account:${"x".repeat(256)}`, business_key: "k4" }))).toBe("23514:ledger_events_stream_id_format");
    expect(await violation(insert({ stream_id: "bot:not-a-uuid", business_key: "k5" }))).toBe("23514:ledger_events_stream_id_format");
    expect(await violation(insert({ stream_id: "bot:ABCDEF00-0000-7000-8000-000000000001", business_key: "k6" }))).toBe("23514:ledger_events_stream_id_format");
    // Accepted: a user id with non-ASCII characters and the longest one, and a bot stream.
    expect(await violation(insert({ stream_id: "account:žan-č", business_key: "k7" }))).toBe("none");
    expect(await violation(insert({ stream_id: `account:${"x".repeat(255)}`, business_key: "k8" }))).toBe("none");
    expect(await violation(insert({ stream_id: `bot:${marketId(1)}`, business_key: "k9" }))).toBe("none");
    expect(await violation(insert({ version: 0, business_key: "k10" }))).toBe("23514:ledger_events_version_positive");
    expect(await violation(insert({ type: "Mystery", business_key: "k11" }))).toBe("23514:ledger_events_type_values");
    expect(await violation(insert({ business_key: "" }))).toBe("23514:ledger_events_business_key_length");
    expect(await violation(insert({ business_key: "k".repeat(513) }))).toBe("23514:ledger_events_business_key_length");
    expect(await violation(insert({ data: "[1]", business_key: "k12" }))).toBe("23514:ledger_events_data_object");
    expect(await violation(insert({ meta: JSON.stringify({ correlationId: "c", causationId: "x" }), business_key: "k13" }))).toBe("23514:ledger_events_meta_keys");
    expect(await violation(insert({ meta: "[]", business_key: "k14" }))).toBe("23514:ledger_events_meta_keys");
  });

  it("keeps bot events on bot streams and the other events on user streams", async () => {
    expect(await violation(insert({ stream_id: "account:bob", type: "BotFunded", business_key: "m1" }))).toBe("23514:ledger_events_type_matches_stream");
    expect(await violation(insert({ stream_id: `bot:${marketId(2)}`, type: "SharesBought", business_key: "m2" }))).toBe("23514:ledger_events_type_matches_stream");
    expect(await violation(insert({ stream_id: `bot:${marketId(2)}`, type: "BotFunded", business_key: "m3" }))).toBe("none");
    expect(await violation(insert({ stream_id: "account:bob", type: "DepositCredited", business_key: "m4" }))).toBe("none");
    // UC-16 (tenant migration 002): PositionRefunded on user streams, BotVoided on bot streams.
    expect(await violation(insert({ stream_id: "account:refund-holder", type: "PositionRefunded", business_key: "m5" }))).toBe("none");
    expect(await violation(insert({ stream_id: `bot:${marketId(2)}`, type: "PositionRefunded", business_key: "m6" }))).toBe("23514:ledger_events_type_matches_stream");
    expect(await violation(insert({ stream_id: `bot:${marketId(3)}`, type: "BotVoided", business_key: "m7" }))).toBe("none");
    expect(await violation(insert({ stream_id: "account:bob", type: "BotVoided", business_key: "m8" }))).toBe("23514:ledger_events_type_matches_stream");
    expect(await violation(insert({ stream_id: "account:bob", type: "MarketVoided", business_key: "m9" }))).toBe("23514:ledger_events_type_values");
    // UC-08 (tenant migration 003): SharesSold on user streams only.
    expect(await violation(insert({ stream_id: "account:seller", type: "SharesSold", business_key: "m10" }))).toBe("none");
    expect(await violation(insert({ stream_id: `bot:${marketId(2)}`, type: "SharesSold", business_key: "m11" }))).toBe("23514:ledger_events_type_matches_stream");
  });

  it("has two uniques: (stream, version) and (type, business key), the last guard of DM-10", async () => {
    expect(await violation(insert({ stream_id: "account:carol", version: 1, business_key: "u1" }))).toBe("none");
    expect(await violation(insert({ stream_id: "account:carol", version: 1, business_key: "u2" }))).toBe("23505:ledger_events_stream_version_key");
    expect(await violation(insert({ stream_id: "account:dave", version: 1, business_key: "u1" }))).toBe("23505:ledger_events_type_business_key_key");
    // The same business key under another type is another fact.
    expect(await violation(insert({ stream_id: "account:dave", version: 1, type: "DepositCredited", business_key: "u1" }))).toBe("none");
  });

  it("refuses UPDATE, DELETE and TRUNCATE with the append-only trigger, and still takes INSERT and SELECT", async () => {
    await insert({ stream_id: "account:erin", business_key: "a1" });
    for (const statement of [
      `UPDATE ${schema}.ledger_events SET data = '{}'::jsonb WHERE stream_id = 'account:erin'`,
      `DELETE FROM ${schema}.ledger_events WHERE stream_id = 'account:erin'`,
      `TRUNCATE ${schema}.ledger_events`,
    ]) {
      const error = await pool.query(statement).then(
        () => null,
        (failure: unknown) => failure as { code?: string; message?: string },
      );
      expect(error?.code, statement).toBe("23001");
      expect(error?.message, statement).toContain("append-only");
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.ledger_events WHERE stream_id = 'account:erin'`)).rows[0]).toEqual({ n: 1 });
  });
});

describe("the projection tables", () => {
  let schema: string;
  beforeAll(async () => {
    await tenantStore(T(7));
    schema = tenantSchemaIdentifier(T(7));
  });

  const account = (over: Partial<Record<"stream_id" | "kind" | "owner_id" | "market_id" | "balance_micro" | "version", unknown>> = {}) => {
    const row = { stream_id: "account:u1", kind: "user", owner_id: "u1", market_id: null, balance_micro: 0, version: 1, ...over };
    return pool.query(
      `INSERT INTO ${schema}.accounts (stream_id, kind, owner_id, market_id, balance_micro, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [row.stream_id, row.kind, row.owner_id, row.market_id, row.balance_micro, row.version, now],
    );
  };

  it("accounts: non-negative balance, version from 1, kind and market belong together, the stream names its owner", async () => {
    expect(await violation(account())).toBe("none");
    expect(await violation(account({ stream_id: "account:u2", owner_id: "u2", balance_micro: -1 }))).toBe("23514:accounts_balance_not_negative");
    expect(await violation(account({ stream_id: "account:u2", owner_id: "u2", version: 0 }))).toBe("23514:accounts_version_positive");
    expect(await violation(account({ stream_id: "account:u2", owner_id: "u2", kind: "robot" }))).toBe("23514:accounts_kind_values");
    expect(await violation(account({ stream_id: "account:u2", owner_id: "u2", market_id: marketId(1) }))).toBe("23514:accounts_bot_iff_market");
    expect(await violation(account({ stream_id: `bot:${marketId(1)}`, kind: "bot", owner_id: "u1" }))).toBe("23514:accounts_bot_iff_market");
    expect(await violation(account({ stream_id: "account:u2", owner_id: "u3" }))).toBe("23514:accounts_user_stream_matches_owner");
    expect(await violation(account({ stream_id: "account:u2", owner_id: null }))).toBe("23514:accounts_user_stream_matches_owner");
    expect(await violation(account({ stream_id: `bot:${marketId(1)}`, kind: "bot", owner_id: "u1", market_id: marketId(2) }))).toBe("23514:accounts_bot_stream_matches_market");
    expect(await violation(account({ stream_id: "account:a\u0001", owner_id: "a\u0001" }))).toBe("23514:accounts_stream_id_format");
    expect(await violation(account({ stream_id: `bot:${marketId(1)}`, kind: "bot", owner_id: "u1", market_id: marketId(1) }))).toBe("none");
    expect(await violation(account())).toBe("23505:accounts_pkey");
  });

  it("positions: reference an account, never negative, never both zero, one row per account and market", async () => {
    const position = (streamId: string, market: string, yes: number, no: number) =>
      pool.query(`INSERT INTO ${schema}.positions (stream_id, market_id, yes_micro, no_micro, updated_at) VALUES ($1, $2, $3, $4, $5)`, [streamId, market, yes, no, now]);
    expect(await violation(position("account:u1", marketId(1), 5, 0))).toBe("none");
    expect(await violation(position("account:u1", marketId(1), 5, 0))).toBe("23505:positions_pkey");
    expect(await violation(position("account:ghost", marketId(1), 5, 0))).toBe("23503:positions_stream_id_fkey");
    expect(await violation(position("account:u1", marketId(2), -1, 5))).toBe("23514:positions_yes_not_negative");
    expect(await violation(position("account:u1", marketId(2), 5, -1))).toBe("23514:positions_no_not_negative");
    expect(await violation(position("account:u1", marketId(2), 0, 0))).toBe("23514:positions_not_empty");
  });

  const marketRow = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { market_id: marketId(10), version: 0, status: "funded", trade_sequence: 0, updated_at: now, ...over };
    const keys = Object.keys(row);
    return pool.query(`INSERT INTO ${schema}.market_state (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${String(i + 1)}`).join(", ")})`, Object.values(row));
  };

  it("market_state: status values, outcome exactly when resolved, settled only when resolved, grids and limits", async () => {
    expect(await violation(marketRow())).toBe("none");
    expect(await violation(marketRow())).toBe("23505:market_state_pkey");
    const other = (over: Record<string, unknown>) => marketRow({ market_id: marketId(11), ...over });
    expect(await violation(other({ status: "paused" }))).toBe("23514:market_state_status_values");
    expect(await violation(other({ status: "open", outcome: "YES" }))).toBe("23514:market_state_outcome_iff_resolved");
    expect(await violation(other({ status: "resolved" }))).toBe("23514:market_state_outcome_iff_resolved");
    expect(await violation(other({ status: "resolved", outcome: "MAYBE" }))).toBe("23514:market_state_outcome_values");
    expect(await violation(other({ status: "resolved", outcome: "invalid" }))).toBe("23514:market_state_outcome_values");
    expect(await violation(other({ status: "open", settled_at: now }))).toBe("23514:market_state_settled_only_resolved");
    expect(await violation(other({ question: "" }))).toBe("23514:market_state_question_length");
    expect(await violation(other({ question: "q".repeat(201) }))).toBe("23514:market_state_question_length");
    expect(await violation(other({ starting_price_micro: 15_000 }))).toBe("23514:market_state_starting_price_grid");
    expect(await violation(other({ starting_price_micro: 1_000_000 }))).toBe("23514:market_state_starting_price_grid");
    expect(await violation(other({ funding_micro: 0 }))).toBe("23514:market_state_funding_positive");
    expect(await violation(other({ trade_sequence: -1 }))).toBe("23514:market_state_trade_sequence_not_negative");
    expect(await violation(other({ version: -1 }))).toBe("23514:market_state_version_not_negative");
    expect(await violation(other({ payout_total_micro: -1 }))).toBe("23514:market_state_payout_not_negative");
    expect(await violation(other({ creator_id: "" }))).toBe("23514:market_state_creator_id_length");
    expect(await violation(other({ status: "resolved", outcome: "NO", settled_at: now, starting_price_micro: 990_000, funding_micro: 5_000_000_000_000 }))).toBe("none");
  });

  it("bot_orders: reference a market copy, side, price grid, positive shares, one offer per side and price", async () => {
    const offer = (market: string, side: string, price: number, shares: number) =>
      pool.query(`INSERT INTO ${schema}.bot_orders (market_id, side, price_micro, shares_micro, priced_on_sequence, placed_at) VALUES ($1, $2, $3, $4, 0, $5)`, [market, side, price, shares, now]);
    expect(await violation(offer(marketId(10), "YES", 500_000, 10))).toBe("none");
    expect(await violation(offer(marketId(10), "YES", 500_000, 10))).toBe("23505:bot_orders_pkey");
    expect(await violation(offer(marketId(77), "YES", 500_000, 10))).toBe("23503:bot_orders_market_id_fkey");
    expect(await violation(offer(marketId(10), "MAYBE", 500_000, 10))).toBe("23514:bot_orders_side_values");
    expect(await violation(offer(marketId(10), "NO", 505_000, 10))).toBe("23514:bot_orders_price_grid");
    expect(await violation(offer(marketId(10), "NO", 0, 10))).toBe("23514:bot_orders_price_grid");
    expect(await violation(offer(marketId(10), "NO", 500_000, 0))).toBe("23514:bot_orders_shares_positive");
  });

  it("idempotency_keys: lengths and one row per scope and key", async () => {
    const key = (scope: string, k: string, hash: string) =>
      pool.query(`INSERT INTO ${schema}.idempotency_keys (scope, key, request_hash, created_at) VALUES ($1, $2, $3, $4)`, [scope, k, hash, now]);
    expect(await violation(key("order:u1", "key-1", "h"))).toBe("none");
    expect(await violation(key("order:u1", "key-1", "h"))).toBe("23505:idempotency_keys_pkey");
    expect(await violation(key("order:u2", "key-1", "h"))).toBe("none");
    expect(await violation(key("", "k", "h"))).toBe("23514:idempotency_keys_scope_length");
    expect(await violation(key("order:u1", "", "h"))).toBe("23514:idempotency_keys_key_length");
    expect(await violation(key("order:u1", "k", ""))).toBe("23514:idempotency_keys_request_hash_length");
  });
});

// ---- Repositories ------------------------------------------------------------------------------------------------------

describe("the ledger repository", () => {
  it("appends with expected versions, reads back, finds by business key and refuses a lost race", async () => {
    const tenant = await tenantStore(T(8));
    const stream = userStreamId("alice");
    const recorded = await tenant.transaction((r) =>
      r.ledger.append({
        streamId: stream,
        expectedVersion: 0,
        events: [
          { type: "DepositCredited", data: { depositId: "d-1", amountMicro: 5_000_000 } },
          { type: "WithdrawalDebited", data: { withdrawalId: "w-1", amountMicro: 2_000_000 } },
        ],
        meta,
        recordedAt: now,
      }),
    );
    expect(recorded.map((e) => [e.type, e.version, e.businessKey, e.streamId])).toEqual([
      ["DepositCredited", 1, "d-1", stream],
      ["WithdrawalDebited", 2, "w-1", stream],
    ]);
    expect(recorded[1]?.position).toBeGreaterThan(recorded[0]?.position ?? 0);
    expect(recorded[0]?.meta).toEqual(meta);

    const r = tenant.repositories.ledger;
    expect((await r.readStream(stream)).map((e) => e.version)).toEqual([1, 2]);
    expect((await r.readStream(stream, { order: "desc" })).map((e) => e.version)).toEqual([2, 1]);
    expect((await r.readStream(stream, { limit: 1 })).map((e) => e.version)).toEqual([1]);
    expect((await r.readStream(stream, { types: ["WithdrawalDebited"] })).map((e) => e.type)).toEqual(["WithdrawalDebited"]);
    expect(await r.readStream(stream, { types: [] })).toEqual([]);
    expect((await r.readStream(stream))[0]).toMatchObject({ data: { depositId: "d-1", amountMicro: 5_000_000 }, recordedAt: now, meta });
    expect((await r.findByKey("DepositCredited", "d-1"))?.streamId).toBe(stream);
    expect(await r.findByKey("DepositCredited", "nope")).toBeNull();
    expect((await r.readAll(recorded[0]?.position ?? 0, 10)).map((e) => e.version)).toEqual([2]);

    const append = (streamId: string, expectedVersion: number, depositId: string) =>
      tenant.transaction((tx) => tx.ledger.append({ streamId, expectedVersion, events: [{ type: "DepositCredited", data: { depositId, amountMicro: 1_000_000 } }], meta, recordedAt: now }));
    // A stale version, a skipped version, a repeated business key on another stream: LedgerConflict, nothing written.
    await expect(append(stream, 1, "d-2")).rejects.toMatchObject({ name: "LedgerConflict", reason: "version" });
    await expect(append(stream, 5, "d-2")).rejects.toMatchObject({ name: "LedgerConflict", reason: "version" });
    await expect(append(userStreamId("bob"), 1, "d-3")).rejects.toMatchObject({ name: "LedgerConflict", reason: "version" });
    await expect(append(userStreamId("bob"), 0, "d-1")).rejects.toMatchObject({ name: "LedgerConflict", reason: "business_key", streamId: userStreamId("bob") });
    expect((await r.readStream(userStreamId("bob"))).length).toBe(0);
    await expect(append(stream, 2, "d-2")).resolves.toHaveLength(1);
  });

  it("lets exactly one of two racing first appends of a stream win", async () => {
    const tenant = await tenantStore(T(8));
    const stream = userStreamId("racer");
    const attempt = (depositId: string) =>
      tenant.transaction(async (r) => {
        await r.ledger.append({ streamId: stream, expectedVersion: 0, events: [{ type: "DepositCredited", data: { depositId, amountMicro: 1_000_000 } }], meta, recordedAt: now });
        await sleep(150);
      });
    const results = await Promise.allSettled([attempt("race-1"), attempt("race-2")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected");
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(LedgerConflict);
    expect((await tenant.repositories.ledger.readStream(stream)).map((e) => e.version)).toEqual([1]);
  });

  it("stores the key of a position settlement with the stream, so two holders settle the same market", async () => {
    const tenant = await tenantStore(T(8));
    const settle = (user: string) =>
      tenant.transaction((r) =>
        r.ledger.append({
          streamId: userStreamId(user),
          expectedVersion: 0,
          events: [{ type: "PositionSettled", data: { marketId: marketId(5), outcome: "YES", yesMicro: 0, noMicro: 0, payoutMicro: 0 } }],
          meta,
          recordedAt: now,
        }),
      );
    await settle("holder-1");
    await settle("holder-2");
    expect((await tenant.repositories.ledger.findByKey("PositionSettled", `${marketId(5)}/${userStreamId("holder-1")}`))?.streamId).toBe(userStreamId("holder-1"));
  });

  it("sums each user's buys and redemptions of one market (marketPayments, UC-16): bot streams and other markets left out", async () => {
    const tenant = await tenantStore(T(13));
    const meta = { correlationId: "c", causationId: "c", actor: "system" };
    const bought = (tradeId: string, market: string, costMicro: number): LedgerEvent => ({
      type: "SharesBought",
      data: { tradeId, marketId: market, side: "YES", sharesMicro: 2 * costMicro, costMicro, tradeSequence: 1, fills: [] },
    });
    const sold = (tradeId: string, market: string, sharesMicro: number, costMicro: number): LedgerEvent => ({
      type: "SharesSold",
      data: { tradeId, marketId: market, side: "YES", sharesMicro, costMicro, proceedsMicro: sharesMicro - costMicro, tradeSequence: 2, fills: [] },
    });
    await tenant.transaction(async (repositories) => {
      await repositories.ledger.append({ streamId: userStreamId("zed"), expectedVersion: 0, events: [bought("p-1", marketId(41), 7), bought("p-2", marketId(41), 5), bought("p-3", marketId(42), 100)], meta, recordedAt: now });
      await repositories.ledger.append({ streamId: userStreamId("amy"), expectedVersion: 0, events: [bought("p-4", marketId(41), 3), { type: "PairsRedeemed", data: { redemptionId: "r-1", marketId: marketId(41), pairsMicro: 4 } }], meta, recordedAt: now });
      await repositories.ledger.append({ streamId: botStreamId(marketId(41)), expectedVersion: 0, events: [{ type: "PairsRedeemed", data: { redemptionId: "r-2", marketId: marketId(41), pairsMicro: 9 } }], meta, recordedAt: now });
      // UC-08: a sale paid the other side's cost and got the pairs back (SharesSold, tenant migration 003).
      await repositories.ledger.append({ streamId: userStreamId("amy"), expectedVersion: 2, events: [sold("s-1", marketId(41), 10, 6)], meta, recordedAt: now });
      await repositories.ledger.append({ streamId: userStreamId("kim"), expectedVersion: 0, events: [sold("s-2", marketId(41), 5, 2), sold("s-3", marketId(42), 50, 20)], meta, recordedAt: now });
    });
    expect(await tenant.repositories.ledger.marketPayments(marketId(41))).toEqual([
      { streamId: userStreamId("amy"), paidMicro: 3 + 6, returnedMicro: 4 + 10 },
      { streamId: userStreamId("kim"), paidMicro: 2, returnedMicro: 5 },
      { streamId: userStreamId("zed"), paidMicro: 12, returnedMicro: 0 },
    ]);
    expect(await tenant.repositories.ledger.marketPayments(marketId(42).toUpperCase())).toEqual([
      { streamId: userStreamId("kim"), paidMicro: 20, returnedMicro: 50 },
      { streamId: userStreamId("zed"), paidMicro: 100, returnedMicro: 0 },
    ]);
    expect(await tenant.repositories.ledger.marketPayments(marketId(43))).toEqual([]);
    expect(await tenant.repositories.ledger.marketPayments("not-a-market")).toEqual([]);
  });

  it("rolls the ledger and the outbox back together", async () => {
    const tenant = await tenantStore(T(8));
    const stream = userStreamId("rolled-back");
    await expect(
      tenant.transaction(async (r) => {
        await r.ledger.append({ streamId: stream, expectedVersion: 0, events: [{ type: "DepositCredited", data: { depositId: "d-rb", amountMicro: 1_000_000 } }], meta, recordedAt: now });
        await r.outbox.add({ id: marketId(801), aggregateId: "a", subject: "chance.trading.TradeExecuted.x", type: "t", payload: { specversion: "1.0" } as never, createdAt: now });
        throw new Error("the transaction fails after both writes");
      }),
    ).rejects.toThrow("after both writes");
    expect(await tenant.repositories.ledger.readStream(stream)).toEqual([]);
    expect((await pool.query("SELECT 1 FROM shared.outbox WHERE id = $1", [marketId(801)])).rowCount).toBe(0);
  });
});

describe("the account repository", () => {
  it("saves and loads balance, owner, version and positions as absolute values, and deletes an empty position", async () => {
    const tenant = await tenantStore(T(9));
    const user: AccountState = {
      ...emptyUserAccount("alice"),
      balanceMicro: 3_000_000_000_000,
      version: 2,
      positions: { [marketId(1)]: { yesMicro: 4_000_000_000, noMicro: 0 }, [marketId(2)]: { yesMicro: 0, noMicro: 7 } },
    };
    await tenant.transaction((r) => r.accounts.save(user, now));
    const a = tenant.repositories.accounts;
    expect(await a.load(user.streamId)).toEqual(user);
    expect(await a.load(user.streamId, { marketIds: [marketId(1)] })).toEqual({ ...user, positions: { [marketId(1)]: { yesMicro: 4_000_000_000, noMicro: 0 } } });
    expect((await a.load(user.streamId, { marketIds: [] }))?.positions).toEqual({});
    expect((await a.load(user.streamId, { marketIds: ["not-a-uuid"] }))?.positions).toEqual({});
    expect(await a.load(userStreamId("nobody"))).toBeNull();

    // Absolute values: market 1 shrinks, market 2 reaches zero and is deleted, market 3 appears; market 4 is not in the state, so it is untouched.
    await tenant.transaction((r) => r.accounts.save({ ...user, balanceMicro: 5, version: 3, positions: { [marketId(1)]: { yesMicro: 1, noMicro: 1 }, [marketId(2)]: { yesMicro: 0, noMicro: 0 }, [marketId(3)]: { yesMicro: 9, noMicro: 0 } } }, now));
    expect(await a.load(user.streamId)).toMatchObject({ balanceMicro: 5, version: 3, positions: { [marketId(1)]: { yesMicro: 1, noMicro: 1 }, [marketId(3)]: { yesMicro: 9, noMicro: 0 } } });
    expect(Object.keys((await a.load(user.streamId))?.positions ?? {})).not.toContain(marketId(2));
    await tenant.transaction((r) => r.accounts.save({ ...user, balanceMicro: 5, version: 4, positions: { [marketId(4)]: { yesMicro: 2, noMicro: 0 } } }, now));
    expect(Object.keys((await a.load(user.streamId))?.positions ?? {}).sort()).toEqual([marketId(1), marketId(3), marketId(4)]);
  });

  it("refuses a value above the safe integers instead of rounding it", async () => {
    const tenant = await tenantStore(T(9));
    await pool.query(
      `INSERT INTO ${tenantSchemaIdentifier(T(9))}.accounts (stream_id, kind, owner_id, balance_micro, version, created_at, updated_at) VALUES ('account:whale', 'user', 'whale', 1152921504606846976, 1, $1, $1)`,
      [now],
    );
    await expect(tenant.repositories.accounts.load("account:whale")).rejects.toThrow("not a safe integer");
    await pool.query(`DELETE FROM ${tenantSchemaIdentifier(T(9))}.accounts WHERE stream_id = 'account:whale'`);
  });

  it("keeps the bot account of a market apart: owner, the accounts of an owner, all and clear", async () => {
    const tenant = await tenantStore(T(9));
    await tenant.transaction(async (r) => {
      await r.accounts.save({ ...emptyBotAccount(marketId(20), "alice"), ownerId: "alice", balanceMicro: 10, version: 1, positions: { [marketId(20)]: { yesMicro: 3, noMicro: 3 } } }, now);
      await r.accounts.save({ ...emptyBotAccount(marketId(21), "bob"), ownerId: "bob", balanceMicro: 10, version: 1 }, now);
    });
    const a = tenant.repositories.accounts;
    expect((await a.botAccountsOwnedBy("alice")).map((b) => b.streamId)).toEqual([botStreamId(marketId(20))]);
    expect((await a.botAccountsOwnedBy("alice"))[0]?.positions).toEqual({ [marketId(20)]: { yesMicro: 3, noMicro: 3 } });
    expect(await a.botAccountsOwnedBy("nobody")).toEqual([]);
    expect((await a.all()).map((account) => account.streamId)).toEqual([...(await a.all()).map((account) => account.streamId)].sort());
    await tenant.transaction((r) => r.accounts.clear());
    expect(await a.all()).toEqual([]);
  });

  it("holdersOf: users with a position in the market, never the bot account, the named creator whether it holds or not, once each, by stream id", async () => {
    const tenant = await tenantStore(T(10));
    const m = marketId(30);
    const holding = (userId: string, yes: number, no: number): AccountState => ({ ...emptyUserAccount(userId), balanceMicro: 1_000_000, version: 1, positions: { [m]: { yesMicro: yes, noMicro: no } } });
    await tenant.transaction(async (r) => {
      await r.accounts.save(holding("zed", 5, 0), now);
      await r.accounts.save(holding("amy", 0, 7), now);
      await r.accounts.save(holding("creator", 1, 1), now); // the creator holds a position and is also named
      await r.accounts.save({ ...emptyUserAccount("quiet"), balanceMicro: 3, version: 1 }, now); // no position, not named
      await r.accounts.save({ ...emptyUserAccount("owner"), balanceMicro: 9, version: 1 }, now); // named, no position
      await r.accounts.save({ ...emptyUserAccount("elsewhere"), balanceMicro: 1, version: 1, positions: { [marketId(31)]: { yesMicro: 4, noMicro: 0 } } }, now);
      // The bot account has a positions row in this market too, and is not a holder.
      await r.accounts.save({ ...emptyBotAccount(m, "creator"), ownerId: "creator", balanceMicro: 5, version: 2, positions: { [m]: { yesMicro: 100, noMicro: 100 } } }, now);
    });
    const holders = await tenant.repositories.accounts.holdersOf(m, { alsoStreamIds: [userStreamId("creator"), userStreamId("owner"), userStreamId("missing")] });
    expect(holders.map((h) => h.streamId)).toEqual(["account:amy", "account:creator", "account:owner", "account:zed"]);
    expect(holders.every((h) => h.kind === "user")).toBe(true);
    expect(holders.find((h) => h.streamId === "account:owner")?.positions).toEqual({});
    expect(holders.find((h) => h.streamId === "account:zed")?.positions).toEqual({ [m]: { yesMicro: 5, noMicro: 0 } });
    expect(holders.find((h) => h.streamId === "account:amy")?.positions).toEqual({ [m]: { yesMicro: 0, noMicro: 7 } });
    expect((await tenant.repositories.accounts.holdersOf(m)).map((h) => h.streamId)).toEqual(["account:amy", "account:creator", "account:zed"]);
    expect(await tenant.repositories.accounts.holdersOf("not-a-uuid")).toEqual([]);
  });

  it("locks the rows it reads: a second transaction waits for the first one's commit (load and holdersOf)", async () => {
    const tenant = await tenantStore(T(10));
    const m = marketId(30);
    const waitsFor = async (hold: (r: TenantRepositories) => Promise<unknown>): Promise<number> => {
      let locked: () => void = () => undefined;
      const lockedPromise = new Promise<void>((resolve) => (locked = resolve));
      const first = tenant.transaction(async (r) => {
        await hold(r);
        locked();
        await sleep(400);
      });
      await lockedPromise;
      const started = Date.now();
      await tenant.transaction((r) => r.accounts.load(userStreamId("zed"), { lock: true }));
      const waited = Date.now() - started;
      await first;
      return waited;
    };
    expect(await waitsFor((r) => r.accounts.load(userStreamId("zed"), { lock: true }))).toBeGreaterThanOrEqual(300);
    expect(await waitsFor((r) => r.accounts.holdersOf(m, { lock: true, alsoStreamIds: [userStreamId("owner")] }))).toBeGreaterThanOrEqual(300);
    // Without the lock nothing waits.
    expect(await waitsFor((r) => r.accounts.holdersOf(m))).toBeLessThan(300);
  });
});

describe("the market and order book repositories", () => {
  it("inserts once, finds, updates, lists by status and id, and finds many", async () => {
    const tenant = await tenantStore(T(11));
    const m = tenant.repositories.marketStates;
    const funded = newFundedMarket(marketId(40), "alice", creditsToMicro(500), now);
    const open = applyOpened(newFundedMarket(marketId(41), "alice", creditsToMicro(100), now), { marketId: marketId(41), version: 1, question: "Will it rain tomorrow?", closeTime: new Date("2026-12-01T10:00:00.000Z"), startingPriceMicro: 400_000, creatorId: "alice", openedAt: now }, now).state;
    expect(await m.insert(funded)).toBe(true);
    expect(await m.insert({ ...funded, version: 9 })).toBe(false);
    expect(await m.insert(open)).toBe(true);
    expect(await m.find(marketId(40))).toEqual(funded);
    expect(await m.find(marketId(41))).toEqual(open);
    expect(await m.find(marketId(99))).toBeNull();
    expect(await m.find("not-a-uuid")).toBeNull();
    expect(await m.find(marketId(41), { lock: true })).toEqual(open);

    const traded: MarketState = { ...withTrade(open, now), tradeSequence: 4_000_000_000 };
    await m.update(traded);
    expect((await m.find(marketId(41)))?.tradeSequence).toBe(4_000_000_000);
    await expect(m.update({ ...funded, marketId: marketId(98) })).rejects.toThrow("no market_state row");

    const resolved: MarketState = { ...traded, status: "resolved", outcome: "NO", version: 3, resolvedAt: now, settledAt: now, payoutTotalMicro: 7, returnedMicro: 0 };
    await m.update(resolved);
    expect(await m.find(marketId(41))).toEqual(resolved);

    expect((await m.listByStatus("funded", { limit: 10, afterId: null })).map((s) => s.marketId)).toEqual([marketId(40)]);
    expect((await m.listByStatus("resolved", { limit: 10, afterId: marketId(40) })).map((s) => s.marketId)).toEqual([marketId(41)]);
    expect(await m.listByStatus("resolved", { limit: 10, afterId: marketId(41) })).toEqual([]);
    expect(await m.listByStatus("open", { limit: 10, afterId: "bad" })).toEqual([]);
    expect((await m.findMany([marketId(41), marketId(40), marketId(97), "bad"])).map((s) => s.marketId)).toEqual([marketId(40), marketId(41)]);
    expect(await m.findMany([])).toEqual([]);

    for (let n = 50; n < 55; n += 1) await m.insert(newFundedMarket(marketId(n), "alice", creditsToMicro(1), now));
    expect((await m.listByStatus("funded", { limit: 3, afterId: marketId(40) })).map((s) => s.marketId)).toEqual([marketId(50), marketId(51), marketId(52)]);
  });

  it("replaces the whole book, reads it YES before NO and cheapest first, and clears it", async () => {
    const tenant = await tenantStore(T(11));
    const b = tenant.repositories.botOrders;
    const id = marketId(40);
    expect(await b.get(id)).toEqual({ marketId: id, offers: [], pricedOnSequence: null, placedAt: null });
    const offers: Offer[] = [
      { side: "NO", priceMicro: 600_000, sharesMicro: 5 },
      { side: "YES", priceMicro: 500_000, sharesMicro: 4_000_000_000 },
      { side: "YES", priceMicro: 400_000, sharesMicro: 3 },
    ];
    await b.replace(id, offers, 6, now);
    expect(await b.get(id)).toEqual({
      marketId: id,
      offers: [
        { side: "YES", priceMicro: 400_000, sharesMicro: 3 },
        { side: "YES", priceMicro: 500_000, sharesMicro: 4_000_000_000 },
        { side: "NO", priceMicro: 600_000, sharesMicro: 5 },
      ],
      pricedOnSequence: 6,
      placedAt: now,
    });
    await b.replace(id, [{ side: "NO", priceMicro: 700_000, sharesMicro: 1 }], 7, now);
    expect((await b.get(id)).offers).toEqual([{ side: "NO", priceMicro: 700_000, sharesMicro: 1 }]);
    await b.replace(id, [], 8, now);
    expect(await b.get(id)).toEqual({ marketId: id, offers: [], pricedOnSequence: null, placedAt: null });
    await b.replace(id, offers, 6, now);
    await b.clear(id);
    expect((await b.get(id)).offers).toEqual([]);
    expect(await b.get("not-a-uuid")).toMatchObject({ offers: [] });
    await expect(b.replace(marketId(96), offers, 1, now)).rejects.toThrow();
  });
});

describe("the idempotency repository", () => {
  const claim = (tenant: TenantStore, scope: string, key: string, requestHash: string) => tenant.transaction((r) => r.idempotency.claim({ scope, key, requestHash, now }));

  it("claims, completes in the same transaction, and answers a repeat with the stored result or a mismatch", async () => {
    const tenant = await tenantStore(T(12));
    await tenant.transaction(async (r) => {
      expect(await r.idempotency.claim({ scope: "order:u1", key: "key-0001", requestHash: "h1", now })).toEqual({ kind: "claimed" });
      await r.idempotency.complete("order:u1", "key-0001", { tradeId: "t-1", executedAt: "2026-11-01T10:00:00.000Z", sharesMicro: 4_000_000_000 });
    });
    expect(await claim(tenant, "order:u1", "key-0001", "h1")).toEqual({ kind: "replay", result: { tradeId: "t-1", executedAt: "2026-11-01T10:00:00.000Z", sharesMicro: 4_000_000_000 }, createdAt: now });
    expect(await claim(tenant, "order:u1", "key-0001", "other")).toEqual({ kind: "mismatch" });
    // The same key of another user is another key.
    expect(await claim(tenant, "order:u2", "key-0001", "h1")).toEqual({ kind: "claimed" });
    await expect(tenant.transaction((r) => r.idempotency.complete("order:u9", "nope", {}))).rejects.toThrow("was not claimed");
  });

  it("leaves no key behind when the transaction rolls back, and holds a second claim until the first one ends", async () => {
    const tenant = await tenantStore(T(12));
    await expect(
      tenant.transaction(async (r) => {
        await r.idempotency.claim({ scope: "order:u1", key: "key-rollback", requestHash: "h", now });
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(await claim(tenant, "order:u1", "key-rollback", "h")).toEqual({ kind: "claimed" });

    // A second claim of a key that another transaction holds waits, then sees the result (replay), or claims after a rollback.
    let held: () => void = () => undefined;
    const heldPromise = new Promise<void>((resolve) => (held = resolve));
    const first = tenant.transaction(async (r) => {
      await r.idempotency.claim({ scope: "order:u1", key: "key-race", requestHash: "h", now });
      held();
      await sleep(400);
      await r.idempotency.complete("order:u1", "key-race", { answer: 42 });
    });
    await heldPromise;
    const started = Date.now();
    const second = await claim(tenant, "order:u1", "key-race", "h");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(second).toMatchObject({ kind: "replay", result: { answer: 42 } });
    await first;
    expect(await claim(tenant, "order:u1", "key-race", "another request")).toEqual({ kind: "mismatch" });

    let heldAgain: () => void = () => undefined;
    const heldAgainPromise = new Promise<void>((resolve) => (heldAgain = resolve));
    const failing = tenant
      .transaction(async (r) => {
        await r.idempotency.claim({ scope: "order:u1", key: "key-race-2", requestHash: "h", now });
        heldAgain();
        await sleep(300);
        throw new Error("the first request failed");
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    await heldAgainPromise;
    expect(await claim(tenant, "order:u1", "key-race-2", "h")).toEqual({ kind: "claimed" });
    expect((await failing)?.message).toBe("the first request failed");
  });

  it("refuses a second claim of a key inside the transaction that holds it", async () => {
    const tenant = await tenantStore(T(12));
    await expect(
      tenant.transaction(async (r) => {
        await r.idempotency.claim({ scope: "order:u1", key: "key-twice", requestHash: "h", now });
        await r.idempotency.claim({ scope: "order:u1", key: "key-twice", requestHash: "h", now });
      }),
    ).rejects.toThrow("held without a result");
  });

  it("purges the keys of a scope prefix older than the cut-off, and nothing else", async () => {
    const tenant = await tenantStore(T(12));
    const at = (scope: string, key: string, when: Date) =>
      tenant.transaction(async (r) => {
        await r.idempotency.claim({ scope, key, requestHash: "h", now: when });
        await r.idempotency.complete(scope, key, {});
      });
    const old = new Date(now.getTime() - 8 * 86_400_000);
    await at("order:p1", "purge-old", old);
    await at("order:p1", "purge-new", now);
    await at("funding", "purge-funding", old);
    await at("debit", "purge-debit", old);
    expect(await tenant.repositories.idempotency.purge("order:", new Date(now.getTime() - 7 * 86_400_000))).toBe(1);
    const left = (await pool.query<{ key: string }>(`SELECT key FROM ${tenantSchemaIdentifier(T(12))}.idempotency_keys WHERE key LIKE 'purge-%' ORDER BY key`)).rows.map((row) => row.key);
    expect(left).toEqual(["purge-debit", "purge-funding", "purge-new"]);
  });
});

describe("the shared repositories", () => {
  it("outbox: claims in order, one relay at a time, marks published and purges", async () => {
    const add = (id: string, at: number) =>
      store.transaction((r) => r.outbox.add({ id, aggregateId: "agg", subject: "chance.trading.MarketFunded.t", type: "si.chance.trading.MarketFunded.v1", payload: { specversion: "1.0", id } as never, createdAt: new Date(now.getTime() + at) }));
    const ids = [marketId(701), marketId(702), marketId(703)];
    for (const [index, id] of ids.entries()) await add(id, index);

    const publisher = new MemoryEventPublisher();
    const slow = { publish: async (...args: Parameters<MemoryEventPublisher["publish"]>) => { await sleep(300); return publisher.publish(...args); } };
    const relayA = new OutboxRelay({ store, publisher: slow, clock: { now: () => now }, logger, pollMs: 5, streamMaxAgeMs: 7 * 86_400_000 });
    const relayB = new OutboxRelay({ store, publisher: slow, clock: { now: () => now }, logger, pollMs: 5, streamMaxAgeMs: 7 * 86_400_000 });
    const [a, b] = await Promise.all([relayA.runOnce(), relayB.runOnce()]);
    // The advisory lock lets one instance publish; the other claims nothing.
    expect([a.published, b.published].sort()).toEqual([0, 3]);
    expect(publisher.published.map((m) => m.messageId)).toEqual(ids);
    expect((await pool.query("SELECT count(*)::int AS n FROM shared.outbox WHERE published_at IS NULL")).rows[0]).toEqual({ n: 0 });

    publisher.failNext = 1;
    await add(marketId(704), 10);
    expect(await relayA.runOnce()).toEqual({ published: 0, failed: true });
    expect((await pool.query("SELECT attempts, last_error FROM shared.outbox WHERE id = $1", [marketId(704)])).rows[0]).toEqual({ attempts: 1, last_error: "The in-memory publisher was told to fail" });
    expect(await store.repositories.outbox.purgePublished(new Date(now.getTime() + 60_000))).toBe(3);
  });

  it("inbox: records once per consumer and event id, purges old entries", async () => {
    const entry = (consumer: string, eventId: string, at: Date) => ({ consumer, eventId, eventType: "t", processedAt: at });
    expect(await store.transaction((r) => r.inbox.record(entry("market-events", "i-1", now)))).toBe(true);
    expect(await store.transaction((r) => r.inbox.record(entry("market-events", "i-1", now)))).toBe(false);
    expect(await store.transaction((r) => r.inbox.record(entry("payment-events", "i-1", new Date(now.getTime() - 86_400_000))))).toBe(true);
    expect(await store.repositories.inbox.purge(new Date(now.getTime() - 3_600_000))).toBe(1);
  });

  it("market and withdrawal directories: the first tenant wins, an unregistered tenant is refused, tenantOf reads it", async () => {
    await tenantStore(T(1));
    await tenantStore(T(2));
    const { marketDirectory, withdrawalDirectory } = store.repositories;
    expect(await marketDirectory.register(marketId(601), T(1), now)).toBe(T(1));
    expect(await marketDirectory.register(marketId(601), T(1), now)).toBe(T(1));
    expect(await marketDirectory.register(marketId(601), T(2), now)).toBe(T(1));
    expect(await marketDirectory.tenantOf(marketId(601))).toBe(T(1));
    expect(await marketDirectory.tenantOf(marketId(602))).toBeNull();
    expect(await marketDirectory.tenantOf("not-a-uuid")).toBeNull();
    expect(await violation(marketDirectory.register(marketId(603), "00000000-0000-7000-8000-0000000000ee", now))).toBe("23503:market_directory_tenant_id_fkey");

    expect(await withdrawalDirectory.register(marketId(611), T(1), now)).toBe(T(1));
    expect(await withdrawalDirectory.register(marketId(611), T(2), now)).toBe(T(1));
    expect(await violation(withdrawalDirectory.register(marketId(612), "00000000-0000-7000-8000-0000000000ee", now))).toBe("23503:withdrawal_directory_tenant_id_fkey");

    // Two registrations of one market at the same time: both see the first tenant.
    const both = await Promise.all([marketDirectory.register(marketId(621), T(2), now), marketDirectory.register(marketId(621), T(1), now)]);
    expect(new Set(both).size).toBe(1);
  });

  it("parked events: upsert by consumer and stream sequence, list oldest first, remove", async () => {
    const parked = store.repositories.parkedEvents;
    const event = (consumer: string, streamSequence: number, minutes: number, reason = "boom") => ({
      consumer,
      streamSequence,
      subject: `chance.markets.MarketClosed.${T(1)}`,
      payload: "{\"a\":\"č\"}",
      reason,
      deliveries: 20,
      parkedAt: new Date(now.getTime() + minutes * 60_000),
    });
    await parked.park(event("market-events", 5_000_000_000, 2));
    await parked.park(event("market-events", 3, 1));
    await parked.park(event("payment-events", 3, 3));
    await parked.park({ ...event("market-events", 3, 4, "failed again"), deliveries: 21 });
    expect((await parked.list(null, 10)).map((e) => [e.consumer, e.streamSequence])).toEqual([
      ["market-events", 5_000_000_000],
      ["payment-events", 3],
      ["market-events", 3],
    ]);
    expect((await parked.list("market-events", 10)).map((e) => e.streamSequence)).toEqual([5_000_000_000, 3]);
    expect((await parked.list("market-events", 10))[1]).toMatchObject({ reason: "failed again", deliveries: 21, payload: "{\"a\":\"č\"}" });
    expect(await parked.list("market-events", 1)).toHaveLength(1);
    await parked.remove("market-events", 3);
    expect((await parked.list(null, 10)).map((e) => [e.consumer, e.streamSequence])).toEqual([
      ["market-events", 5_000_000_000],
      ["payment-events", 3],
    ]);
  });

  it("parked events: a different message under the same stream sequence never overwrites the parked one", async () => {
    const parked = store.repositories.parkedEvents;
    const event = (payload: string, reason: string) => ({ consumer: "tenant-created", streamSequence: 7, subject: "chance.tenants.TenantCreated.x", payload, reason, deliveries: 20, parkedAt: now });
    await parked.park(event("{\"n\":1}", "first"));

    await expect(parked.park(event("{\"n\":2}", "second"))).rejects.toThrow("A different event is already parked under tenant-created #7");
    expect((await parked.list("tenant-created", 10)).map((e) => [e.payload, e.reason])).toEqual([["{\"n\":1}", "first"]]);

    await parked.park(event("{\"n\":1}", "first again"));
    expect((await parked.list("tenant-created", 10)).map((e) => [e.payload, e.reason])).toEqual([["{\"n\":1}", "first again"]]);
    await parked.remove("tenant-created", 7);
  });

  it("outbox: claims in the order of writing, whatever created_at says", async () => {
    const ids = [marketId(731), marketId(732), marketId(733)];
    // The second row is stamped earlier than the first: an order that read the clock before it waited for the market lock.
    for (const [index, id] of ids.entries()) {
      const createdAt = new Date(now.getTime() + [30, 10, 20][index]! * 1000);
      await store.transaction((r) => r.outbox.add({ id, aggregateId: "agg", subject: "chance.trading.TradeExecuted.t", type: "si.chance.trading.TradeExecuted.v1", payload: { specversion: "1.0", id } as never, createdAt }));
    }

    const claimed = await store.transaction((r) => r.outbox.claimBatch(100));

    expect(claimed.map((row) => row.id).filter((id) => ids.includes(id))).toEqual(ids);
    await pool.query("DELETE FROM shared.outbox WHERE id = ANY($1::uuid[])", [ids]);
  });
});

// ---- Concurrency and replay --------------------------------------------------------------------------------------------

describe("concurrent transactions on one tenant", () => {
  it("orders on one market: contiguous trade sequences, no negative balance, credits conserved, replay equal", async () => {
    const tenant = await tenantStore(T(4));
    const m = marketId(100);
    const users = Array.from({ length: 6 }, (_, i) => `trader-${String(i)}`);
    await deposit(tenant, "creator", 1000, marketId(900));
    for (const [index, user] of users.entries()) await deposit(tenant, user, 100, marketId(910 + index));
    await openFundedMarket(tenant, m, "creator", 1000);
    const ids = new SequentialIds();

    // Two orders per trader at once: the market_state row serialises them, so none loses a ledger race.
    await Promise.all(users.flatMap((user) => [buy(tenant, m, user, 10, ids.newId()), buy(tenant, m, user, 15, ids.newId())]));

    const market = await tenant.repositories.marketStates.find(m);
    expect(market?.tradeSequence).toBe(12);
    const bought = await Promise.all(users.map((user) => tenant.repositories.ledger.readStream(userStreamId(user), { types: ["SharesBought"] })));
    const sequences = bought.flat().map((e) => (e.type === "SharesBought" ? e.data.tradeSequence : 0)).sort((x, y) => x - y);
    expect(sequences).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const accounts = await tenant.repositories.accounts.all();
    expect(accounts.every((account) => account.balanceMicro >= 0)).toBe(true);
    const bot = accounts.find((account) => account.streamId === botStreamId(m));
    expect(bot?.version).toBe(1 + 12);
    // 1000 deposited by the creator plus 600 by the traders; every microcredit is in some balance (the bot's pairs are worth one each).
    const pairs = (bot?.positions[m]?.yesMicro ?? 0);
    const inBalances = accounts.reduce((sum, account) => sum + account.balanceMicro, 0);
    const traderShares = accounts.filter((a) => a.kind === "user").reduce((sum, a) => sum + (a.positions[m]?.yesMicro ?? 0), 0);
    expect(traderShares + pairs).toBe(creditsToMicro(1000));
    expect(inBalances).toBe(creditsToMicro(1600) - creditsToMicro(1000));
    expect(await replayDifferences(tenant)).toEqual([]);
  });

  it("a tampered projection shows in the replay, and a rebuild repairs it", async () => {
    const tenant = await tenantStore(T(4));
    await pool.query(`UPDATE ${tenantSchemaIdentifier(T(4))}.accounts SET balance_micro = balance_micro + 1 WHERE stream_id = 'account:trader-1'`);
    await pool.query(`DELETE FROM ${tenantSchemaIdentifier(T(4))}.positions WHERE stream_id = 'account:trader-2'`);
    expect((await replayDifferences(tenant)).sort()).toEqual(["account:trader-1: differs", "account:trader-2: differs"]);
    expect((await replayDifferences(tenant, true)).length).toBe(2);
    expect(await replayDifferences(tenant)).toEqual([]);
  });

  it("a replay with rebuild holds appends back until it commits, and nothing differs afterwards", async () => {
    const tenant = await tenantStore(T(4));
    let locked: () => void = () => undefined;
    const lockedPromise = new Promise<void>((resolve) => (locked = resolve));
    const replay = tenant.transaction(async (r) => {
      await r.ledger.lockForReplay();
      locked();
      await sleep(500);
      const events = await r.ledger.readAll(0, 10_000);
      const byStream = new Map<string, typeof events>();
      for (const event of events) byStream.set(event.streamId, [...(byStream.get(event.streamId) ?? []), event]);
      await r.accounts.clear();
      for (const [streamId, list] of byStream) await r.accounts.save(replayStream(streamId, list), now);
    });
    await lockedPromise;
    const started = Date.now();
    // A deposit for an existing account and one for a new account, both during the replay.
    await Promise.all([deposit(tenant, "trader-3", 7, marketId(950)), deposit(tenant, "newcomer", 3, marketId(951))]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await replay;
    expect(await replayDifferences(tenant)).toEqual([]);
    expect((await tenant.repositories.accounts.load(userStreamId("newcomer")))?.balanceMicro).toBe(creditsToMicro(3));
  });

  it("repeated deposits of one id at once credit it once", async () => {
    const tenant = await tenantStore(T(5));
    const id = marketId(960);
    await Promise.all(Array.from({ length: 4 }, () => deposit(tenant, "dup", 5, id).catch((error: unknown) => error)));
    expect((await tenant.repositories.ledger.readStream(userStreamId("dup"))).length).toBe(1);
    expect((await tenant.repositories.accounts.load(userStreamId("dup")))?.balanceMicro).toBe(creditsToMicro(5));
  });

  it("ends one of two transactions that wait for each other, and reports it as a LedgerConflict to decide again", async () => {
    const tenant = await tenantStore(T(4));
    const crossing = (first: string, second: string) =>
      tenant.transaction(async (r) => {
        await r.accounts.load(userStreamId(first), { lock: true });
        await sleep(300);
        await r.accounts.load(userStreamId(second), { lock: true });
      });
    const results = await Promise.allSettled([crossing("trader-4", "trader-5"), crossing("trader-5", "trader-4")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(LedgerConflict);
    expect((lost.reason as LedgerConflict).streamId).toBe("deadlock");
  });
});
