import { businessKeyOf, parseStreamId, USER_STREAM_PREFIX } from "../../domain/ledger.js";
import type { AccountState, Holding } from "../../domain/ledger.js";
import { MARKET_STATUSES } from "../../domain/market-state.js";
import type { MarketState } from "../../domain/market-state.js";
import { sortOffers } from "../../domain/order-book.js";
import type { MarketPayment } from "../../domain/settlement.js";
import { addMicro, isMicroQuantity, isOutcome, isPriceMicro, isSide } from "../../domain/units.js";
import { LedgerConflict } from "../../usecases/errors.js";
import type {
  AccountRepository,
  BotOrderBook,
  BotOrderRepository,
  IdempotencyRepository,
  InboxEntry,
  LedgerRepository,
  Logger,
  MarketStateRepository,
  OutboxRow,
  ParkedEvent,
  RecordedLedgerEvent,
  SharedRepositories,
  Store,
  TenantRepositories,
  TenantStore,
} from "../../usecases/ports.js";

/** A stored idempotency key; `result` stays undefined until the claiming transaction completes it. */
interface IdempotencyRow {
  scope: string;
  key: string;
  requestHash: string;
  result: unknown;
  createdAt: Date;
}

/** The tables of one tenant's schema. */
interface TenantData {
  ledger: RecordedLedgerEvent[];
  accounts: AccountState[];
  marketStates: MarketState[];
  botOrders: BotOrderBook[];
  idempotency: IdempotencyRow[];
}

/** A deep copy of everything the store holds, as the PostgreSQL tables would, for assertions in tests. */
export interface MemorySnapshot {
  /** The tenant registry. */
  tenants: string[];
  /** shared.market_directory: market id -> tenant id. */
  directory: Record<string, string>;
  /** shared.withdrawal_directory: withdrawal id -> tenant id. */
  withdrawals: Record<string, string>;
  outbox: OutboxRow[];
  inbox: InboxEntry[];
  /** shared.parked_events. */
  parked: ParkedEvent[];
  tenantData: Record<string, TenantData>;
}

/** How a repository reaches the data and runs one operation: on the live data (queued) or on a transaction's draft. */
interface Access {
  state: () => MemorySnapshot;
  run: <T>(operation: () => T) => Promise<T>;
}

const emptyState = (): MemorySnapshot => ({ tenants: [], directory: {}, withdrawals: {}, outbox: [], inbox: [], parked: [], tenantData: {} });
const emptyTenantData = (): TenantData => ({ ledger: [], accounts: [], marketStates: [], botOrders: [], idempotency: [] });

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function tenantData(state: MemorySnapshot, tenantId: string): TenantData {
  const data = state.tenantData[tenantId];
  if (!data) throw new Error(`The tenant ${tenantId} has no schema`);
  return data;
}

