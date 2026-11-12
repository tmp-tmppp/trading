import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { randomIds, systemClock } from "../../src/adapters/system.js";
import type { MarketEventNotice, PaymentEventNotice } from "../../src/domain/consumed.js";
import type { AccountState } from "../../src/domain/ledger.js";
import { botStreamId } from "../../src/domain/ledger.js";
import type { Offer } from "../../src/domain/order-book.js";
import { creditsToMicro } from "../../src/domain/units.js";
import type { Outcome, Side } from "../../src/domain/units.js";
import { UseCaseError } from "../../src/usecases/errors.js";
import { DebitWithdrawal } from "../../src/usecases/debit-withdrawal.js";
import { FundMarket } from "../../src/usecases/fund-market.js";
import { GetBotBook } from "../../src/usecases/get-bot-book.js";
import { GetPortfolio } from "../../src/usecases/get-portfolio.js";
import { GetQuote } from "../../src/usecases/get-quote.js";
import { GrantCredits } from "../../src/usecases/grant-credits.js";
import { ListOpenMarkets } from "../../src/usecases/list-open-markets.js";
import { PlaceOrder } from "../../src/usecases/place-order.js";
import { GetSaleQuote } from "../../src/usecases/get-sale-quote.js";
import { SellShares } from "../../src/usecases/sell-shares.js";
import type { TenantStore } from "../../src/usecases/ports.js";
import { RecordMarketEvent } from "../../src/usecases/record-market-event.js";
import { RecordPaymentEvent } from "../../src/usecases/record-payment-event.js";
import { ReplaceBotOrders } from "../../src/usecases/replace-bot-orders.js";
import { ReplayLedger } from "../../src/usecases/replay-ledger.js";
import { RecordingLogger, TestRules, actor, serviceCaller } from "../support/fakes.js";

