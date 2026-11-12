import type { CloudEvent } from "../domain/events.js";
import type { AccountState, LedgerEvent, LedgerEventType, LedgerMeta } from "../domain/ledger.js";
import type { MarketPayment } from "../domain/settlement.js";
import type { MarketState, MarketStatus } from "../domain/market-state.js";
import type { Offer } from "../domain/order-book.js";

// Ports: everything a use case needs from the outside world. Adapters implement them (ADR-001).

/** Who is acting and which request it is, for the ledger meta and the events a use case writes. */
export interface Caller {
  userId: string;
  correlationId: string;
  /** The id of the request that caused the work; it becomes "causationid" of the events. */
  causationId: string;
}

/** The two roles of a tenant that may use trading. A platform admin is refused by the web layer before any use case. */
export type TradingRole = "trader" | "tenant-admin";

/** A caller of the public endpoints: the tenant and the role come only from the token (plan section 9). */
export interface Actor extends Caller {
  /** The tenant of the token, a UUID in lower case. */
  tenantId: string;
  role: TradingRole;
}

/** The three services that call the internal port, by the identity provider's client id (ADR-017, ADR-019). */
export type ServiceClient = "markets" | "payments" | "market-maker";

/** A caller of the internal endpoints: a service account; the tenant comes from the request body or the market. */
export interface ServiceCaller {
  client: ServiceClient;
  correlationId: string;
  causationId: string;
}

// The ledger: the table "ledger_events" of the tenant's schema (DM-07, migrations/tenant).

/** An event as stored: the domain event plus its place in the store. */
export type RecordedLedgerEvent = LedgerEvent & {
  /** Global order of appends in the tenant's schema (bigint identity). */
  position: number;
  streamId: string;
  /** 1, 2, ... per stream; UNIQUE (stream_id, version). */
  version: number;
  /** businessKeyOf(streamId, event); UNIQUE (type, business_key) (DM-10). */
  businessKey: string;
  meta: LedgerMeta;
  recordedAt: Date;
};

export interface AppendRequest {
  streamId: string;
  /** The version of the last event the decision saw (0 for a new stream): the new events get expected + 1, + 2, ... */
  expectedVersion: number;
  events: readonly LedgerEvent[];
  meta: LedgerMeta;
  recordedAt: Date;
}

export interface LedgerRepository {
  /**
   * Appends the events after `expectedVersion` (optimistic concurrency, DM-07). Throws LedgerConflict (usecases/errors)
   * when another append took one of the versions or one of the business keys; the transaction must then be rolled
   * back and decided again. The code never updates or deletes this table, and the append-only trigger refuses it; the
   * service's single database role owns the table, so grants cannot limit it further (ADR-056 records this gap).
   */
  append(request: AppendRequest): Promise<RecordedLedgerEvent[]>;
  /** The events of one stream by version, ascending by default; `types` filters, `limit` caps (newest first with "desc"). */
  readStream(streamId: string, options?: { types?: readonly LedgerEventType[]; limit?: number; order?: "asc" | "desc" }): Promise<RecordedLedgerEvent[]>;
  /** The event of `type` with this business key, or null (a deposit credited, a withdrawal debited, a market funded ...). */
  findByKey(type: LedgerEventType, businessKey: string): Promise<RecordedLedgerEvent | null>;
  /** Up to `limit` events with position > afterPosition, by position (replay). */
  readAll(afterPosition: number, limit: number): Promise<RecordedLedgerEvent[]>;
  /**
   * The payments of every user stream into one market (INVALID settlement, UC-16), by stream id (code-point order): the
   * sum of its SharesBought and SharesSold costMicro (paid) and of its SharesSold sharesMicro and PairsRedeemed pairsMicro
   * (returned) of this market; streams with none of them are left
   * out, bot streams always. Read under the market_state lock, which every trade and sale of the market takes first.
   */
  marketPayments(marketId: string): Promise<MarketPayment[]>;
  /**
   * Replay only, first statement of its transaction: `LOCK TABLE accounts, positions, ledger_events IN EXCLUSIVE MODE`
   * (in this order: every use case locks its account rows before it appends, so the orders match and no deadlock
   * arises). Appends and projection writes wait until the replay commits; plain reads go on. The replay then reads the
   * ledger and the projections in the same transaction, so it compares and rewrites one consistent state.
   */
  lockForReplay(): Promise<void>;
}

