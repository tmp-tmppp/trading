import pg from "pg";
import type { CloudEvent } from "../../domain/events.js";
import { businessKeyOf } from "../../domain/ledger.js";
import type { AccountKind, AccountState, Holding, LedgerEvent, LedgerEventType } from "../../domain/ledger.js";
import type { MarketState, MarketStatus } from "../../domain/market-state.js";
import { sortOffers } from "../../domain/order-book.js";
import type { Offer } from "../../domain/order-book.js";
import { isTenantId, parseTenantId, tenantSchemaIdentifier } from "../../domain/tenant.js";
import type { Outcome, Side } from "../../domain/units.js";
import { LedgerConflict } from "../../usecases/errors.js";
import type {
  AccountRepository,
  BotOrderBook,
  BotOrderRepository,
  IdempotencyRepository,
  InboxRepository,
  LedgerRepository,
  Logger,
  MarketDirectory,
  MarketStateRepository,
  OutboxRepository,
  OutboxRow,
  ParkedEvent,
  ParkedEventRepository,
  RecordedLedgerEvent,
  SharedRepositories,
  Store,
  TenantRegistry,
  TenantRepositories,
  TenantStore,
  WithdrawalDirectory,
} from "../../usecases/ports.js";
import { provisionTenantSchema } from "./migrate.js";

type Queryable = Pick<pg.Pool, "query">;

// Key of the advisory lock that lets one outbox relay claim at a time. Advisory locks of a database share one key
// space; the migration lock (migrate.ts) is 737001, so this one is the next number.
export const OUTBOX_RELAY_LOCK_KEY = 737_002;

/** Longest error text kept in a row: an error message is not allowed to grow a row without limit. */
const MAX_ERROR_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// Shared tables are always written with the prefix "shared."; the tables of a tenant with the quoted schema name that
// tenantSchemaIdentifier (domain/tenant.ts) makes from the validated tenant id, never from request text.

/**
 * bigint columns come back from pg as strings: a safe integer or a failure, never a silently rounded number. (All
 * quantities are micro-units that the domain keeps below 2^53, so a value outside that range is corruption.)
 */
