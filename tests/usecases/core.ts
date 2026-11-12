import { expect } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import type { MarketEventNotice, PaymentEventNotice } from "../../src/domain/consumed.js";
import type { Offer } from "../../src/domain/order-book.js";
import type { Outcome, Side } from "../../src/domain/units.js";
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
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import { RecordMarketEvent } from "../../src/usecases/record-market-event.js";
import { RecordPaymentEvent } from "../../src/usecases/record-payment-event.js";
import { ReplaceBotOrders } from "../../src/usecases/replace-bot-orders.js";
import { ReplayLedger } from "../../src/usecases/replay-ledger.js";
import type { Actor, Store, TenantRepositories } from "../../src/usecases/ports.js";
import { CREATOR, MARKET_1, MARKET_2, RecordingLogger, SequentialIds, TENANT_A, TENANT_B, TRADER, TestClock, TestRules, actor, closeTimeIn, serviceCaller } from "../support/fakes.js";

// Wiring of the use cases over the in-memory store, and the scenario helpers of the use-case tests.

export { CREATOR, MARKET_1, MARKET_2, TENANT_A, TENANT_B, TRADER };

export async function createCore(options: { provision?: boolean } = {}) {
  const store = new MemoryStore();
  const clock = new TestClock();
  const ids = new SequentialIds();
  const logger = new RecordingLogger();
  const rules = new TestRules();
  if (options.provision !== false) {
    await store.repositories.tenants.provision(TENANT_A, clock.now());
    await store.repositories.tenants.provision(TENANT_B, clock.now());
  }
  const deps = { store, clock, ids, logger };
  const useCases = {
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
    provisionTenant: new ProvisionTenant({ store, clock, logger }),
    recordMarketEvent: new RecordMarketEvent(deps),
    recordPaymentEvent: new RecordPaymentEvent(deps),
    grantCredits: new GrantCredits(deps),
    replayLedger: new ReplayLedger({ store, clock, logger }),
  };
  return { store, clock, ids, logger, rules, deps, useCases };
}

export type Core = Awaited<ReturnType<typeof createCore>>;

export const trader = (userId = TRADER, tenantId = TENANT_A): Actor => actor(userId, "trader", tenantId);
export const tenantAdmin = (userId = CREATOR, tenantId = TENANT_A): Actor => actor(userId, "tenant-admin", tenantId);

export const CREDIT = 1_000_000;

/** A book that is backed by a market funded with 1000 credits and not crossed (0.40 + 0.60 = 1). */
export const DEFAULT_OFFERS: Offer[] = [
  { side: "YES", priceMicro: 400_000, sharesMicro: 100_000_000 },
  { side: "YES", priceMicro: 450_000, sharesMicro: 200_000_000 },
  { side: "NO", priceMicro: 600_000, sharesMicro: 100_000_000 },
  { side: "NO", priceMicro: 650_000, sharesMicro: 200_000_000 },
];

export async function grant(core: Core, userId: string, credits: number, tenantId = TENANT_A): Promise<void> {
  expect(await core.useCases.grantCredits.execute({ tenantId, userId, amount: credits, grantId: `grant-${core.ids.newId()}`, reason: "test" })).toBe("granted");
}

export function marketOpened(core: Core, overrides: { marketId?: string; version?: number; tenantId?: string; closeTime?: Date; creatorId?: string; question?: string } = {}): MarketEventNotice {
  const marketId = overrides.marketId ?? MARKET_1;
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.markets.MarketOpened.v1",
    tenantId: overrides.tenantId ?? TENANT_A,
    correlationId: "corr-markets",
    kind: "market_opened",
    facts: {
      marketId,
      version: overrides.version ?? 1,
      question: overrides.question ?? "Will the bridge open before 2027?",
      closeTime: overrides.closeTime ?? closeTimeIn(core.clock, 24),
      startingPriceMicro: 400_000,
      creatorId: overrides.creatorId ?? CREATOR,
      openedAt: core.clock.now(),
    },
    fundingAmount: 1000,
  };
}