// The projections of the ledger: tables "accounts" and "positions" of the tenant's schema, updated in the same
// transaction as the append (DM-07) and rebuildable by replay.

export interface AccountLoadOptions {
  /** SELECT ... FOR UPDATE of the account row until the end of the transaction. */
  lock?: boolean;
  /** The markets whose positions are loaded; all positions of the account when omitted. */
  marketIds?: readonly string[];
}

export interface AccountRepository {
  /** The projection of a stream, or null while the stream has no event yet (the use case starts from an empty state). */
  load(streamId: string, options?: AccountLoadOptions): Promise<AccountState | null>;
  /**
   * Writes the projection after an append: balance and version of the account (inserted when new) and the absolute
   * values of exactly the positions in `state.positions` (a position with zero shares is deleted).
   */
  save(state: AccountState, now: Date): Promise<void>;
  /**
   * The user accounts a settlement needs, each exactly once, ordered (and with `lock` locked) by stream id, each with
   * this market's position loaded: every account of kind "user" with a non-empty position in the market (never the bot
   * account, although it has a positions row too), plus the user accounts named in `alsoStreamIds` (the creator) whether
   * they hold a position or not. A named stream without an account row is left out: the use case adds
   * `emptyUserAccount` for it. SQL: accounts a LEFT JOIN positions p ON (stream, market) WHERE a.kind = 'user' AND
   * (p.stream_id IS NOT NULL OR a.stream_id = ANY(alsoStreamIds)) ORDER BY a.stream_id FOR UPDATE OF a.
   */
  holdersOf(marketId: string, options?: { lock?: boolean; alsoStreamIds?: readonly string[] }): Promise<AccountState[]>;
  /** The bot accounts whose owner is this user: the markets they funded (portfolio of a tenant admin). */
  botAccountsOwnedBy(ownerId: string): Promise<AccountState[]>;
  /** Every account with all its positions (replay comparison). */
  all(): Promise<AccountState[]>;
  /** Deletes every account and position (only the replay with rebuild does this, in its transaction). */
  clear(): Promise<void>;
}

// The market copy and the order book: tables "market_state" and "bot_orders" of the tenant's schema.

export interface MarketStateRepository {
  find(marketId: string, options?: { lock?: boolean }): Promise<MarketState | null>;
  /** INSERT ... ON CONFLICT DO NOTHING: false when the row existed already (then find it with lock and decide again). */
  insert(state: MarketState): Promise<boolean>;
  update(state: MarketState): Promise<void>;
  /** Markets in a status, by id ascending, after `afterId` (null: from the start). */
  listByStatus(status: MarketStatus, page: { limit: number; afterId: string | null }): Promise<MarketState[]>;
  /** The copies of these markets (unknown ids are left out). */
  findMany(marketIds: readonly string[]): Promise<MarketState[]>;
}

export interface BotOrderBook {
  marketId: string;
  /** YES before NO, cheapest first (sortOffers). */
  offers: Offer[];
  /**
   * The trade sequence the bot priced these offers on (column priced_on_sequence); null when it has placed none. A fill
   * keeps it, so after a trade it is lower than the market's trade sequence: never the value a PUT must send.
   */
  pricedOnSequence: number | null;
  placedAt: Date | null;
}

export interface BotOrderRepository {
  get(marketId: string): Promise<BotOrderBook>;
  /** Replaces the whole book of the market (ADR-041), also after a fill with the remaining offers. */
  replace(marketId: string, offers: readonly Offer[], pricedOnSequence: number | null, now: Date): Promise<void>;
  /** Cancels every offer of the market (MarketClosed, MarketResolved). */
  clear(marketId: string): Promise<void>;
}