function toNumber(value: string | number, what: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${what} is not a safe integer: ${String(value)}`);
  return result;
}

const toNullableNumber = (value: string | number | null, what: string): number | null => (value === null ? null : toNumber(value, what));

/** A value that is no UUID cannot be an id: callers answer "not found" instead of letting the driver raise a type error. */
const onlyUuids = (ids: readonly string[]): string[] => ids.filter((id) => UUID_PATTERN.test(id)).map((id) => id.toLowerCase());

// ---- Outbox ----------------------------------------------------------------------------------------------------------

interface OutboxDbRow {
  id: string;
  aggregate_id: string;
  subject: string;
  type: string;
  payload: CloudEvent<unknown>;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

const toOutboxRow = (row: OutboxDbRow): OutboxRow => ({
  id: row.id,
  aggregateId: row.aggregate_id,
  subject: row.subject,
  type: row.type,
  payload: row.payload,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  attempts: row.attempts,
  lastError: row.last_error,
});

function outboxRepository(db: Queryable): OutboxRepository {
  return {
    async add(message) {
      await db.query(
        `INSERT INTO shared.outbox (id, aggregate_id, subject, type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [message.id, message.aggregateId, message.subject, message.type, JSON.stringify(message.payload), message.createdAt],
      );
    },
    async claimBatch(limit) {
      // One relay at a time: the batches of the instances must not be published in parallel, or the events of a
      // tenant could arrive out of order. The lock belongs to the transaction (it ends with COMMIT or ROLLBACK,
      // also when the connection breaks), so a relay that crashes cannot keep it. Outside a transaction it would
      // be released at once; the relay always claims inside one. The batch is in the order of writing (seq), never by
      // created_at: that time comes from the application's clock, which differs between pods and can be read before the
      // market lock, while the rows of one market are inserted one after another under that lock.
      const lock = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [OUTBOX_RELAY_LOCK_KEY]);
      if (lock.rows[0]?.locked !== true) return [];
      const result = await db.query<OutboxDbRow>(
        `SELECT * FROM shared.outbox
          WHERE published_at IS NULL
          ORDER BY seq
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      return result.rows.map(toOutboxRow);
    },
    async markPublished(id, at) {
      await db.query("UPDATE shared.outbox SET published_at = $2 WHERE id = $1", [id, at]);
    },
    async markFailed(id, error) {
      await db.query("UPDATE shared.outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1", [id, error.slice(0, MAX_ERROR_LENGTH)]);
    },
    async purgePublished(olderThan) {
      const result = await db.query("DELETE FROM shared.outbox WHERE published_at IS NOT NULL AND published_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

// ---- Inbox -----------------------------------------------------------------------------------------------------------

function inboxRepository(db: Queryable): InboxRepository {
  return {
    async record(entry) {
      const result = await db.query(
        "INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (consumer, event_id) DO NOTHING",
        [entry.consumer, entry.eventId, entry.eventType, entry.processedAt],
      );
      return result.rowCount === 1;
    },
    async purge(olderThan) {
      const result = await db.query("DELETE FROM shared.inbox WHERE processed_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

// ---- Tenant registry, market directory, withdrawal directory ---------------------------------------------------------

/**
 * `provision` needs a connection that is inside a transaction (`inTransaction`): its advisory lock and its DDL belong to
 * that transaction. Over the pool it refuses, because each statement would run on another connection.
 */
function tenantRegistry(db: Queryable, inTransaction: boolean, logger: Logger): TenantRegistry {
  return {
    async provision(tenantId, now) {
      if (!inTransaction) throw new Error("A tenant schema is provisioned inside a transaction only");
      await provisionTenantSchema(db, tenantId, now, logger);
    },
    async isRegistered(tenantId) {
      if (!isTenantId(tenantId)) return false;
      const result = await db.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [tenantId.toLowerCase()]);
      return (result.rowCount ?? 0) > 0;
    },
    async list() {
      const result = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.tenant_registry ORDER BY tenant_id");
      return result.rows.map((row) => row.tenant_id);
    },
  };
}

function marketDirectory(db: Queryable): MarketDirectory {
  return {
    async register(marketId, tenantId, now) {
      // Two statements on purpose: a concurrent insert of the same market makes the first one wait for its commit and
      // insert nothing, and only a statement that starts afterwards sees the committed row.
      await db.query("INSERT INTO shared.market_directory (market_id, tenant_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (market_id) DO NOTHING", [
        marketId,
        tenantId.toLowerCase(),
        now,
      ]);
      const stored = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.market_directory WHERE market_id = $1", [marketId]);
      const row = stored.rows[0];
      if (!row) throw new Error(`The market directory has no row for ${marketId} right after its insert`);
      return row.tenant_id;
    },
    async tenantOf(marketId) {
      if (!UUID_PATTERN.test(marketId)) return null;
      const result = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.market_directory WHERE market_id = $1", [marketId.toLowerCase()]);
      return result.rows[0]?.tenant_id ?? null;
    },
  };
}

function withdrawalDirectory(db: Queryable): WithdrawalDirectory {
  return {
    async register(withdrawalId, tenantId, now) {
      await db.query("INSERT INTO shared.withdrawal_directory (withdrawal_id, tenant_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (withdrawal_id) DO NOTHING", [
        withdrawalId,
        tenantId.toLowerCase(),
        now,
      ]);
      const stored = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.withdrawal_directory WHERE withdrawal_id = $1", [withdrawalId]);
      const row = stored.rows[0];
      if (!row) throw new Error(`The withdrawal directory has no row for ${withdrawalId} right after its insert`);
      return row.tenant_id;
    },
  };
}

// ---- Parked events ---------------------------------------------------------------------------------------------------

interface ParkedDbRow {
  consumer: string;
  stream_sequence: string;
  subject: string;
  payload: string;
  reason: string;
  deliveries: number;
  parked_at: Date;
}

const toParkedEvent = (row: ParkedDbRow): ParkedEvent => ({
  consumer: row.consumer,
  streamSequence: toNumber(row.stream_sequence, "stream_sequence"),
  subject: row.subject,
  payload: row.payload,
  reason: row.reason,
  deliveries: row.deliveries,
  parkedAt: row.parked_at,
});

function parkedEventRepository(db: Queryable): ParkedEventRepository {
  return {
    async park(event) {
      // The same message parked again (a crash between park and ack, a failed rerun) keeps its row with the new reason.
      // A different message under the same stream sequence (the stream was deleted and created again, so sequences
      // restart at 1) never replaces the parked one: the update does not match, nothing is written and the call fails,
      // so the message is not acknowledged and is delivered again.
      const result = await db.query(
        `INSERT INTO shared.parked_events (consumer, stream_sequence, subject, payload, reason, deliveries, parked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (consumer, stream_sequence)
         DO UPDATE SET reason = EXCLUDED.reason, deliveries = EXCLUDED.deliveries, parked_at = EXCLUDED.parked_at
         WHERE shared.parked_events.payload = EXCLUDED.payload`,
        [event.consumer, event.streamSequence, event.subject, event.payload, event.reason.slice(0, MAX_ERROR_LENGTH), event.deliveries, event.parkedAt],
      );
      if (result.rowCount === 0) throw new Error(`A different event is already parked under ${event.consumer} #${String(event.streamSequence)}; handle it first (npm run parked)`);
    },
    async list(consumer, limit) {
      const result = await db.query<ParkedDbRow>(
        `SELECT consumer, stream_sequence, subject, payload, reason, deliveries, parked_at
           FROM shared.parked_events
          WHERE ($1::text IS NULL OR consumer = $1)
          ORDER BY parked_at, consumer, stream_sequence
          LIMIT $2`,
        [consumer, limit],
      );
      return result.rows.map(toParkedEvent);
    },
    async remove(consumer, streamSequence) {
      await db.query("DELETE FROM shared.parked_events WHERE consumer = $1 AND stream_sequence = $2", [consumer, streamSequence]);
    },
  };
}