function sharedRepositories({ state, run }: Access): SharedRepositories {
  return {
    outbox: {
      add: (message) =>
        run(() => {
          state().outbox.push({ ...structuredClone(message), publishedAt: null, attempts: 0, lastError: null });
        }),
      // In the order of writing, as the table's seq column does; createdAt is only a time stamp.
      claimBatch: (limit) =>
        run(() =>
          state()
            .outbox.filter((row) => row.publishedAt === null)
            .slice(0, limit)
            .map((row) => structuredClone(row)),
        ),
      markPublished: (id, at) =>
        run(() => {
          const row = state().outbox.find((candidate) => candidate.id === id);
          if (row) row.publishedAt = at;
        }),
      markFailed: (id, error) =>
        run(() => {
          const row = state().outbox.find((candidate) => candidate.id === id);
          if (row) {
            row.attempts += 1;
            row.lastError = error;
          }
        }),
      purgePublished: (olderThan) =>
        run(() => {
          const rows = state().outbox;
          const kept = rows.filter((row) => row.publishedAt === null || row.publishedAt.getTime() >= olderThan.getTime());
          const purged = rows.length - kept.length;
          rows.splice(0, rows.length, ...kept);
          return purged;
        }),
    },
    inbox: {
      // INSERT ... ON CONFLICT DO NOTHING: the primary key is (consumer, event id).
      record: (entry) =>
        run(() => {
          const rows = state().inbox;
          if (rows.some((row) => row.consumer === entry.consumer && row.eventId === entry.eventId)) return false;
          rows.push({ ...entry });
          return true;
        }),
      purge: (olderThan) =>
        run(() => {
          const rows = state().inbox;
          const kept = rows.filter((row) => row.processedAt.getTime() >= olderThan.getTime());
          const purged = rows.length - kept.length;
          rows.splice(0, rows.length, ...kept);
          return purged;
        }),
    },
    tenants: {
      provision: (tenantId) =>
        run(() => {
          const current = state();
          if (!current.tenants.includes(tenantId)) current.tenants.push(tenantId);
          current.tenantData[tenantId] ??= emptyTenantData();
        }),
      isRegistered: (tenantId) => run(() => state().tenants.includes(tenantId)),
      list: () => run(() => [...state().tenants]),
    },
    marketDirectory: {
      // The table has a foreign key to the tenant registry and the primary key market_id.
      register: (marketId, tenantId) =>
        run(() => {
          const current = state();
          const stored = current.directory[marketId];
          if (stored !== undefined) return stored;
          if (!current.tenants.includes(tenantId)) throw new Error(`The tenant ${tenantId} is not registered`);
          current.directory[marketId] = tenantId;
          return tenantId;
        }),
      tenantOf: (marketId) => run(() => state().directory[marketId] ?? null),
    },
    withdrawalDirectory: {
      register: (withdrawalId, tenantId) =>
        run(() => {
          const current = state();
          const stored = current.withdrawals[withdrawalId];
          if (stored !== undefined) return stored;
          if (!current.tenants.includes(tenantId)) throw new Error(`The tenant ${tenantId} is not registered`);
          current.withdrawals[withdrawalId] = tenantId;
          return tenantId;
        }),
    },
    parkedEvents: {
      // INSERT ... ON CONFLICT (consumer, stream_sequence) DO UPDATE reason, deliveries, parked_at WHERE the payload is
      // the same; a different message under that key fails and changes nothing.
      park: (event) =>
        run(() => {
          const rows = state().parked;
          const index = rows.findIndex((row) => row.consumer === event.consumer && row.streamSequence === event.streamSequence);
          const existing = rows[index];
          if (existing === undefined) rows.push({ ...event });
          else if (existing.payload !== event.payload) throw new Error(`A different event is already parked under ${event.consumer} #${String(event.streamSequence)}; handle it first (npm run parked)`);
          else rows[index] = { ...existing, reason: event.reason, deliveries: event.deliveries, parkedAt: event.parkedAt };
        }),
      list: (consumer, limit) =>
        run(() =>
          state()
            .parked.filter((row) => consumer === null || row.consumer === consumer)
            .sort((a, b) => a.parkedAt.getTime() - b.parkedAt.getTime() || a.streamSequence - b.streamSequence)
            .slice(0, limit)
            .map((row) => structuredClone(row)),
        ),
      remove: (consumer, streamSequence) =>
        run(() => {
          const rows = state().parked;
          const kept = rows.filter((row) => !(row.consumer === consumer && row.streamSequence === streamSequence));
          rows.splice(0, rows.length, ...kept);
        }),
    },
  };
}