/** Idempotency keys (REL-03): table "idempotency_keys" of the tenant's schema. */
export type IdempotencyClaim =
  /** The key is new and now held by this transaction (other transactions with it wait for the commit). */
  | { kind: "claimed" }
  /** The key completed before with the same request: answer with the stored result. */
  | { kind: "replay"; result: unknown; createdAt: Date }
  /** The key completed before with another request (idempotency_key_reused). */
  | { kind: "mismatch" };

export interface IdempotencyRepository {
  /**
   * Inserts the key with the request's hash (INSERT ... ON CONFLICT DO NOTHING, which waits while another transaction
   * holds the same key), or reports the completed row. A transaction that rolls back leaves no key behind, so a refused
   * request is decided anew when it is repeated; only what `complete` wrote and the transaction committed is stored.
   */
  claim(input: { scope: string; key: string; requestHash: string; now: Date }): Promise<IdempotencyClaim>;
  /** Stores the result of the claimed key; call it in the same transaction, after the work. */
  complete(scope: string, key: string, result: unknown): Promise<void>;
  /** Deletes the keys of scopes starting with `scopePrefix` created before `olderThan`. Returns how many went. */
  purge(scopePrefix: string, olderThan: Date): Promise<number>;
}

// Shared tables (migrations/shared): outbox, inbox, tenant registry, market directory.

export interface OutboxMessage {
  /** Equals the id of the event; it is also the deduplication id on the broker. */
  id: string;
  aggregateId: string;
  /** NATS subject. */
  subject: string;
  type: string;
  /** The whole CloudEvent. */
  payload: CloudEvent<unknown>;
  createdAt: Date;
}