// ---- Ledger ----------------------------------------------------------------------------------------------------------

interface LedgerDbRow {
  position: string;
  stream_id: string;
  version: number;
  type: LedgerEventType;
  business_key: string;
  data: unknown;
  meta: RecordedLedgerEvent["meta"];
  recorded_at: Date;
}

const LEDGER_COLUMNS = "position, stream_id, version, type, business_key, data, meta, recorded_at";

function toRecordedEvent(row: LedgerDbRow): RecordedLedgerEvent {
  const event = { type: row.type, data: row.data } as LedgerEvent;
  return {
    ...event,
    position: toNumber(row.position, "position"),
    streamId: row.stream_id,
    version: row.version,
    businessKey: row.business_key,
    meta: row.meta,
    recordedAt: row.recorded_at,
  };
}

/** The unique violation of the ledger that a use case answers by deciding again (DM-07, DM-10), or undefined for any other error. */
function ledgerConflictOf(error: unknown, streamId: string): LedgerConflict | undefined {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code !== "23505") return undefined;
  if (constraint === "ledger_events_stream_version_key") return new LedgerConflict("version", streamId);
  if (constraint === "ledger_events_type_business_key_key") return new LedgerConflict("business_key", streamId);
  return undefined;
}

function ledgerRepository(db: Queryable, tenantId: string): LedgerRepository {
  const schema = tenantSchemaIdentifier(tenantId);
  const table = `${schema}.ledger_events`;
  return {
    async append(request) {
      const { streamId, expectedVersion, events, meta, recordedAt } = request;
      const recorded: RecordedLedgerEvent[] = [];
      let version = expectedVersion;
      for (const event of events) {
        version += 1;
        const businessKey = businessKeyOf(streamId, event);
        let inserted: pg.QueryResult<{ position: string }>;
        try {
          // The WHERE states the expected version, so an append that skipped or repeated a version is refused even when
          // the slot is free; the UNIQUE (stream_id, version) is the race guard for concurrent appends (DM-07).
          inserted = await db.query<{ position: string }>(
            `INSERT INTO ${table} (stream_id, version, type, business_key, data, meta, recorded_at)
             SELECT $1::text, $2::integer, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::timestamptz
              WHERE $2::integer - 1 = (SELECT coalesce(max(version), 0) FROM ${table} WHERE stream_id = $1::text)
             RETURNING position`,
            [streamId, version, event.type, businessKey, JSON.stringify(event.data), JSON.stringify(meta), recordedAt],
          );
        } catch (error) {
          throw ledgerConflictOf(error, streamId) ?? error;
        }
        const row = inserted.rows[0];
        if (!row) throw new LedgerConflict("version", streamId);
        recorded.push({ ...event, position: toNumber(row.position, "position"), streamId, version, businessKey, meta: { ...meta }, recordedAt: new Date(recordedAt) });
      }
      return recorded;
    },
    async readStream(streamId, options = {}) {
      const params: unknown[] = [streamId];
      let where = "stream_id = $1";
      if (options.types !== undefined) {
        params.push([...options.types]);
        where += ` AND type = ANY($${String(params.length)}::text[])`;
      }
      let limit = "";
      if (options.limit !== undefined) {
        params.push(options.limit);
        limit = ` LIMIT $${String(params.length)}`;
      }
      const direction = options.order === "desc" ? "DESC" : "ASC";
      const result = await db.query<LedgerDbRow>(`SELECT ${LEDGER_COLUMNS} FROM ${table} WHERE ${where} ORDER BY version ${direction}${limit}`, params);
      return result.rows.map(toRecordedEvent);
    },
    async findByKey(type, businessKey) {
      const result = await db.query<LedgerDbRow>(`SELECT ${LEDGER_COLUMNS} FROM ${table} WHERE type = $1 AND business_key = $2`, [type, businessKey]);
      const row = result.rows[0];
      return row ? toRecordedEvent(row) : null;
    },
    async readAll(afterPosition, limit) {
      const result = await db.query<LedgerDbRow>(`SELECT ${LEDGER_COLUMNS} FROM ${table} WHERE position > $1 ORDER BY position LIMIT $2`, [afterPosition, limit]);
      return result.rows.map(toRecordedEvent);
    },
    async marketPayments(marketId) {
      if (!UUID_PATTERN.test(marketId)) return [];
      // Sums in numeric (bigint SUM), returned as text; every sum is checked to be a safe integer by toNumber.
      const result = await db.query<{ stream_id: string; paid: string; returned: string }>(
        // A sale (SharesSold, UC-08) paid costMicro for the other side and got sharesMicro back from the pairs.
        `SELECT stream_id,
                coalesce(sum((data ->> 'costMicro')::bigint) FILTER (WHERE type IN ('SharesBought', 'SharesSold')), 0)::text AS paid,
                (coalesce(sum((data ->> 'pairsMicro')::bigint) FILTER (WHERE type = 'PairsRedeemed'), 0)
                  + coalesce(sum((data ->> 'sharesMicro')::bigint) FILTER (WHERE type = 'SharesSold'), 0))::text AS returned
           FROM ${table}
          WHERE type IN ('SharesBought', 'SharesSold', 'PairsRedeemed') AND data ->> 'marketId' = $1 AND stream_id LIKE 'account:%'
          GROUP BY stream_id
          ORDER BY stream_id COLLATE "C"`,
        [marketId.toLowerCase()],
      );
      return result.rows.map((row) => ({ streamId: row.stream_id, paidMicro: toNumber(row.paid, "paid"), returnedMicro: toNumber(row.returned, "returned") }));
    },
    async lockForReplay() {
      // The order of the layout: the use cases lock their account rows before they append, so a transaction that holds
      // the ledger already holds an account. Only an append that creates its account row (the first event of a stream)
      // takes the ledger before the accounts; the deadlock that can make with this lock is resolved by the store, which
      // turns it into a LedgerConflict, and the transaction is decided again (PostgresStore.tenantStore).
      await db.query(`LOCK TABLE ${schema}.accounts, ${schema}.positions, ${table} IN EXCLUSIVE MODE`);
    },
  };
}