function ledgerRepository(tenantId: string, { state, run }: Access): LedgerRepository {
  const own = (): RecordedLedgerEvent[] => tenantData(state(), tenantId).ledger;
  return {
    append: (request) =>
      run(() => {
        const rows = own();
        // The table's CHECK on the stream id pattern and on the meta keys.
        if (parseStreamId(request.streamId) === null) throw new Error(`The stream id ${request.streamId} is not one of ours`);
        if (typeof request.meta.correlationId !== "string" || typeof request.meta.causationId !== "string" || typeof request.meta.actor !== "string") {
          throw new Error("The event meta needs correlationId, causationId and actor");
        }
        const current = rows.reduce((max, row) => (row.streamId === request.streamId ? Math.max(max, row.version) : max), 0);
        // UNIQUE (stream_id, version): another append took the version the decision was based on.
        if (current !== request.expectedVersion) throw new LedgerConflict("version", request.streamId);
        let position = rows.reduce((max, row) => Math.max(max, row.position), 0);
        const recorded: RecordedLedgerEvent[] = [];
        request.events.forEach((event, index) => {
          const businessKey = businessKeyOf(request.streamId, event);
          // UNIQUE (type, business_key): DM-10's last guard against a repeated deposit, debit, funding or settlement.
          if ([...rows, ...recorded].some((row) => row.type === event.type && row.businessKey === businessKey)) {
            throw new LedgerConflict("business_key", request.streamId);
          }
          position += 1;
          recorded.push({
            ...structuredClone(event),
            position,
            streamId: request.streamId,
            version: current + index + 1,
            businessKey,
            meta: { ...request.meta },
            recordedAt: new Date(request.recordedAt),
          });
        });
        rows.push(...recorded);
        return structuredClone(recorded);
      }),
    readStream: (streamId, options = {}) =>
      run(() => {
        const sign = options.order === "desc" ? -1 : 1;
        const types = options.types;
        const matching = own()
          .filter((row) => row.streamId === streamId && (types === undefined || types.includes(row.type)))
          .sort((a, b) => sign * (a.version - b.version));
        return structuredClone(options.limit === undefined ? matching : matching.slice(0, options.limit));
      }),
    findByKey: (type, businessKey) => run(() => structuredClone(own().find((row) => row.type === type && row.businessKey === businessKey) ?? null)),
    readAll: (afterPosition, limit) =>
      run(() =>
        structuredClone(
          own()
            .filter((row) => row.position > afterPosition)
            .sort((a, b) => a.position - b.position)
            .slice(0, limit),
        ),
      ),
    marketPayments: (marketId) =>
      run(() => {
        const sums = new Map<string, MarketPayment>();
        for (const row of own()) {
          if (!row.streamId.startsWith(USER_STREAM_PREFIX)) continue;
          if (!((row.type === "SharesBought" || row.type === "SharesSold" || row.type === "PairsRedeemed") && row.data.marketId === marketId.toLowerCase())) continue;
          const sum = sums.get(row.streamId) ?? { streamId: row.streamId, paidMicro: 0, returnedMicro: 0 };
          if (row.type === "SharesBought") sum.paidMicro = addMicro(sum.paidMicro, row.data.costMicro);
          else if (row.type === "SharesSold") {
            // A sale: the other side's shares were paid for, the pairs returned one microcredit each (UC-08).
            sum.paidMicro = addMicro(sum.paidMicro, row.data.costMicro);
            sum.returnedMicro = addMicro(sum.returnedMicro, row.data.sharesMicro);
          } else sum.returnedMicro = addMicro(sum.returnedMicro, row.data.pairsMicro);
          sums.set(row.streamId, sum);
        }
        return [...sums.values()].sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0));
      }),
    // Transactions run one by one here, so nothing can append between a replay's read and its rewrite.
    lockForReplay: () => run(() => undefined),
  };
}

function checkAccount(state: AccountState): void {
  // The CHECKs of the accounts and positions tables.
  if (!(Number.isSafeInteger(state.balanceMicro) && state.balanceMicro >= 0)) throw new Error(`The balance of ${state.streamId} would be ${state.balanceMicro}`);
  if (!Number.isInteger(state.version) || state.version < 1) throw new Error(`The version of ${state.streamId} must be at least 1`);
  if ((state.kind === "bot") !== (state.marketId !== null)) throw new Error(`${state.streamId}: only a bot account has a market`);
  for (const [marketId, holding] of Object.entries(state.positions)) {
    if (!isMicroQuantity(holding.yesMicro) || !isMicroQuantity(holding.noMicro)) throw new Error(`The position of ${state.streamId} in ${marketId} would be negative`);
  }
}