// The real use cases on a real PostgresStore, at the same time (docker required: "npm run test:integration"). The memory
// store runs one transaction at a time and cannot show a race; this file does. Each test uses a tenant (schema) of its
// own and proves, besides its own claim, the same things: no database deadlock (pg_stat_database), no negative balance,
// conservation of credits (every balance plus the pairs in existence equals what was granted and deposited), and a replay
// of the ledger that finds the stored projections equal.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
const logger = new RecordingLogger();
const rules = new TestRules();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tenantId = (n: number): string => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`;
const marketId = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ascending = (a: number, b: number): number => a - b;

function wire(): {
  getQuote: GetQuote;
  placeOrder: PlaceOrder;
  getSaleQuote: GetSaleQuote;
  sellShares: SellShares;
  getPortfolio: GetPortfolio;
  fundMarket: FundMarket;
  debitWithdrawal: DebitWithdrawal;
  listOpenMarkets: ListOpenMarkets;
  getBotBook: GetBotBook;
  replaceBotOrders: ReplaceBotOrders;
  recordMarketEvent: RecordMarketEvent;
  recordPaymentEvent: RecordPaymentEvent;
  grantCredits: GrantCredits;
  replayLedger: ReplayLedger;
} {
  const deps = { store, clock: systemClock, ids: randomIds, logger };
  return {
    getQuote: new GetQuote(deps),
    placeOrder: new PlaceOrder({ ...deps, rules }),
    getSaleQuote: new GetSaleQuote(deps),
    sellShares: new SellShares({ ...deps, rules }),
    getPortfolio: new GetPortfolio(deps),
    fundMarket: new FundMarket(deps),
    debitWithdrawal: new DebitWithdrawal(deps),
    listOpenMarkets: new ListOpenMarkets(store),
    getBotBook: new GetBotBook({ ...deps, rules }),
    replaceBotOrders: new ReplaceBotOrders({ ...deps, rules }),
    recordMarketEvent: new RecordMarketEvent(deps),
    recordPaymentEvent: new RecordPaymentEvent(deps),
    grantCredits: new GrantCredits(deps),
    replayLedger: new ReplayLedger({ store, clock: systemClock, logger }),
  };
}

let uc: ReturnType<typeof wire>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("trading").start();
  // Enough connections for every call of a test to hold one at once (the pool waits at most 3 s for a free one).
  pool = createPool(container.getConnectionUri(), 40, logger);
  await runMigrations(pool, logger);
  store = new PostgresStore(pool, logger);
  uc = wire();
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// ---- Scenario helpers ----------------------------------------------------------------------------------------------------

const envelope = (tenant: string, eventType: string) => ({ eventId: randomIds.newId(), eventType, tenantId: tenant, correlationId: "corr-concurrency" });

function opened(tenant: string, market: string, creatorId: string): MarketEventNotice {
  const now = systemClock.now();
  return {
    ...envelope(tenant, "si.chance.markets.MarketOpened.v1"),
    kind: "market_opened",
    facts: { marketId: market, version: 1, question: "Will the bridge open before 2027?", closeTime: new Date(now.getTime() + 86_400_000), startingPriceMicro: 400_000, creatorId, openedAt: now },
    fundingAmount: 1000,
  };
}

function closed(tenant: string, market: string, creatorId: string): MarketEventNotice {
  return { ...envelope(tenant, "si.chance.markets.MarketClosed.v1"), kind: "market_closed", facts: { marketId: market, version: 2, closedAt: systemClock.now() }, closedBy: creatorId };
}

function resolved(tenant: string, market: string, creatorId: string, outcome: Outcome): MarketEventNotice {
  return {
    ...envelope(tenant, "si.chance.markets.MarketResolved.v1"),
    kind: "market_resolved",
    facts: { marketId: market, version: 3, outcome, resolvedAt: systemClock.now(), creatorId },
    resolvedBy: creatorId,
  };
}

function deposited(tenant: string, userId: string, amount: number, depositId = randomIds.newId()): PaymentEventNotice {
  return { ...envelope(tenant, "si.chance.payments.DepositSucceeded.v1"), kind: "deposit_succeeded", depositId, userId, amount };
}

function withdrawalFailed(tenant: string, withdrawalId: string, userId: string, amount: number): PaymentEventNotice {
  return { ...envelope(tenant, "si.chance.payments.WithdrawalFailed.v1"), kind: "withdrawal_failed", withdrawalId, userId, amount, reason: "payout_failed" };
}

const fundInput = (tenant: string, market: string, creatorId: string, amount: number) => ({
  caller: serviceCaller("markets"),
  idempotencyKey: market,
  marketId: market,
  tenantId: tenant,
  creatorId,
  amount,
});

async function grant(tenant: string, userId: string, credits: number): Promise<void> {
  expect(await uc.grantCredits.execute({ tenantId: tenant, userId, amount: credits, grantId: `grant-${randomIds.newId()}`, reason: "test" })).toBe("granted");
}

async function newTenant(n: number): Promise<string> {
  const id = tenantId(n);
  await store.ensureTenant(id, systemClock.now());
  return id;
}

async function putOffers(market: string, offers: readonly Offer[]): Promise<void> {
  const book = await uc.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId: market });
  await uc.replaceBotOrders.execute({ caller: serviceCaller("market-maker"), marketId: market, basedOnSequence: book.tradeSequence, offers });
}

/** The creator is granted `credits`, funds the market with all of them, the market opens and the bot quotes `offers`. */
async function openMarket(tenant: string, market: string, creatorId: string, credits: number, offers: readonly Offer[], extraForCreator = 0): Promise<void> {
  await grant(tenant, creatorId, credits + extraForCreator);
  await uc.fundMarket.execute(fundInput(tenant, market, creatorId, credits));
  await uc.recordMarketEvent.execute(opened(tenant, market, creatorId));
  await putOffers(market, offers);
}

async function tenantOf(tenant: string): Promise<TenantStore> {
  const found = await store.forTenant(tenant);
  if (!found) throw new Error(`tenant ${tenant} is not registered`);
  return found;
}

const accountsOf = async (tenant: string): Promise<AccountState[]> => (await tenantOf(tenant)).repositories.accounts.all();

/**
 * Microcredits in a tenant: every balance plus the pairs in existence. One YES and one NO microshare together are worth
 * one microcredit, so the YES shares are the value of the shares, and they must equal the NO shares in every market.
 * Trades, pairs created and settlement leave the value unchanged; only grants and deposits add to it.
 */
function systemValue(accounts: readonly AccountState[]): number {
  let balances = 0;
  const yes = new Map<string, number>();
  const no = new Map<string, number>();
  for (const account of accounts) {
    balances += account.balanceMicro;
    for (const [market, holding] of Object.entries(account.positions)) {
      yes.set(market, (yes.get(market) ?? 0) + holding.yesMicro);
      no.set(market, (no.get(market) ?? 0) + holding.noMicro);
    }
  }
  expect(Object.fromEntries(yes)).toEqual(Object.fromEntries(no));
  return balances + [...yes.values()].reduce((sum, value) => sum + value, 0);
}

function expectNothingNegative(accounts: readonly AccountState[]): void {
  for (const account of accounts) {
    expect(account.balanceMicro, account.streamId).toBeGreaterThanOrEqual(0);
    for (const holding of Object.values(account.positions)) {
      expect(holding.yesMicro, account.streamId).toBeGreaterThanOrEqual(0);
      expect(holding.noMicro, account.streamId).toBeGreaterThanOrEqual(0);
    }
  }
}

async function replayDifferences(tenant: string): Promise<unknown[]> {
  return (await uc.replayLedger.execute({ tenantId: tenant, rebuild: false })).differences;
}

/** How often the database has ended a transaction to resolve a deadlock (SQLSTATE 40P01). Statistics reach the view within about a second. */
async function deadlocks(): Promise<number> {
  await sleep(1500);
  const row = (await pool.query<{ deadlocks: string }>("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()")).rows[0];
  return Number(row?.deadlocks ?? 0);
}

/** The codes of the calls that failed: a use-case error by its code, anything else by its text. */
function rejections(settled: readonly PromiseSettledResult<unknown>[]): string[] {
  return settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason instanceof UseCaseError ? entry.reason.code : String(entry.reason)] : []));
}

function fulfilled<T>(settled: readonly PromiseSettledResult<T>[]): T[] {
  return settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
}

const outboxCount = async (type: string, aggregateId: string): Promise<number> =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shared.outbox WHERE type = $1 AND aggregate_id = $2", [`si.chance.trading.${type}.v1`, aggregateId])).rows[0]?.n ?? 0;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * Starts the calls of several groups round-robin, all in the same tick, so that calls of different groups reach the
 * database together (calling them group by group would start the second group after the first). The promises come back
 * in the shape of the groups.
 */
function startTogether<T>(groups: ReadonlyArray<ReadonlyArray<() => Promise<T>>>): Array<Array<Promise<T>>> {
  const started = groups.map(() => [] as Array<Promise<T>>);
  const longest = Math.max(...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    groups.forEach((group, which) => {
      const call = group[index];
      if (call) started[which]?.push(call());
    });
  }
  return started;
}

// ---- 1. Several orders on one market ---------------------------------------------------------------------------------------

describe("orders on one market", () => {
  it("24 traders order at once, each twice with the same key: no offer is sold twice, sequences are contiguous", async () => {
    const tenant = await newTenant(1);
    const m = marketId(1);
    // The bot is funded with 5000 credits, which backs 3000 shares per side (each credit can become a pair); the book is not crossed.
    const offers: Offer[] = [
      { side: "YES", priceMicro: 400_000, sharesMicro: 1_500_000_000 },
      { side: "YES", priceMicro: 450_000, sharesMicro: 1_500_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 1_500_000_000 },
      { side: "NO", priceMicro: 650_000, sharesMicro: 1_500_000_000 },
    ];
    await openMarket(tenant, m, "creator-1", 5000, offers);
    const traders = range(1, 24).map((n) => `trader-${String(n)}`);
    for (const trader of traders) await grant(tenant, trader, 1000);
    const deadlocksBefore = await deadlocks();

    // 60 credits per order: the YES orders (12 x 60 credits) run past the first price level into the second.
    const inputs = traders.map((trader, index) => ({
      actor: actor(trader, "trader", tenant),
      idempotencyKey: `order-${trader}-0001`,
      marketId: m,
      side: (index % 2 === 0 ? "YES" : "NO"),
      amount: 60,
    }));
    const settled = await Promise.allSettled(inputs.flatMap((input) => [uc.placeOrder.execute(input), uc.placeOrder.execute(input)]));
    expect(rejections(settled)).toEqual([]);
    const results = fulfilled(settled);

    // The two calls with one key: one executes, the other waits for it and answers the stored result.
    const executed = results.filter((placed) => !placed.replayed).map((placed) => placed.result);
    expect(executed).toHaveLength(24);
    expect(results.filter((placed) => placed.replayed)).toHaveLength(24);
    expect(new Set(results.map((placed) => placed.result.tradeId)).size).toBe(24);
    expect(executed.map((order) => order.tradeSequence).sort(ascending)).toEqual(range(1, 24));

    const store1 = await tenantOf(tenant);
    expect((await store1.repositories.marketStates.find(m))?.tradeSequence).toBe(24);
    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    // A buy spends exactly its amount.
    for (const trader of traders) expect(accounts.find((a) => a.streamId === `account:${trader}`)?.balanceMicro, trader).toBe(creditsToMicro(940));

    // Every offered share is either still offered or held by exactly one trader: nothing was sold twice.
    const book = await store1.repositories.botOrders.get(m);
    const userHolding = (side: Side): number => sum(accounts.filter((a) => a.kind === "user").map((a) => (side === "YES" ? a.positions[m]?.yesMicro : a.positions[m]?.noMicro) ?? 0));
    for (const side of ["YES", "NO"] as const) {
      const soldShares = sum(executed.filter((order) => order.side === side).map((order) => order.sharesMicro));
      const offeredNow = sum(book.offers.filter((offer) => offer.side === side).map((offer) => offer.sharesMicro));
      expect(offeredNow + soldShares, side).toBe(3_000_000_000);
      expect(userHolding(side), side).toBe(soldShares);
    }

    expect(systemValue(accounts)).toBe(creditsToMicro(5000 + 24 * 1000));
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);
  });
});

// ---- 2. Funding racing the opening of a new market -------------------------------------------------------------------------

describe("funding racing MarketOpened and MarketClosed", () => {
  it("repeated fundings and the events of 12 new markets, all at once: one funding each, one lock order, no deadlock", async () => {
    const tenant = await newTenant(2);
    const markets = range(1, 12).map((n) => ({ id: marketId(100 + n), creator: `creator-${String(n)}`, closes: n > 8 }));
    for (const { creator } of markets) await grant(tenant, creator, 1000);
    const deadlocksBefore = await deadlocks();

    const funding = markets.flatMap(({ id, creator }) => range(1, 3).map(() => () => uc.fundMarket.execute(fundInput(tenant, id, creator, 1000))));
    const events = markets.flatMap(({ id, creator, closes }) => [
      () => uc.recordMarketEvent.execute(opened(tenant, id, creator)),
      () => uc.recordMarketEvent.execute(opened(tenant, id, creator)),
      ...(closes ? [() => uc.recordMarketEvent.execute(closed(tenant, id, creator)) as Promise<unknown>] : []),
    ]);
    // The funding call and the events of a market reach the database together.
    const settled = await Promise.allSettled(startTogether([funding, events]).flat());
    // A funding that arrives after MarketClosed is refused (409 market_closed); nothing else may fail.
    expect(rejections(settled).filter((code) => code !== "market_closed")).toEqual([]);

    const store2 = await tenantOf(tenant);
    for (const { id, creator, closes } of markets) {
      const market = await store2.repositories.marketStates.find(id);
      expect(market?.status, id).toBe(closes ? "closed" : "open");
      const funded = market?.fundingMicro !== null;
      if (!closes) expect(funded, id).toBe(true);
      expect(market?.fundingMicro ?? null, id).toBe(funded ? creditsToMicro(1000) : null);
      // The funding becomes pairs in the bot's holdings (BotFunded), not balance: 1000 credits are 1000 YES and 1000 NO shares.
      const bot = await store2.repositories.accounts.load(botStreamId(id), { marketIds: [id] });
      expect(bot?.balanceMicro ?? 0, id).toBe(0);
      expect(bot?.positions[id]?.yesMicro ?? 0, id).toBe(funded ? creditsToMicro(1000) : 0);
      expect(bot?.positions[id]?.noMicro ?? 0, id).toBe(funded ? creditsToMicro(1000) : 0);
      expect((await store2.repositories.accounts.load(`account:${creator}`))?.balanceMicro, id).toBe(funded ? 0 : creditsToMicro(1000));
      // Funded once, however many calls: one MarketFunded event; the market is in the directory either way.
      expect(await outboxCount("MarketFunded", id), id).toBe(funded ? 1 : 0);
      expect(await store.repositories.marketDirectory.tenantOf(id), id).toBe(tenant);
    }
    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    expect(systemValue(accounts)).toBe(creditsToMicro(12 * 1000));
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);
  });
});

// ---- 3. Resolution racing orders -------------------------------------------------------------------------------------------

describe("MarketResolved racing orders", () => {
  it("one settlement per market; every order is filled before it or refused after it; credits are conserved", async () => {
    const tenant = await newTenant(3);
    const markets = range(1, 4).map((n) => ({ id: marketId(200 + n), creator: `creator-${String(n)}`, traders: range(1, 6).map((t) => `m${String(n)}-trader-${String(t)}`) }));
    const offers: Offer[] = [
      { side: "YES", priceMicro: 400_000, sharesMicro: 1_000_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 1_000_000_000 },
    ];
    for (const { id, creator, traders } of markets) {
      // The creator also holds a position here: 100 credits more than the funding, spent on an order of its own.
      await openMarket(tenant, id, creator, 2000, offers, 100);
      for (const trader of traders) await grant(tenant, trader, 100);
    }
    const deadlocksBefore = await deadlocks();

    const orderCalls = markets.flatMap(({ id, creator, traders }) =>
      [creator, ...traders].map(
        (user, index) => () => uc.placeOrder.execute({ actor: actor(user, "trader", tenant), idempotencyKey: `order-${user}-0001`, marketId: id, side: index % 2 === 0 ? "YES" : "NO", amount: 30 }),
      ),
    );
    // Two MarketResolved events of one market (two broker deliveries with different ids) race each other and the orders.
    const resolveCalls = markets.flatMap(({ id, creator }) => [() => uc.recordMarketEvent.execute(resolved(tenant, id, creator, "YES")), () => uc.recordMarketEvent.execute(resolved(tenant, id, creator, "YES"))]);
    const [startedOrders, startedResolves] = startTogether<unknown>([orderCalls, resolveCalls]);
    const [settledOrders, settledResolves] = await Promise.all([Promise.allSettled(startedOrders ?? []), Promise.allSettled(startedResolves ?? [])]);

    expect(rejections(settledOrders).filter((code) => code !== "market_not_open")).toEqual([]);
    expect(rejections(settledResolves)).toEqual([]);
    const outcomes = fulfilled(settledResolves);
    expect(outcomes.filter((result) => result === "settled")).toHaveLength(markets.length);

    const store3 = await tenantOf(tenant);
    for (const { id } of markets) {
      const market = await store3.repositories.marketStates.find(id);
      expect(market?.status, id).toBe("resolved");
      expect(market?.settledAt, id).not.toBeNull();
      // Settled exactly once: one BotSettled in the ledger, one MarketSettled in the outbox, and nothing is left on the book.
      expect(await store3.repositories.ledger.readStream(botStreamId(id), { types: ["BotSettled"] }), id).toHaveLength(1);
      expect(await outboxCount("MarketSettled", id), id).toBe(1);
      expect((await store3.repositories.botOrders.get(id)).offers, id).toEqual([]);
    }
    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    // Every position was paid out: no market has a holding left, and the credits are all in balances.
    expect(accounts.flatMap((account) => Object.keys(account.positions))).toEqual([]);
    expect(systemValue(accounts)).toBe(creditsToMicro(4 * (2100 + 6 * 100)));
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);
  });
});

describe("MarketResolved INVALID racing orders (UC-16)", () => {
  it("one refund settlement per market; every account ends where it started; credits conserved; replay equal", async () => {
    const tenant = await newTenant(13);
    const markets = range(1, 3).map((n) => ({ id: marketId(260 + n), creator: `invalid-creator-${String(n)}`, traders: range(1, 5).map((t) => `i${String(n)}-trader-${String(t)}`) }));
    const offers: Offer[] = [
      { side: "YES", priceMicro: 400_000, sharesMicro: 1_000_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 1_000_000_000 },
    ];
    for (const { id, creator, traders } of markets) {
      await openMarket(tenant, id, creator, 2000, offers);
      for (const trader of traders) await grant(tenant, trader, 100);
    }
    const deadlocksBefore = await deadlocks();

    const orderCalls = markets.flatMap(({ id, traders }) =>
      traders.flatMap((user, index) =>
        [1, 2].map((round) => () => uc.placeOrder.execute({ actor: actor(user, "trader", tenant), idempotencyKey: `order-${user}-${String(round)}`, marketId: id, side: index % 2 === 0 ? "YES" : "NO", amount: 20 + round })),
      ),
    );
    const resolveCalls = markets.flatMap(({ id, creator }) => [() => uc.recordMarketEvent.execute(resolved(tenant, id, creator, "INVALID")), () => uc.recordMarketEvent.execute(resolved(tenant, id, creator, "INVALID"))]);
    const [startedOrders, startedResolves] = startTogether<unknown>([orderCalls, resolveCalls]);
    const [settledOrders, settledResolves] = await Promise.all([Promise.allSettled(startedOrders ?? []), Promise.allSettled(startedResolves ?? [])]);

    expect(rejections(settledOrders).filter((code) => code !== "market_not_open")).toEqual([]);
    expect(rejections(settledResolves)).toEqual([]);
    expect(fulfilled(settledResolves).filter((result) => result === "settled")).toHaveLength(markets.length);

    const store = await tenantOf(tenant);
    for (const { id } of markets) {
      expect((await store.repositories.marketStates.find(id))?.outcome, id).toBe("INVALID");
      expect(await store.repositories.ledger.readStream(botStreamId(id), { types: ["BotVoided"] }), id).toHaveLength(1);
      expect(await outboxCount("MarketSettled", id), id).toBe(1);
    }
    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    expect(accounts.flatMap((account) => Object.keys(account.positions))).toEqual([]);
    // Whatever orders were filled before the resolution, INVALID gives every trader its payments back and every creator
    // its funding: each account holds exactly what it was granted.
    for (const { creator, traders } of markets) {
      expect(accounts.find((account) => account.ownerId === creator && account.kind === "user")?.balanceMicro, creator).toBe(creditsToMicro(2000));
      for (const trader of traders) expect(accounts.find((account) => account.ownerId === trader)?.balanceMicro, trader).toBe(creditsToMicro(100));
    }
    expect(accounts.filter((account) => account.kind === "bot").every((account) => account.balanceMicro === 0)).toBe(true);
    expect(systemValue(accounts)).toBe(creditsToMicro(3 * (2000 + 5 * 100)));
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);
  });
});

// ---- 4. A replay racing appends --------------------------------------------------------------------------------------------

describe("a replay racing appends", () => {
  it("compare and rebuild runs among orders and deposits: appends wait, no replay reports a difference, none is lost", async () => {
    const tenant = await newTenant(4);
    const m = marketId(300);
    const offers: Offer[] = [
      { side: "YES", priceMicro: 400_000, sharesMicro: 800_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 800_000_000 },
    ];
    await openMarket(tenant, m, "creator-1", 2000, offers);
    const traders = range(1, 8).map((n) => `trader-${String(n)}`);
    for (const trader of traders) await grant(tenant, trader, 500);

    const orders = traders.map(
      (trader, index) => () => uc.placeOrder.execute({ actor: actor(trader, "trader", tenant), idempotencyKey: `order-${trader}-0001`, marketId: m, side: index % 2 === 0 ? "YES" : "NO", amount: 25 }),
    );
    // Deposits for users that have no account yet create rows while the replay holds its table lock.
    const newcomers = range(1, 8).map((n) => `newcomer-${String(n)}`);
    const deposits = [...newcomers, ...traders.slice(0, 4)].map((user) => () => uc.recordPaymentEvent.execute(deposited(tenant, user, 40)));
    const replays = [false, true, false, true, false].map((rebuild) => () => uc.replayLedger.execute({ tenantId: tenant, rebuild }));
    const [startedOrders, startedDeposits, startedReplays] = startTogether<unknown>([orders, deposits, replays]);
    const settled = await Promise.allSettled([...(startedOrders ?? []), ...(startedDeposits ?? []), ...(startedReplays ?? [])]);
    expect(rejections(settled)).toEqual([]);

    // Every replay read one consistent state: the ledger and the projections agree in it, whatever was waiting.
    const reports = fulfilled(await Promise.allSettled(startedReplays ?? [])) as Array<{ differences: unknown[] }>;
    expect(reports).toHaveLength(5);
    for (const report of reports) expect(report.differences).toEqual([]);

    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    expect((await (await tenantOf(tenant)).repositories.marketStates.find(m))?.tradeSequence).toBe(8);
    expect(systemValue(accounts)).toBe(creditsToMicro(2000 + 8 * 500 + 12 * 40));
    expect(await replayDifferences(tenant)).toEqual([]);
  });
});

// ---- 5. The same money event more than once, at once ---------------------------------------------------------------------

describe("duplicate money events", () => {
  it("one deposit delivered 6 times, one debit called 6 times, one failure delivered 4 times: each counts once", async () => {
    const tenant = await newTenant(5);
    const user = "user-1";
    const depositId = randomIds.newId();
    const withdrawalId = randomIds.newId();
    const deadlocksBefore = await deadlocks();

    // A first deposit for a user without an account: the rows do not exist yet, so only the ledger's UNIQUE keys can stop a double credit.
    const deposits = await Promise.allSettled(range(1, 6).map(() => uc.recordPaymentEvent.execute(deposited(tenant, user, 500, depositId))));
    expect(rejections(deposits)).toEqual([]);
    expect(fulfilled(deposits).filter((result) => result === "credited")).toHaveLength(1);
    expect(fulfilled(deposits).filter((result) => result === "duplicate")).toHaveLength(5);
    expect((await accountsOf(tenant)).find((a) => a.streamId === `account:${user}`)?.balanceMicro).toBe(creditsToMicro(500));

    // Payments calls the same debit again after a lost answer, several times at once: every answer is "debited", the account is debited once.
    const debit = { caller: serviceCaller("payments"), idempotencyKey: withdrawalId, withdrawalId, tenantId: tenant, userId: user, amount: 200 };
    const debits = await Promise.allSettled(range(1, 6).map(() => uc.debitWithdrawal.execute(debit)));
    expect(rejections(debits)).toEqual([]);
    expect(fulfilled(debits).map((result) => result.kind)).toEqual(Array.from({ length: 6 }, () => "debited"));
    expect((await accountsOf(tenant)).find((a) => a.streamId === `account:${user}`)?.balanceMicro).toBe(creditsToMicro(300));
    expect(systemValue(await accountsOf(tenant))).toBe(creditsToMicro(300));

    // The payout failed and the event comes several times: refunded once.
    const failures = await Promise.allSettled(range(1, 4).map(() => uc.recordPaymentEvent.execute(withdrawalFailed(tenant, withdrawalId, user, 200))));
    expect(rejections(failures)).toEqual([]);
    expect(fulfilled(failures).filter((result) => result === "refunded")).toHaveLength(1);
    expect(fulfilled(failures).filter((result) => result === "duplicate")).toHaveLength(3);
    expect(await outboxCount("WithdrawalRefunded", withdrawalId)).toBe(1);

    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    expect(accounts.find((a) => a.streamId === `account:${user}`)?.balanceMicro).toBe(creditsToMicro(500));
    expect(systemValue(accounts)).toBe(creditsToMicro(500));
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);
  });
});

// ---- 6. The market maker's replacement racing orders -----------------------------------------------------------------------

describe("ReplaceBotOrders racing orders", () => {
  it("three rounds of a replacement and 8 orders on one market, all at once: a replacement is applied or answers 409 stale_sequence, each order fills from the book in force at its trade", async () => {
    const tenant = await newTenant(6);
    const m = marketId(400);
    const bookA: Offer[] = [
      { side: "YES", priceMicro: 400_000, sharesMicro: 800_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 800_000_000 },
    ];
    const bookB: Offer[] = [
      { side: "YES", priceMicro: 420_000, sharesMicro: 600_000_000 },
      { side: "NO", priceMicro: 580_000, sharesMicro: 600_000_000 },
    ];
    await openMarket(tenant, m, "creator-1", 2000, bookA);
    const traders = range(1, 8).map((n) => `trader-${String(n)}`);
    for (const trader of traders) await grant(tenant, trader, 500);
    const deadlocksBefore = await deadlocks();
    const cheapest = (offers: readonly Offer[], side: Side): number => Math.min(...offers.filter((offer) => offer.side === side).map((offer) => offer.priceMicro));

    let inForce = bookA;
    const sequences: number[] = [];
    for (const round of [1, 2, 3]) {
      const next = round % 2 === 1 ? bookB : bookA;
      const before = await uc.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId: m });
      expect(before.tradeSequence).toBe(sequences.length);

      const replace = () => uc.replaceBotOrders.execute({ caller: serviceCaller("market-maker"), marketId: m, basedOnSequence: before.tradeSequence, offers: next });
      const orders = traders.map(
        (trader, index) => () => uc.placeOrder.execute({ actor: actor(trader, "trader", tenant), idempotencyKey: `order-${trader}-round-${String(round)}`, marketId: m, side: index % 2 === 0 ? "YES" : "NO", amount: 10 }),
      );
      const [startedReplace, startedOrders] = startTogether<unknown>([[replace], orders]);
      const replaced = await Promise.allSettled(startedReplace ?? []);
      const placed = await Promise.allSettled(startedOrders ?? []);

      // The replacement is based on the sequence the bot read: it wins the market row first, or a trade came in between.
      expect(rejections(replaced).filter((code) => code !== "stale_sequence")).toEqual([]);
      expect(rejections(placed)).toEqual([]);
      const book = fulfilled(replaced)[0] as { offersPricedOnSequence: number | null } | undefined;

      // An order fills from the book that was in force at its trade: the old one up to the sequence the replacement
      // was priced on, the new one after it, and never a share that was already taken or cancelled.
      const results = (fulfilled(placed) as Array<{ result: { tradeSequence: number; side: Side; fills: Array<{ priceMicro: number }> } }>).map((entry) => entry.result);
      for (const order of results) {
        const priced = book?.offersPricedOnSequence;
        const from = priced !== undefined && priced !== null && order.tradeSequence > priced ? next : inForce;
        expect(order.fills.map((fill) => fill.priceMicro), `trade ${String(order.tradeSequence)}`).toEqual([cheapest(from, order.side)]);
      }
      sequences.push(...results.map((order) => order.tradeSequence));
      if (book) inForce = next;
    }

    // Contiguous trade sequences, nothing negative, credits conserved, the replay equal, no deadlock.
    expect([...sequences].sort(ascending)).toEqual(range(1, 24));
    expect((await (await tenantOf(tenant)).repositories.marketStates.find(m))?.tradeSequence).toBe(24);
    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    expect(systemValue(accounts)).toBe(creditsToMicro(2000 + 8 * 500));
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);
    // With no order in flight a replacement based on the current sequence is applied.
    await putOffers(m, bookA);
  });
});

// ---- 7. Sales (UC-08) racing buys and the bot's offer replacement -----------------------------------------------------------

describe("sales racing buys and the bot's offer replacement on one market (UC-08)", () => {
  it("8 sales (each sent twice with one key), 8 buys and a replacement at once: one execution per key, contiguous sequences, each fill from the book in force; then INVALID refunds net payments", async () => {
    const tenant = await newTenant(7);
    const m = marketId(500);
    const bookA: Offer[] = [
      { side: "YES", priceMicro: 400_000, sharesMicro: 800_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 800_000_000 },
    ];
    const bookB: Offer[] = [
      { side: "YES", priceMicro: 420_000, sharesMicro: 600_000_000 },
      { side: "NO", priceMicro: 580_000, sharesMicro: 600_000_000 },
    ];
    await openMarket(tenant, m, "creator-1", 2000, bookA);
    const sellers = range(1, 8).map((n) => `seller-${String(n)}`);
    const buyers = range(1, 8).map((n) => `buyer-${String(n)}`);
    for (const userId of [...sellers, ...buyers]) await grant(tenant, userId, 500);
    // Each seller first buys 50 YES for 20 credits (trade sequences 1..8).
    for (const seller of sellers) await uc.placeOrder.execute({ actor: actor(seller, "trader", tenant), idempotencyKey: `buy-${seller}-first`, marketId: m, side: "YES", amount: 20 });
    const deadlocksBefore = await deadlocks();
    const before = await uc.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId: m });
    expect(before.tradeSequence).toBe(8);

    const saleInput = (seller: string) => ({ actor: actor(seller, "trader", tenant), idempotencyKey: `sale-${seller}-0001`, marketId: m, side: "YES", sharesMicro: 30_000_000 });
    const sales = sellers.flatMap((seller) => [() => uc.sellShares.execute(saleInput(seller)), () => uc.sellShares.execute(saleInput(seller))]);
    const buys = buyers.map(
      (buyer, index) => () => uc.placeOrder.execute({ actor: actor(buyer, "trader", tenant), idempotencyKey: `buy-${buyer}-0001`, marketId: m, side: index % 2 === 0 ? "YES" : "NO", amount: 10 }),
    );
    const replace = () => uc.replaceBotOrders.execute({ caller: serviceCaller("market-maker"), marketId: m, basedOnSequence: before.tradeSequence, offers: bookB });
    const [startedReplace, startedSales, startedBuys] = startTogether<unknown>([[replace], sales, buys]);
    const replaced = await Promise.allSettled(startedReplace ?? []);
    const sold = await Promise.allSettled(startedSales ?? []);
    const bought = await Promise.allSettled(startedBuys ?? []);

    expect(rejections(replaced).filter((code) => code !== "stale_sequence")).toEqual([]);
    expect(rejections(sold)).toEqual([]);
    expect(rejections(bought)).toEqual([]);
    type Trade = { tradeId: string; tradeSequence: number; fills: Array<{ priceMicro: number }>; side: Side };
    const saleResults = fulfilled(sold) as Array<{ replayed: boolean; result: Trade & { proceedsMicro: number; costMicro: number; balanceMicro: number } }>;
    const executedSales = saleResults.filter((entry) => !entry.replayed).map((entry) => entry.result);
    // The two calls with one key: one sells, the other waits for it and answers the stored result.
    expect(executedSales).toHaveLength(8);
    expect(saleResults.filter((entry) => entry.replayed)).toHaveLength(8);
    expect(new Set(saleResults.map((entry) => entry.result.tradeId)).size).toBe(8);
    const buyResults = (fulfilled(bought) as Array<{ result: Trade }>).map((entry) => entry.result);

    // Every trade fills from the book in force at its trade sequence: bookA before the replacement, bookB after it. A
    // sale of YES takes the cheapest NO offer.
    const book = fulfilled(replaced)[0] as { offersPricedOnSequence: number | null } | undefined;
    const cheapest = (offers: readonly Offer[], side: Side): number => Math.min(...offers.filter((offer) => offer.side === side).map((offer) => offer.priceMicro));
    const inForce = (sequence: number): readonly Offer[] => (book?.offersPricedOnSequence !== undefined && book.offersPricedOnSequence !== null && sequence > book.offersPricedOnSequence ? bookB : bookA);
    for (const sale of executedSales) expect(sale.fills.map((fill) => fill.priceMicro), `sale ${String(sale.tradeSequence)}`).toEqual([cheapest(inForce(sale.tradeSequence), "NO")]);
    for (const buy of buyResults) expect(buy.fills.map((fill) => fill.priceMicro), `buy ${String(buy.tradeSequence)}`).toEqual([cheapest(inForce(buy.tradeSequence), buy.side)]);
    expect([...executedSales, ...buyResults].map((trade) => trade.tradeSequence).sort(ascending)).toEqual(range(9, 24));
    expect(await outboxCount("TradeExecuted", m)).toBe(24);

    const accounts = await accountsOf(tenant);
    expectNothingNegative(accounts);
    const ledger = (await tenantOf(tenant)).repositories.ledger;
    /** The one sale of a seller, read from its own stream. */
    const saleOf = async (seller: string) => {
      const events = await ledger.readStream(`account:${seller}`, { types: ["SharesSold"] });
      expect(events, seller).toHaveLength(1);
      const event = events[0];
      if (event?.type !== "SharesSold") throw new Error(`${seller} has no sale`);
      return event.data;
    };
    for (const seller of sellers) {
      const sale = await saleOf(seller);
      const account = accounts.find((candidate) => candidate.streamId === `account:${seller}`);
      // 20 YES left of 50; the balance is the 480 left after the buy plus the proceeds of the 30 sold.
      expect(account?.positions[m], seller).toEqual({ yesMicro: 20_000_000, noMicro: 0 });
      expect(sale.proceedsMicro).toBe(30_000_000 - sale.costMicro);
      expect(account?.balanceMicro, seller).toBe(creditsToMicro(480) + sale.proceedsMicro);
      expect(executedSales.find((executed) => executed.tradeId === sale.tradeId)?.balanceMicro, seller).toBe(account?.balanceMicro);
    }
    const granted = creditsToMicro(2000 + 16 * 500);
    expect(systemValue(accounts)).toBe(granted);
    expect(await replayDifferences(tenant)).toEqual([]);
    expect(await deadlocks()).toBe(deadlocksBefore);

    // INVALID afterwards: each seller gets back its net payment (20 credits plus what the NO shares cost, minus the
    // 30 credits the pairs returned), every share of the market is voided and every credit is in a user's balance.
    await uc.recordMarketEvent.execute(resolved(tenant, m, "creator-1", "INVALID"));
    const after = await accountsOf(tenant);
    expectNothingNegative(after);
    for (const seller of sellers) {
      const sale = await saleOf(seller);
      const refunds = await ledger.readStream(`account:${seller}`, { types: ["PositionRefunded"] });
      const net = creditsToMicro(20) + sale.costMicro - 30_000_000;
      expect(refunds.map((event) => event.data), seller).toEqual([
        { marketId: m, yesMicro: 20_000_000, noMicro: 0, paidMicro: creditsToMicro(20) + sale.costMicro, returnedMicro: 30_000_000, refundMicro: net },
      ]);
      // Back to the 500 granted: the sale's proceeds and the refund of the net payment together.
      expect(after.find((account) => account.streamId === `account:${seller}`)?.balanceMicro, seller).toBe(creditsToMicro(500));
    }
    expect(sum(after.map((account) => account.balanceMicro))).toBe(granted);
    for (const account of after) expect(account.positions[m] ?? { yesMicro: 0, noMicro: 0 }).toEqual({ yesMicro: 0, noMicro: 0 });
    expect(await replayDifferences(tenant)).toEqual([]);
  });
});