export function marketClosed(core: Core, overrides: { marketId?: string; version?: number; tenantId?: string } = {}): MarketEventNotice {
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.markets.MarketClosed.v1",
    tenantId: overrides.tenantId ?? TENANT_A,
    correlationId: "corr-markets",
    kind: "market_closed",
    facts: { marketId: overrides.marketId ?? MARKET_1, version: overrides.version ?? 2, closedAt: core.clock.now() },
    closedBy: CREATOR,
  };
}

export function marketResolved(core: Core, outcome: Outcome, overrides: { marketId?: string; version?: number; tenantId?: string; creatorId?: string } = {}): MarketEventNotice {
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.markets.MarketResolved.v1",
    tenantId: overrides.tenantId ?? TENANT_A,
    correlationId: "corr-markets",
    kind: "market_resolved",
    facts: { marketId: overrides.marketId ?? MARKET_1, version: overrides.version ?? 3, outcome, resolvedAt: core.clock.now(), creatorId: overrides.creatorId ?? CREATOR },
    resolvedBy: CREATOR,
  };
}

export function depositSucceeded(core: Core, userId: string, amount: number, overrides: { depositId?: string; tenantId?: string } = {}): PaymentEventNotice {
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.payments.DepositSucceeded.v1",
    tenantId: overrides.tenantId ?? TENANT_A,
    correlationId: "corr-payments",
    kind: "deposit_succeeded",
    depositId: overrides.depositId ?? core.ids.newId(),
    userId,
    amount,
  };
}

export function withdrawalFailed(core: Core, withdrawalId: string, userId: string, amount: number, overrides: { tenantId?: string } = {}): PaymentEventNotice {
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.payments.WithdrawalFailed.v1",
    tenantId: overrides.tenantId ?? TENANT_A,
    correlationId: "corr-payments",
    kind: "withdrawal_failed",
    withdrawalId,
    userId,
    amount,
    reason: "payout_failed",
  };
}

export function fundInput(marketId = MARKET_1, amount = 1000, overrides: { tenantId?: string; creatorId?: string; idempotencyKey?: string | undefined } = {}) {
  return {
    caller: serviceCaller("markets"),
    idempotencyKey: "idempotencyKey" in overrides ? overrides.idempotencyKey : marketId,
    marketId,
    tenantId: overrides.tenantId ?? TENANT_A,
    creatorId: overrides.creatorId ?? CREATOR,
    amount,
  };
}

/** Sends the bot's replacement book, based on the market's current trade sequence as the market maker does. */
export async function putOffers(core: Core, marketId: string, offers: readonly Offer[]) {
  const book = await core.useCases.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId });
  return core.useCases.replaceBotOrders.execute({ caller: serviceCaller("market-maker"), marketId, basedOnSequence: book.tradeSequence, offers });
}

/** A market funded by the creator (granted `credits` first), opened, and quoted with `offers`. */
export async function openMarket(core: Core, options: { marketId?: string; credits?: number; offers?: readonly Offer[]; tenantId?: string; creatorId?: string; closeTime?: Date } = {}): Promise<string> {
  const marketId = options.marketId ?? MARKET_1;
  const tenantId = options.tenantId ?? TENANT_A;
  const creatorId = options.creatorId ?? CREATOR;
  const credits = options.credits ?? 1000;
  await grant(core, creatorId, credits, tenantId);
  await core.useCases.fundMarket.execute(fundInput(marketId, credits, { tenantId, creatorId }));
  await core.useCases.recordMarketEvent.execute(marketOpened(core, { marketId, tenantId, creatorId, ...(options.closeTime ? { closeTime: options.closeTime } : {}) }));
  await putOffers(core, marketId, options.offers ?? DEFAULT_OFFERS);
  return marketId;
}