// ---- Accounts and positions ------------------------------------------------------------------------------------------

interface AccountDbRow {
  stream_id: string;
  kind: AccountKind;
  owner_id: string | null;
  market_id: string | null;
  balance_micro: string;
  version: number;
}

interface PositionDbRow {
  stream_id: string;
  market_id: string;
  yes_micro: string;
  no_micro: string;
}

const ACCOUNT_COLUMNS = "stream_id, kind, owner_id, market_id, balance_micro, version";

const toAccount = (row: AccountDbRow, positions: Record<string, Holding>): AccountState => ({
  streamId: row.stream_id,
  kind: row.kind,
  ownerId: row.owner_id,
  marketId: row.market_id,
  balanceMicro: toNumber(row.balance_micro, "balance_micro"),
  positions,
  version: row.version,
});

const toHolding = (row: PositionDbRow): Holding => ({ yesMicro: toNumber(row.yes_micro, "yes_micro"), noMicro: toNumber(row.no_micro, "no_micro") });

function accountRepository(db: Queryable, tenantId: string): AccountRepository {
  const schema = tenantSchemaIdentifier(tenantId);
  const accounts = `${schema}.accounts`;
  const positions = `${schema}.positions`;

  /** The positions of the given streams (of the given markets only, when named), grouped by stream. */
  async function positionsOf(streamIds: readonly string[], marketIds?: readonly string[]): Promise<Map<string, Record<string, Holding>>> {
    const grouped = new Map<string, Record<string, Holding>>();
    if (streamIds.length === 0) return grouped;
    const params: unknown[] = [[...streamIds]];
    let filter = "";
    if (marketIds !== undefined) {
      const ids = onlyUuids(marketIds);
      if (ids.length === 0) return grouped;
      params.push(ids);
      filter = " AND market_id = ANY($2::uuid[])";
    }
    const result = await db.query<PositionDbRow>(
      `SELECT stream_id, market_id, yes_micro, no_micro FROM ${positions} WHERE stream_id = ANY($1::text[])${filter} ORDER BY stream_id, market_id`,
      params,
    );
    for (const row of result.rows) {
      const held = grouped.get(row.stream_id) ?? {};
      held[row.market_id] = toHolding(row);
      grouped.set(row.stream_id, held);
    }
    return grouped;
  }

  async function withPositions(rows: readonly AccountDbRow[], marketIds?: readonly string[]): Promise<AccountState[]> {
    const held = await positionsOf(
      rows.map((row) => row.stream_id),
      marketIds,
    );
    return rows.map((row) => toAccount(row, held.get(row.stream_id) ?? {}));
  }

  return {
    async load(streamId, options = {}) {
      const result = await db.query<AccountDbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM ${accounts} WHERE stream_id = $1${options.lock === true ? " FOR UPDATE" : ""}`, [streamId]);
      const row = result.rows[0];
      if (!row) return null;
      const [account] = await withPositions([row], options.marketIds);
      return account ?? null;
    },
    async save(state, now) {
      await db.query(
        `INSERT INTO ${accounts} (stream_id, kind, owner_id, market_id, balance_micro, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (stream_id)
         DO UPDATE SET owner_id = EXCLUDED.owner_id, balance_micro = EXCLUDED.balance_micro, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
        [state.streamId, state.kind, state.ownerId, state.marketId, state.balanceMicro, state.version, now],
      );
      // The absolute values of exactly the positions in the state; a position with no shares is deleted.
      const kept: Array<[string, Holding]> = [];
      const gone: string[] = [];
      for (const [marketId, holding] of Object.entries(state.positions)) {
        if (holding.yesMicro === 0 && holding.noMicro === 0) gone.push(marketId);
        else kept.push([marketId, holding]);
      }
      if (gone.length > 0) await db.query(`DELETE FROM ${positions} WHERE stream_id = $1 AND market_id = ANY($2::uuid[])`, [state.streamId, gone]);
      if (kept.length > 0) {
        await db.query(
          `INSERT INTO ${positions} (stream_id, market_id, yes_micro, no_micro, updated_at)
           SELECT $1::text, p.market_id, p.yes_micro, p.no_micro, $5::timestamptz
             FROM unnest($2::uuid[], $3::bigint[], $4::bigint[]) AS p(market_id, yes_micro, no_micro)
           ON CONFLICT (stream_id, market_id)
           DO UPDATE SET yes_micro = EXCLUDED.yes_micro, no_micro = EXCLUDED.no_micro, updated_at = EXCLUDED.updated_at`,
          [state.streamId, kept.map(([marketId]) => marketId), kept.map(([, holding]) => holding.yesMicro), kept.map(([, holding]) => holding.noMicro), now],
        );
      }
    },
    async holdersOf(marketId, options = {}) {
      if (!UUID_PATTERN.test(marketId)) return [];
      // Exactly the SQL of the port's comment: the bot account has a positions row too and is never a holder; the
      // named streams (the creator) come whether they hold a position or not; locked in stream id order (COLLATE "C",
      // code-point order like lockOrder and the memory store: the database's own collation would order ids differently).
      const result = await db.query<AccountDbRow & { yes_micro: string | null; no_micro: string | null }>(
        `SELECT a.stream_id, a.kind, a.owner_id, a.market_id, a.balance_micro, a.version, p.yes_micro, p.no_micro
           FROM ${accounts} a
           LEFT JOIN ${positions} p ON p.stream_id = a.stream_id AND p.market_id = $1::uuid
          WHERE a.kind = 'user' AND (p.stream_id IS NOT NULL OR a.stream_id = ANY($2::text[]))
          ORDER BY a.stream_id COLLATE "C"${options.lock === true ? " FOR UPDATE OF a" : ""}`,
        [marketId.toLowerCase(), [...(options.alsoStreamIds ?? [])]],
      );
      return result.rows.map((row) =>
        toAccount(row, row.yes_micro === null || row.no_micro === null ? {} : { [marketId.toLowerCase()]: { yesMicro: toNumber(row.yes_micro, "yes_micro"), noMicro: toNumber(row.no_micro, "no_micro") } }),
      );
    },
    async botAccountsOwnedBy(ownerId) {
      const result = await db.query<AccountDbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM ${accounts} WHERE kind = 'bot' AND owner_id = $1 ORDER BY stream_id COLLATE "C"`, [ownerId]);
      return withPositions(result.rows);
    },
    async all() {
      const result = await db.query<AccountDbRow>(`SELECT ${ACCOUNT_COLUMNS} FROM ${accounts} ORDER BY stream_id COLLATE "C"`);
      return withPositions(result.rows);
    },
    async clear() {
      // Positions first: they reference the accounts.
      await db.query(`DELETE FROM ${positions}`);
      await db.query(`DELETE FROM ${accounts}`);
    },
  };
}

// ---- Market copies ---------------------------------------------------------------------------------------------------

interface MarketStateDbRow {
  market_id: string;
  version: number;
  status: MarketStatus;
  question: string | null;
  close_time: Date | null;
  starting_price_micro: string | null;
  creator_id: string | null;
  funding_micro: string | null;
  outcome: Outcome | null;
  trade_sequence: string;
  funded_at: Date | null;
  opened_at: Date | null;
  closed_at: Date | null;
  resolved_at: Date | null;
  settled_at: Date | null;
  payout_total_micro: string | null;
  returned_micro: string | null;
  updated_at: Date;
}

const MARKET_COLUMNS =
  "market_id, version, status, question, close_time, starting_price_micro, creator_id, funding_micro, outcome, trade_sequence, funded_at, opened_at, closed_at, resolved_at, settled_at, payout_total_micro, returned_micro, updated_at";

const toMarketState = (row: MarketStateDbRow): MarketState => ({
  marketId: row.market_id,
  version: row.version,
  status: row.status,
  question: row.question,
  closeTime: row.close_time,
  startingPriceMicro: toNullableNumber(row.starting_price_micro, "starting_price_micro"),
  creatorId: row.creator_id,
  fundingMicro: toNullableNumber(row.funding_micro, "funding_micro"),
  outcome: row.outcome,
  tradeSequence: toNumber(row.trade_sequence, "trade_sequence"),
  fundedAt: row.funded_at,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  resolvedAt: row.resolved_at,
  settledAt: row.settled_at,
  payoutTotalMicro: toNullableNumber(row.payout_total_micro, "payout_total_micro"),
  returnedMicro: toNullableNumber(row.returned_micro, "returned_micro"),
  updatedAt: row.updated_at,
});

const marketParams = (state: MarketState): unknown[] => [
  state.marketId,
  state.version,
  state.status,
  state.question,
  state.closeTime,
  state.startingPriceMicro,
  state.creatorId,
  state.fundingMicro,
  state.outcome,
  state.tradeSequence,
  state.fundedAt,
  state.openedAt,
  state.closedAt,
  state.resolvedAt,
  state.settledAt,
  state.payoutTotalMicro,
  state.returnedMicro,
  state.updatedAt,
];

function marketStateRepository(db: Queryable, tenantId: string): MarketStateRepository {
  const table = `${tenantSchemaIdentifier(tenantId)}.market_state`;
  return {
    async find(marketId, options = {}) {
      if (!UUID_PATTERN.test(marketId)) return null;
      const result = await db.query<MarketStateDbRow>(`SELECT ${MARKET_COLUMNS} FROM ${table} WHERE market_id = $1${options.lock === true ? " FOR UPDATE" : ""}`, [marketId.toLowerCase()]);
      const row = result.rows[0];
      return row ? toMarketState(row) : null;
    },
    async insert(state) {
      // ON CONFLICT DO NOTHING waits while a concurrent transaction holds an uncommitted row with the same id, then
      // inserts nothing: the caller finds the row with lock and decides again.
      const result = await db.query(
        `INSERT INTO ${table} (${MARKET_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (market_id) DO NOTHING`,
        marketParams(state),
      );
      return result.rowCount === 1;
    },
    async update(state) {
      const result = await db.query(
        `UPDATE ${table}
            SET version = $2, status = $3, question = $4, close_time = $5, starting_price_micro = $6, creator_id = $7,
                funding_micro = $8, outcome = $9, trade_sequence = $10, funded_at = $11, opened_at = $12, closed_at = $13,
                resolved_at = $14, settled_at = $15, payout_total_micro = $16, returned_micro = $17, updated_at = $18
          WHERE market_id = $1`,
        marketParams(state),
      );
      if (result.rowCount !== 1) throw new Error(`The market ${state.marketId} has no market_state row to update`);
    },
    async listByStatus(status, page) {
      if (page.afterId !== null && !UUID_PATTERN.test(page.afterId)) return [];
      const result = await db.query<MarketStateDbRow>(
        `SELECT ${MARKET_COLUMNS} FROM ${table} WHERE status = $1 AND ($2::uuid IS NULL OR market_id > $2::uuid) ORDER BY market_id LIMIT $3`,
        [status, page.afterId === null ? null : page.afterId.toLowerCase(), page.limit],
      );
      return result.rows.map(toMarketState);
    },
    async findMany(marketIds) {
      const ids = onlyUuids(marketIds);
      if (ids.length === 0) return [];
      const result = await db.query<MarketStateDbRow>(`SELECT ${MARKET_COLUMNS} FROM ${table} WHERE market_id = ANY($1::uuid[]) ORDER BY market_id`, [ids]);
      return result.rows.map(toMarketState);
    },
  };
}

// ---- Bot offers ------------------------------------------------------------------------------------------------------

interface BotOrderDbRow {
  side: Side;
  price_micro: number;
  shares_micro: string;
  priced_on_sequence: string | null;
  placed_at: Date;
}

function botOrderRepository(db: Queryable, tenantId: string): BotOrderRepository {
  const table = `${tenantSchemaIdentifier(tenantId)}.bot_orders`;
  return {
    async get(marketId): Promise<BotOrderBook> {
      const empty: BotOrderBook = { marketId, offers: [], pricedOnSequence: null, placedAt: null };
      if (!UUID_PATTERN.test(marketId)) return empty;
      const result = await db.query<BotOrderDbRow>(
        `SELECT side, price_micro, shares_micro, priced_on_sequence, placed_at FROM ${table} WHERE market_id = $1`,
        [marketId.toLowerCase()],
      );
      const first = result.rows[0];
      if (!first) return empty;
      const offers: Offer[] = result.rows.map((row) => ({ side: row.side, priceMicro: row.price_micro, sharesMicro: toNumber(row.shares_micro, "shares_micro") }));
      return { marketId, offers: sortOffers(offers), pricedOnSequence: toNullableNumber(first.priced_on_sequence, "priced_on_sequence"), placedAt: first.placed_at };
    },
    async replace(marketId, offers, pricedOnSequence, now) {
      await db.query(`DELETE FROM ${table} WHERE market_id = $1`, [marketId]);
      // The table holds one row per offer: no offers, no rows, so the book reads as never placed.
      if (offers.length === 0) return;
      await db.query(
        `INSERT INTO ${table} (market_id, side, price_micro, shares_micro, priced_on_sequence, placed_at)
         SELECT $1::uuid, o.side, o.price_micro, o.shares_micro, $5::bigint, $6::timestamptz
           FROM unnest($2::text[], $3::integer[], $4::bigint[]) AS o(side, price_micro, shares_micro)`,
        [marketId, offers.map((offer) => offer.side), offers.map((offer) => offer.priceMicro), offers.map((offer) => offer.sharesMicro), pricedOnSequence, now],
      );
    },
    async clear(marketId) {
      await db.query(`DELETE FROM ${table} WHERE market_id = $1`, [marketId]);
    },
  };
}

// ---- Idempotency keys ------------------------------------------------------------------------------------------------

interface IdempotencyDbRow {
  request_hash: string;
  result: unknown;
  created_at: Date;
}

function idempotencyRepository(db: Queryable, tenantId: string): IdempotencyRepository {
  const table = `${tenantSchemaIdentifier(tenantId)}.idempotency_keys`;
  return {
    async claim({ scope, key, requestHash, now }) {
      // INSERT ... ON CONFLICT DO NOTHING waits while another transaction holds the same key: after that transaction's
      // commit it inserts nothing and the SELECT below (a new statement, so a new snapshot) sees the completed row;
      // after its rollback the insert simply succeeds.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const inserted = await db.query(
          `INSERT INTO ${table} (scope, key, request_hash, result, created_at) VALUES ($1, $2, $3, NULL, $4) ON CONFLICT (scope, key) DO NOTHING`,
          [scope, key, requestHash, now],
        );
        if (inserted.rowCount === 1) return { kind: "claimed" };
        const existing = await db.query<IdempotencyDbRow>(`SELECT request_hash, result, created_at FROM ${table} WHERE scope = $1 AND key = $2`, [scope, key]);
        const row = existing.rows[0];
        if (row !== undefined) {
          if (row.request_hash !== requestHash) return { kind: "mismatch" };
          if (row.result !== null) return { kind: "replay", result: row.result, createdAt: row.created_at };
        }
        // No row (the key was purged in between) or a row without a result: the claim of a transaction that has
        // ended without completing; the insert is tried once more.
      }
      throw new Error(`The idempotency key ${scope}/${key} is held without a result`);
    },
    async complete(scope, key, result) {
      const updated = await db.query(`UPDATE ${table} SET result = $3::jsonb WHERE scope = $1 AND key = $2`, [scope, key, JSON.stringify(result ?? null)]);
      if (updated.rowCount !== 1) throw new Error(`The idempotency key ${scope}/${key} was not claimed`);
    },
    async purge(scopePrefix, olderThan) {
      const result = await db.query(`DELETE FROM ${table} WHERE starts_with(scope, $1) AND created_at < $2`, [scopePrefix, olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

// ---- The store -------------------------------------------------------------------------------------------------------

/** The shared repositories over one connection (inside a transaction) or over the pool (each call on its own). */
export function sharedRepositoriesOver(db: Queryable, inTransaction: boolean, logger: Logger): SharedRepositories {
  return {
    outbox: outboxRepository(db),
    inbox: inboxRepository(db),
    tenants: tenantRegistry(db, inTransaction, logger),
    marketDirectory: marketDirectory(db),
    withdrawalDirectory: withdrawalDirectory(db),
    parkedEvents: parkedEventRepository(db),
  };
}

function tenantRepositoriesOver(db: Queryable, inTransaction: boolean, tenantId: string, logger: Logger): TenantRepositories {
  return {
    ...sharedRepositoriesOver(db, inTransaction, logger),
    ledger: ledgerRepository(db, tenantId),
    accounts: accountRepository(db, tenantId),
    marketStates: marketStateRepository(db, tenantId),
    botOrders: botOrderRepository(db, tenantId),
    idempotency: idempotencyRepository(db, tenantId),
  };
}

/**
 * PostgreSQL ends one of two transactions that wait for each other (SQLSTATE 40P01). A tenant transaction decides its
 * work again from the current state like a lost append does, so it is reported as a LedgerConflict: the use case's
 * retry (withConflictRetry) runs it again, and only a third failure becomes a 503. The one place such a deadlock can
 * arise is the replay's table lock against an append that creates the first row of a new account.
 */
function deadlockAsConflict(error: unknown): unknown {
  if ((error as { code?: string } | null)?.code === "40P01") {
    return new LedgerConflict("version", "deadlock", "The transaction was ended by the database to resolve a deadlock; decide again");
  }
  return error;
}

export class PostgresStore implements Store {
  readonly repositories: SharedRepositories;
  /** Tenants known to be registered: a registration is never undone, so a positive answer is kept. */
  private readonly registered = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger = silent,
  ) {
    this.repositories = sharedRepositoriesOver(pool, false, logger);
  }

  /** One transaction on one connection: BEGIN, the work, COMMIT; ROLLBACK when the work throws. */
  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction((client) => work(sharedRepositoriesOver(client, true, this.logger)));
  }

  private tenantStore(id: string): TenantStore {
    return {
      tenantId: id,
      repositories: tenantRepositoriesOver(this.pool, false, id, this.logger),
      transaction: async (work) => {
        try {
          return await this.inTransaction((client) => work(tenantRepositoriesOver(client, true, id, this.logger)));
        } catch (error) {
          throw deadlockAsConflict(error);
        }
      },
    };
  }

  async forTenant(tenantId: string): Promise<TenantStore | null> {
    if (!isTenantId(tenantId)) return null;
    const id = tenantId.toLowerCase();
    if (!this.registered.has(id)) {
      if (!(await this.repositories.tenants.isRegistered(id))) return null;
      this.registered.add(id);
    }
    return this.tenantStore(id);
  }

  async ensureTenant(tenantId: string, now: Date): Promise<TenantStore> {
    const id = parseTenantId(tenantId);
    const existing = await this.forTenant(id);
    if (existing) return existing;
    // The same idempotent work as TenantCreated, under the migrator's advisory lock: schema, migrations, registry row.
    await this.inTransaction((client) => provisionTenantSchema(client, id, now, this.logger));
    this.registered.add(id);
    return this.tenantStore(id);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

/**
 * The connection pool. An idle connection that the server drops raises "error" on the pool; without a listener that
 * would end the process, so it is logged (when a logger is given) and the pool opens a new connection when needed.
 */
export function createPool(connectionString: string, max: number, logger: Logger = silent): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
  pool.on("error", (error) => {
    logger.warn({ err: error }, "An idle database connection failed");
  });
  return pool;
}