/** One account with only the wanted markets' positions (all of them without a list). */
function accountView(account: AccountState, marketIds?: readonly string[]): AccountState {
  const copy = structuredClone(account);
  if (marketIds === undefined) return copy;
  const positions: Record<string, Holding> = {};
  for (const marketId of marketIds) {
    const holding = copy.positions[marketId];
    if (holding) positions[marketId] = holding;
  }
  return { ...copy, positions };
}

function accountRepository(tenantId: string, { state, run }: Access): AccountRepository {
  const own = (): AccountState[] => tenantData(state(), tenantId).accounts;
  return {
    load: (streamId, options = {}) =>
      run(() => {
        const account = own().find((row) => row.streamId === streamId);
        return account ? accountView(account, options.marketIds) : null;
      }),
    save: (account) =>
      run(() => {
        checkAccount(account);
        const rows = own();
        let row = rows.find((candidate) => candidate.streamId === account.streamId);
        if (!row) {
          row = { streamId: account.streamId, kind: account.kind, ownerId: account.ownerId, marketId: account.marketId, balanceMicro: 0, positions: {}, version: 0 };
          rows.push(row);
        }
        row.ownerId = account.ownerId;
        row.balanceMicro = account.balanceMicro;
        row.version = account.version;
        // The absolute values of exactly the positions in the state; a position with no shares is deleted.
        const positions: Record<string, Holding> = { ...row.positions };
        for (const [marketId, holding] of Object.entries(account.positions)) {
          if (holding.yesMicro === 0 && holding.noMicro === 0) delete positions[marketId];
          else positions[marketId] = { yesMicro: holding.yesMicro, noMicro: holding.noMicro };
        }
        row.positions = positions;
      }),
    // Kind "user" only, never the bot account; a holder of a non-empty position or a named stream; by stream id.
    holdersOf: (marketId, options = {}) =>
      run(() => {
        const named = new Set(options.alsoStreamIds ?? []);
        return own()
          .filter((row) => row.kind === "user" && (row.positions[marketId] !== undefined || named.has(row.streamId)))
          .sort((a, b) => compare(a.streamId, b.streamId))
          .map((row) => accountView(row, [marketId]));
      }),
    botAccountsOwnedBy: (ownerId) =>
      run(() =>
        own()
          .filter((row) => row.kind === "bot" && row.ownerId === ownerId)
          .sort((a, b) => compare(a.streamId, b.streamId))
          .map((row) => accountView(row)),
      ),
    all: () =>
      run(() =>
        [...own()].sort((a, b) => compare(a.streamId, b.streamId)).map((row) => accountView(row)),
      ),
    clear: () =>
      run(() => {
        own().splice(0);
      }),
  };
}

function checkMarket(market: MarketState): void {
  // The CHECKs of the market_state table.
  if (!MARKET_STATUSES.includes(market.status)) throw new Error(`Unknown market status ${JSON.stringify(market.status)}`);
  if ((market.outcome !== null) !== (market.status === "resolved")) throw new Error("A market has an outcome exactly when it is resolved");
  if (market.outcome !== null && !isOutcome(market.outcome)) throw new Error("The outcome must be YES, NO or INVALID");
  if (market.settledAt !== null && market.status !== "resolved") throw new Error("Only a resolved market can be settled");
  if (!Number.isInteger(market.tradeSequence) || market.tradeSequence < 0) throw new Error("The trade sequence cannot be negative");
  if (market.fundingMicro !== null && !(isMicroQuantity(market.fundingMicro) && market.fundingMicro > 0)) throw new Error("The funding must be positive");
  if (market.startingPriceMicro !== null && !isPriceMicro(market.startingPriceMicro)) throw new Error("The starting price is not on the grid");
  if (market.question !== null && (market.question.length < 1 || market.question.length > 200)) throw new Error("The question must have 1 to 200 characters");
}