export function order(core: Core, userId: string, input: { marketId?: string; side?: Side; amount: number; key?: string; maxAveragePriceMicro?: number }, tenantId = TENANT_A) {
  return core.useCases.placeOrder.execute({
    actor: trader(userId, tenantId),
    idempotencyKey: input.key ?? `key-${core.ids.newId()}`,
    marketId: input.marketId ?? MARKET_1,
    side: input.side ?? "YES",
    amount: input.amount,
    ...(input.maxAveragePriceMicro === undefined ? {} : { maxAveragePriceMicro: input.maxAveragePriceMicro }),
  });
}

export function sell(core: Core, userId: string, input: { marketId?: string; side?: Side; sharesMicro: number; key?: string; minProceedsMicro?: number }, tenantId = TENANT_A) {
  return core.useCases.sellShares.execute({
    actor: trader(userId, tenantId),
    idempotencyKey: input.key ?? `key-${core.ids.newId()}`,
    marketId: input.marketId ?? MARKET_1,
    side: input.side ?? "YES",
    sharesMicro: input.sharesMicro,
    ...(input.minProceedsMicro === undefined ? {} : { minProceedsMicro: input.minProceedsMicro }),
  });
}

/** What a tenant's accounts hold, read from the store's snapshot. */
export function accountsOf(core: Core, tenantId = TENANT_A) {
  return core.store.snapshot().tenantData[tenantId]?.accounts ?? [];
}

export function balanceOf(core: Core, userId: string, tenantId = TENANT_A): number {
  return accountsOf(core, tenantId).find((account) => account.streamId === `account:${userId}`)?.balanceMicro ?? 0;
}

/**
 * The value in a tenant's system, in microcredits: every balance (users and bots) plus the pairs in existence. A pair
 * (one YES and one NO microshare) is worth exactly one microcredit, so the number of YES shares is the value of the
 * shares; it must equal the number of NO shares in every market. Trades, pairs created and settlement leave it
 * unchanged; only grants, deposits and debits move it, by exactly their amount.
 */
export function systemValue(core: Core, tenantId = TENANT_A): number {
  let balances = 0;
  const yes = new Map<string, number>();
  const no = new Map<string, number>();
  for (const account of accountsOf(core, tenantId)) {
    balances += account.balanceMicro;
    for (const [marketId, holding] of Object.entries(account.positions)) {
      yes.set(marketId, (yes.get(marketId) ?? 0) + holding.yesMicro);
      no.set(marketId, (no.get(marketId) ?? 0) + holding.noMicro);
    }
  }
  expect(Object.fromEntries(yes)).toEqual(Object.fromEntries(no));
  return balances + [...yes.values()].reduce((sum, value) => sum + value, 0);
}

/** The replay of the ledger finds the stored projections equal (the proof of DM-07). */
export async function expectReplayEqual(core: Core, tenantId = TENANT_A): Promise<void> {
  const report = await core.useCases.replayLedger.execute({ tenantId, rebuild: false });
  expect(report.differences).toEqual([]);
}

/** A store whose tenant repositories can be wrapped, to simulate a concurrent writer between a read and a write. */
export function wrapRepositories(store: Store, wrap: (repositories: TenantRepositories) => TenantRepositories): Store {
  return {
    repositories: store.repositories,
    transaction: (work) => store.transaction(work),
    ping: () => store.ping(),
    ensureTenant: async (tenantId, now) => {
      const tenant = await store.ensureTenant(tenantId, now);
      return { tenantId: tenant.tenantId, repositories: tenant.repositories, transaction: (work) => tenant.transaction((repositories) => work(wrap(repositories))) };
    },
    forTenant: async (tenantId) => {
      const tenant = await store.forTenant(tenantId);
      if (!tenant) return null;
      return { tenantId: tenant.tenantId, repositories: tenant.repositories, transaction: (work) => tenant.transaction((repositories) => work(wrap(repositories))) };
    },
  };
}