export interface OutboxRow extends OutboxMessage {
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /** As markets: unpublished rows, oldest first, locked for this transaction; one publishing instance at a time. */
  claimBatch(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string, at: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  purgePublished(olderThan: Date): Promise<number>;
}

export interface InboxEntry {
  /** One consumer per kind of event (ADR-053): "tenant-created", "market-events", "payment-events". */
  consumer: string;
  eventId: string;
  eventType: string;
  processedAt: Date;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING: true when new, false when processed before (REL-02, DM-06). */
  record(entry: InboxEntry): Promise<boolean>;
  purge(olderThan: Date): Promise<number>;
}

export interface TenantRegistry {
  /** As markets: create the schema if missing, apply the tenant migrations, register; idempotent; inside a transaction. */
  provision(tenantId: string, now: Date): Promise<void>;
  isRegistered(tenantId: string): Promise<boolean>;
  /** Every registered tenant id (the market maker's list of open markets, replay, retention). */
  list(): Promise<string[]>;
}

/**
 * Which tenant a market belongs to (table shared.market_directory): the internal endpoints of the market maker name
 * only a market, and trading takes the tenant from it, never from the token (plan section 9, ADR-019).
 */
export interface MarketDirectory {
  /** Records the market's tenant; idempotent. Returns the tenant stored for the market (the first one ever recorded). */
  register(marketId: string, tenantId: string, now: Date): Promise<string>;
  tenantOf(marketId: string): Promise<string | null>;
}

/**
 * Which tenant a withdrawal was debited in (table shared.withdrawal_directory): the debit's idempotency key and ledger
 * key live in the tenant's schema, so a withdrawal id repeated with another tenant is only caught here (422).
 */
export interface WithdrawalDirectory {
  /** Records the withdrawal's tenant; idempotent. Returns the tenant stored for it (the first one ever recorded). */
  register(withdrawalId: string, tenantId: string, now: Date): Promise<string>;
}

/**
 * A consumed event that failed `PARK_AFTER_DELIVERIES` times in a row (table shared.parked_events, primary key
 * (consumer, stream_sequence)). The consumer parks it and acks, so one failing event cannot hold back the others; the
 * operator command `npm run parked` lists parked events and runs them again through the same handler (the inbox and the
 * ledger keys make a repeat harmless), deleting each one that is then acked.
 */
export interface ParkedEvent {
  /** "tenant-created", "market-events" or "payment-events". */
  consumer: string;
  /** The JetStream stream sequence of the message: unique per stream, known even for a body that is not JSON. */
  streamSequence: number;
  subject: string;
  /** The raw message body as UTF-8 text. */
  payload: string;
  /** The last error (message and code), never a token. */
  reason: string;
  deliveries: number;
  parkedAt: Date;
}

export interface ParkedEventRepository {
  /**
   * INSERT ... ON CONFLICT (consumer, stream_sequence) DO UPDATE reason, deliveries, parked_at, only while the stored
   * payload is the same message. A different message under that key (sequences restart when a stream is created again)
   * rejects and leaves the parked row as it is, so an unprocessed event is never overwritten.
   */
  park(event: ParkedEvent): Promise<void>;
  /** Oldest first. */
  list(consumer: string | null, limit: number): Promise<ParkedEvent[]>;
  remove(consumer: string, streamSequence: number): Promise<void>;
}

export interface SharedRepositories {
  outbox: OutboxRepository;
  inbox: InboxRepository;
  tenants: TenantRegistry;
  marketDirectory: MarketDirectory;
  withdrawalDirectory: WithdrawalDirectory;
  parkedEvents: ParkedEventRepository;
}

/** The repositories of one tenant: its own schema's tables and the shared ones, in the same transaction. */
export interface TenantRepositories extends SharedRepositories {
  ledger: LedgerRepository;
  accounts: AccountRepository;
  marketStates: MarketStateRepository;
  botOrders: BotOrderRepository;
  idempotency: IdempotencyRepository;
}

export interface TenantStore {
  readonly tenantId: string;
  /** Repositories outside a transaction: each call is on its own. */
  readonly repositories: TenantRepositories;
  /** Everything the callback does through the given repositories commits together or not at all. */
  transaction<T>(work: (repositories: TenantRepositories) => Promise<T>): Promise<T>;
}

export interface Store {
  readonly repositories: SharedRepositories;
  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T>;
  /** The store of a registered tenant, or null while its TenantCreated has not been processed (TenantNotReady, 503). */
  forTenant(tenantId: string): Promise<TenantStore | null>;
  /**
   * The store of the tenant, provisioning its schema first when it is not registered yet (the same idempotent work as
   * TenantCreated: schema, tenant migrations, registry row, under the migrator's lock). Only for tenant ids that come
   * from trusted services, never from a user token: markets' and payments' events and the funding and debit bodies. A
   * tenant created before trading's TENANTS consumer existed (TENANTS keeps 30 days by default) is therefore never stuck.
   */
  ensureTenant(tenantId: string, now: Date): Promise<TenantStore>;
  ping(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** A UUIDv7. */
  newId(): string;
}

/** The trading limits that may change while the service runs (runtime configuration, ADR-037). */
export interface TradingRules {
  /** The largest amount of one order, in whole credits (at most payments' 1 000 000). */
  orderAmountMax: number;
  /** The most offers per side the bot may post (at most MAX_OFFERS_PER_SIDE_LIMIT). */
  maxOffersPerSide: number;
  /** False pauses new orders and sales (503 orders_paused); quotes, funding, debits and events go on. */
  ordersEnabled: boolean;
}

export interface TradingRulesSource {
  current(): TradingRules;
}

/** Publishes one event to the broker; used by the outbox relay. */
export interface EventPublisher {
  publish(subject: string, event: CloudEvent<unknown>, messageId: string): Promise<void>;
}

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

/** What the use cases need. */
export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

/** The order and bot use cases also read the runtime rules. */
export interface RuleDeps extends UseCaseDeps {
  rules: TradingRulesSource;
}