function marketStateRepository(tenantId: string, { state, run }: Access): MarketStateRepository {
  const own = (): MarketState[] => tenantData(state(), tenantId).marketStates;
  return {
    // Transactions run one by one, so a lock needs no extra work.
    find: (marketId) => run(() => structuredClone(own().find((row) => row.marketId === marketId) ?? null)),
    insert: (market) =>
      run(() => {
        checkMarket(market);
        if (own().some((row) => row.marketId === market.marketId)) return false;
        own().push(structuredClone(market));
        return true;
      }),
    update: (market) =>
      run(() => {
        checkMarket(market);
        const rows = own();
        const index = rows.findIndex((row) => row.marketId === market.marketId);
        if (index === -1) throw new Error(`The market ${market.marketId} has no row to update`);
        rows[index] = structuredClone(market);
      }),
    listByStatus: (status, page) =>
      run(() =>
        own()
          .filter((row) => row.status === status && (page.afterId === null || row.marketId > page.afterId))
          .sort((a, b) => compare(a.marketId, b.marketId))
          .slice(0, page.limit)
          .map((row) => structuredClone(row)),
      ),
    findMany: (marketIds) =>
      run(() =>
        own()
          .filter((row) => marketIds.includes(row.marketId))
          .sort((a, b) => compare(a.marketId, b.marketId))
          .map((row) => structuredClone(row)),
      ),
  };
}

function botOrderRepository(tenantId: string, { state, run }: Access): BotOrderRepository {
  const own = (): BotOrderBook[] => tenantData(state(), tenantId).botOrders;
  return {
    get: (marketId) =>
      run(() => {
        const book = own().find((row) => row.marketId === marketId);
        return book ? structuredClone(book) : { marketId, offers: [], pricedOnSequence: null, placedAt: null };
      }),
    replace: (marketId, offers, pricedOnSequence, now) =>
      run(() => {
        // Foreign key to market_state, and the CHECKs and the primary key (market_id, side, price_micro).
        if (!tenantData(state(), tenantId).marketStates.some((row) => row.marketId === marketId)) throw new Error(`The market ${marketId} has no market_state row`);
        const seen = new Set<string>();
        for (const offer of offers) {
          if (!isSide(offer.side) || !isPriceMicro(offer.priceMicro) || !isMicroQuantity(offer.sharesMicro) || offer.sharesMicro < 1) throw new Error("An offer breaks a CHECK of bot_orders");
          const key = `${offer.side}:${offer.priceMicro}`;
          if (seen.has(key)) throw new Error(`Two offers share the key ${key}`);
          seen.add(key);
        }
        const rows = own();
        const kept = rows.filter((row) => row.marketId !== marketId);
        // The table holds one row per offer: no offers, no rows, so the book reads as never placed.
        if (offers.length > 0) kept.push({ marketId, offers: sortOffers(structuredClone([...offers])), pricedOnSequence, placedAt: new Date(now) });
        rows.splice(0, rows.length, ...kept);
      }),
    clear: (marketId) =>
      run(() => {
        const rows = own();
        const kept = rows.filter((row) => row.marketId !== marketId);
        rows.splice(0, rows.length, ...kept);
      }),
  };
}

function idempotencyRepository(tenantId: string, { state, run }: Access): IdempotencyRepository {
  const own = (): IdempotencyRow[] => tenantData(state(), tenantId).idempotency;
  return {
    claim: ({ scope, key, requestHash, now }) =>
      run(() => {
        const rows = own();
        const row = rows.find((candidate) => candidate.scope === scope && candidate.key === key);
        if (!row) {
          rows.push({ scope, key, requestHash, result: undefined, createdAt: new Date(now) });
          return { kind: "claimed" } as const;
        }
        // A row without a result belongs to the transaction that is running (a rolled back claim leaves no row).
        if (row.result === undefined) throw new Error(`The key ${scope}/${key} is claimed by this transaction already`);
        if (row.requestHash !== requestHash) return { kind: "mismatch" } as const;
        return { kind: "replay", result: structuredClone(row.result), createdAt: new Date(row.createdAt) } as const;
      }),
    // The result is stored as JSON, as the jsonb column does: dates come back as text and the use case revives them.
    complete: (scope, key, result) =>
      run(() => {
        const row = own().find((candidate) => candidate.scope === scope && candidate.key === key);
        if (!row) throw new Error(`The key ${scope}/${key} was not claimed`);
        row.result = JSON.parse(JSON.stringify(result)) as unknown;
      }),
    purge: (scopePrefix, olderThan) =>
      run(() => {
        const rows = own();
        const kept = rows.filter((row) => !(row.scope.startsWith(scopePrefix) && row.createdAt.getTime() < olderThan.getTime()));
        const purged = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return purged;
      }),
  };
}

function tenantRepositories(tenantId: string, access: Access): TenantRepositories {
  return {
    ...sharedRepositories(access),
    ledger: ledgerRepository(tenantId, access),
    accounts: accountRepository(tenantId, access),
    marketStates: marketStateRepository(tenantId, access),
    botOrders: botOrderRepository(tenantId, access),
    idempotency: idempotencyRepository(tenantId, access),
  };
}

/**
 * In-memory store for unit tests and for local runs without a database. A transaction works on a copy of the data and
 * replaces it on success, so a failed transaction leaves nothing behind (an uncommitted idempotency claim vanishes
 * too); transactions run one by one, and a call outside a transaction waits for the one in progress. Do not call a
 * repository method of the store itself from inside a transaction callback: use the callback's own repositories, or
 * the call waits for the transaction that waits for it.
 *
 * It enforces what the schema's constraints enforce (UNIQUE ledger versions and business keys through LedgerConflict,
 * the CHECKs on balances, holdings, markets and offers, the foreign keys of the directories), so a use case that
 * breaks one fails here first. One tenant's data is invisible to another's store.
 *
 * With `autoProvision` (local runs only, APP_ENV=local) a tenant is registered on its first use, so that local
 * development needs no TenantCreated event; the default is off, and an unknown tenant answers null (HTTP 503).
 */
export class MemoryStore implements Store {
  private state: MemorySnapshot = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly autoProvision: boolean;
  private readonly logger: Logger | undefined;

  constructor(options: { autoProvision?: boolean; logger?: Logger } = {}) {
    this.autoProvision = options.autoProvision ?? false;
    this.logger = options.logger;
  }

  private readonly live: Access = {
    state: () => this.state,
    run: (operation) => this.exclusive(operation),
  };

  readonly repositories: SharedRepositories = sharedRepositories(this.live);

  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction((access) => work(sharedRepositories(access)));
  }

  async forTenant(tenantId: string): Promise<TenantStore | null> {
    const registered = await this.exclusive(() => {
      if (this.state.tenants.includes(tenantId)) return true;
      if (!this.autoProvision) return false;
      this.provisionNow(tenantId);
      return "provisioned" as const;
    });
    if (registered === false) return null;
    if (registered === "provisioned") this.logger?.info({ tenantId }, "APP_ENV=local: tenant provisioned on first use");
    return this.tenantStore(tenantId);
  }

  /** `_now` is the Store port's argument (the registry row's time); the memory registry keeps no timestamps. */
  async ensureTenant(tenantId: string, _now?: Date): Promise<TenantStore> {
    await this.exclusive(() => this.provisionNow(tenantId));
    return this.tenantStore(tenantId);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** A deep copy of everything stored, for assertions in tests. */
  snapshot(): MemorySnapshot {
    return structuredClone(this.state);
  }

  private provisionNow(tenantId: string): void {
    if (!this.state.tenants.includes(tenantId)) this.state.tenants.push(tenantId);
    this.state.tenantData[tenantId] ??= emptyTenantData();
  }

  private tenantStore(tenantId: string): TenantStore {
    return {
      tenantId,
      repositories: tenantRepositories(tenantId, this.live),
      transaction: (work) => this.inTransaction((access) => work(tenantRepositories(tenantId, access))),
    };
  }

  private inTransaction<T>(work: (access: Access) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      // Inside a transaction an operation runs at once (the queue is already ours); a throw becomes a rejection.
      const result = await work({ state: () => draft, run: <R>(operation: () => R) => new Promise<R>((resolve) => resolve(operation())) });
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private exclusive<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
