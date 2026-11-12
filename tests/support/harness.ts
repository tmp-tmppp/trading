import type { OutgoingHttpHeaders } from "node:http";
import { Writable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { expect } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { instrumentTrading } from "../../src/adapters/metrics/trading-metrics.js";
import type { MarketEventNotice, PaymentEventNotice } from "../../src/domain/consumed.js";
import type { Offer } from "../../src/domain/order-book.js";
import type { Outcome } from "../../src/domain/units.js";
import { createLogger } from "../../src/logger.js";
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
import type { ServiceClient } from "../../src/usecases/ports.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import { RecordMarketEvent } from "../../src/usecases/record-market-event.js";
import { RecordPaymentEvent } from "../../src/usecases/record-payment-event.js";
import { ReplaceBotOrders } from "../../src/usecases/replace-bot-orders.js";
import { ReplayLedger } from "../../src/usecases/replay-ledger.js";
import type { GrantCreditsUseCase, InternalUseCases, ProvisionTenantUseCase, RecordMarketEventUseCase, RecordPaymentEventUseCase, ReplayLedgerUseCase, TradingUseCases } from "../../src/usecases/use-cases.js";
import { buildInternalApp } from "../../src/web/internal-app.js";
import { buildPublicApp } from "../../src/web/public-app.js";
import type { ServiceAuthOptions } from "../../src/web/service-auth.js";
import { internalResponseErrors, publicResponseErrors } from "./contracts.js";
import { CREATOR, MARKET_1, RecordingLogger, SequentialIds, TENANT_A, TENANT_B, TRADER, TestClock, TestRules, closeTimeIn, serviceCaller } from "./fakes.js";
import { AUDIENCE, ISSUER, TENANT_ADMIN_GROUP, TRADER_GROUP, createTestKeys } from "./tokens.js";
import type { TokenOptions } from "./tokens.js";

export { CREATOR, MARKET_1, TENANT_A, TENANT_B, TRADER };

/** The client ids of the three calling services, as the configuration names them (MARKETS_CLIENT_ID, ...). */
export const CLIENT_IDS: Record<ServiceClient, string> = { markets: "markets", payments: "payments", "market-maker": "market-maker" };

export interface CoreOptions {
  /** The store registers an unknown tenant on its first use (APP_ENV=local); default false: it answers tenant_not_ready. */
  autoProvision?: boolean;
}

/** Every use case the web layer, the consumers and the tools need, over the in-memory store. */
export type AllUseCases = TradingUseCases &
  InternalUseCases & {
    provisionTenant: ProvisionTenantUseCase;
    recordMarketEvent: RecordMarketEventUseCase;
    recordPaymentEvent: RecordPaymentEventUseCase;
    grantCredits: GrantCreditsUseCase;
    replayLedger: ReplayLedgerUseCase;
  };

/**
 * The use cases over the in-memory store. Nothing is provisioned yet: `provisionTenants(core)` registers TENANT_A and
 * TENANT_B through the same use case the TenantCreated consumer runs, so that the tests start like a service that has
 * processed two TenantCreated events. A test of the 503 tenant_not_ready uses a tenant that is not among them.
 */
export function createCore(options: CoreOptions = {}) {
  const logger = new RecordingLogger();
  const store = new MemoryStore({ autoProvision: options.autoProvision ?? false, logger });
  const clock = new TestClock();
  const ids = new SequentialIds();
  const rules = new TestRules();
  const deps = { store, clock, ids, logger };
  const useCases: AllUseCases = {
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
  return { store, clock, ids, logger, rules, useCases };
}

export type Core = ReturnType<typeof createCore>;

/** Registers the tenants as a TenantCreated event does (default TENANT_A and TENANT_B), one event id each. */
export async function provisionTenants(core: Core, tenantIds: readonly string[] = [TENANT_A, TENANT_B]): Promise<void> {
  for (const tenantId of tenantIds) {
    await core.useCases.provisionTenant.execute({
      eventId: `00000000-0000-7000-8000-${tenantId.slice(-12)}`,
      eventType: "si.chance.tenants.TenantCreated.v1",
      tenantId,
      correlationId: `provision-${tenantId.slice(-2)}`,
    });
  }
}

// One RSA key pair per test file: generating it is the slowest step of a harness, and the tests only need tokens that are
// really signed and really verified, not a new key each time.
let sharedKeys: ReturnType<typeof createTestKeys> | undefined;

export interface HarnessOptions extends CoreOptions {
  /** Provision TENANT_A and TENANT_B (default true). */
  provision?: boolean;
  /** INTERNAL_AUTH_AUDIENCE; default the public audience, as the configuration does. */
  internalAudience?: string;
  /** Build the internal application with the local events route (APP_ENV=local without NATS). */
  local?: boolean;
  /** The request metrics on both applications and the order counters around the public use cases, as src/main.ts wires them. */
  metrics?: Metrics;
}

/** Both web applications over the core above, with real JWT verification against a local key. */
export async function createHarness(options: HarnessOptions = {}) {
  const core = createCore(options);
  if (options.provision !== false) await provisionTenants(core);
  const keys = await (sharedKeys ??= createTestKeys());
  const internalAudience = options.internalAudience ?? AUDIENCE;
  const logLines: string[] = [];
  // The key resolver can be made to fail like a JWKS download that does not work (see failKeys).
  let keyFailure: unknown = null;
  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (keyFailure !== null) throw keyFailure as Error;
    return await keys.getKey(header, token);
  };
  let draining = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createLogger("info", sink);
  const publicApp = buildPublicApp({
    logger,
    useCases: options.metrics ? instrumentTrading(options.metrics.registry, core.useCases) : core.useCases,
    auth: { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" },
    health: { ping: () => core.store.ping(), isDraining: () => draining },
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });
  // The settings of the service tokens: the internal REST port and the gRPC server (tests/web/grpc-debits.test.ts) share them.
  const serviceAuth: ServiceAuthOptions = { jwks: getKey, issuer: ISSUER, audience: internalAudience, clientClaim: "azp", clients: CLIENT_IDS };
  const internalApp = buildInternalApp({
    logger,
    useCases: core.useCases,
    auth: serviceAuth,
    local: options.local ? core.useCases : null,
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });
  await publicApp.ready();
  await internalApp.ready();

  const sign = (token?: TokenOptions): Promise<string> => keys.sign(token);
  /** A client-credentials token of a service: the client id in azp, the internal audience, no roles and no tenant. */
  const signService = (client: ServiceClient, extra: TokenOptions = {}): Promise<string> =>
    keys.sign({ sub: `service-account-${client}`, azp: CLIENT_IDS[client], audience: internalAudience, ...extra });
  /** From now on the key resolver rejects with this error; null makes it work again. */
  const failKeys = (error: unknown): void => {
    keyFailure = error;
  };
  /** Pretends the process got SIGTERM and is in the drain delay (or is running again). */
  const setDraining = (value: boolean): void => {
    draining = value;
  };
  const close = async (): Promise<void> => {
    await publicApp.close();
    await internalApp.close();
  };

  return { publicApp, internalApp, core, keys, logLines, logger, serviceAuth, sign, signService, failKeys, setDraining, close };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Claims of the three kinds of user in token contract v2: the tenant (the organization alias) and the role (the
 * organization's group) are in `organization`; the platform admin's role is a realm role.
 */
export const asTenantAdmin = (sub = CREATOR, tenant: string = TENANT_A): TokenOptions => ({ sub, memberships: { [tenant]: [TENANT_ADMIN_GROUP] } });
export const asTrader = (sub = TRADER, tenant: string = TENANT_A): TokenOptions => ({ sub, memberships: { [tenant]: [TRADER_GROUP] } });
export const asPlatformAdmin = (sub = "platform-1"): TokenOptions => ({ sub, roles: ["platform-admin"] });

export interface CallOptions {
  /** Claims of the bearer token; null sends no Authorization header. Default: a trader of TENANT_A. */
  token?: TokenOptions | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Record<string, any> | null;
}

function answerOf(response: { statusCode: number; headers: OutgoingHttpHeaders; body: string }): Answer {
  return { status: response.statusCode, headers: response.headers, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

/** One request through the public application, as a client would send it. */
export async function call(h: Harness, method: "GET" | "POST", url: string, options: CallOptions = {}): Promise<Answer> {
  const auth = options.token === null ? {} : { authorization: `Bearer ${await h.sign(options.token ?? asTrader())}` };
  const response = await h.publicApp.inject({
    method,
    url,
    headers: { ...auth, ...options.headers },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  return answerOf(response);
}

export interface InternalCallOptions {
  /** The calling service: its client-credentials token is sent. Default markets. Ignored when `token` is given. */
  client?: ServiceClient;
  /** Arbitrary claims instead of a service token (a user's token, a wrong audience); null sends no Authorization header. */
  token?: TokenOptions | null;
  body?: unknown;
  headers?: Record<string, string>;
}

/** One request through the internal application, as another service would send it. */
export async function callInternal(h: Harness, method: "GET" | "POST" | "PUT", url: string, options: InternalCallOptions = {}): Promise<Answer> {
  const bearer = options.token === null ? null : options.token ? await h.sign(options.token) : await h.signService(options.client ?? "markets");
  const response = await h.internalApp.inject({
    method,
    url,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...options.headers },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  return answerOf(response);
}

/** Asserts that a real answer of the public API has the shape written in contracts/openapi.yaml (`path` as written there). */
export function expectPublicContract(path: string, method: string, answer: Answer): void {
  expect(publicResponseErrors(path, method, answer.status, answer.body), `${method} ${path} -> ${answer.status}`).toEqual([]);
}

/** Asserts the same for the internal API and contracts/internal.openapi.yaml. */
export function expectInternalContract(path: string, method: string, answer: Answer): void {
  expect(internalResponseErrors(path, method, answer.status, answer.body), `${method} ${path} -> ${answer.status}`).toEqual([]);
}

// --- scenarios: how a market and its users get into a state, through the use cases the consumers and the internal API run ---

export const CREDIT = 1_000_000;

/** A book backed by a market funded with 1000 credits and not crossed (0.40 + 0.60 = 1): YES takes up to 130 credits. */
export const DEFAULT_OFFERS: Offer[] = [
  { side: "YES", priceMicro: 400_000, sharesMicro: 100_000_000 },
  { side: "YES", priceMicro: 450_000, sharesMicro: 200_000_000 },
  { side: "NO", priceMicro: 600_000, sharesMicro: 100_000_000 },
  { side: "NO", priceMicro: 650_000, sharesMicro: 200_000_000 },
];

export async function grant(core: Core, userId: string, credits: number, tenantId = TENANT_A): Promise<void> {
  expect(await core.useCases.grantCredits.execute({ tenantId, userId, amount: credits, grantId: `grant-${core.ids.newId()}`, reason: "test" })).toBe("granted");
}

export function marketOpened(core: Core, overrides: { marketId?: string; version?: number; tenantId?: string; closeTime?: Date; creatorId?: string } = {}): MarketEventNotice {
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.markets.MarketOpened.v1",
    tenantId: overrides.tenantId ?? TENANT_A,
    correlationId: "corr-markets",
    kind: "market_opened",
    facts: {
      marketId: overrides.marketId ?? MARKET_1,
      version: overrides.version ?? 1,
      question: "Will the bridge open before 2027?",
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

export function withdrawalFailed(core: Core, withdrawalId: string, userId: string, amount: number, tenantId = TENANT_A): PaymentEventNotice {
  return {
    eventId: core.ids.newId(),
    eventType: "si.chance.payments.WithdrawalFailed.v1",
    tenantId,
    correlationId: "corr-payments",
    kind: "withdrawal_failed",
    withdrawalId,
    userId,
    amount,
    reason: "payout_failed",
  };
}

/** The body markets sends to fund a market. */
export function fundingBody(marketId: string, amount: number, overrides: { tenantId?: string; creatorId?: string } = {}) {
  return { marketId, tenantId: overrides.tenantId ?? TENANT_A, creatorId: overrides.creatorId ?? CREATOR, amount };
}

/** The market maker's replacement book, based on the market's current trade sequence as the market maker does. */
export async function putOffers(core: Core, marketId: string, offers: readonly Offer[]) {
  const book = await core.useCases.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId });
  return core.useCases.replaceBotOrders.execute({ caller: serviceCaller("market-maker"), marketId, basedOnSequence: book.tradeSequence, offers });
}

/** A market funded by its creator (granted `credits` first), opened by markets' event, and quoted with `offers`. */
export async function openMarket(
  core: Core,
  options: { marketId?: string; credits?: number; offers?: readonly Offer[]; tenantId?: string; creatorId?: string; closeTime?: Date } = {},
): Promise<string> {
  const marketId = options.marketId ?? MARKET_1;
  const tenantId = options.tenantId ?? TENANT_A;
  const creatorId = options.creatorId ?? CREATOR;
  const credits = options.credits ?? 1000;
  await grant(core, creatorId, credits, tenantId);
  await core.useCases.fundMarket.execute({ caller: serviceCaller("markets"), idempotencyKey: marketId, marketId, tenantId, creatorId, amount: credits });
  await core.useCases.recordMarketEvent.execute(marketOpened(core, { marketId, tenantId, creatorId, ...(options.closeTime ? { closeTime: options.closeTime } : {}) }));
  await putOffers(core, marketId, options.offers ?? DEFAULT_OFFERS);
  return marketId;
}

/** A market whose funding was taken but whose MarketOpened has not been processed yet: its copy has the status `funded`. */
export async function fundOnly(core: Core, marketId: string, options: { credits?: number; tenantId?: string; creatorId?: string } = {}): Promise<void> {
  const tenantId = options.tenantId ?? TENANT_A;
  const creatorId = options.creatorId ?? CREATOR;
  const credits = options.credits ?? 100;
  await grant(core, creatorId, credits, tenantId);
  await core.useCases.fundMarket.execute({ caller: serviceCaller("markets"), idempotencyKey: marketId, marketId, tenantId, creatorId, amount: credits });
}

/** A fresh Idempotency-Key of a valid form. */
export const newKey = (core: Core): string => `key-${core.ids.newId()}`;

/** The headers of an order request: its Idempotency-Key. */
export const withKey = (key: string): Record<string, string> => ({ "idempotency-key": key });
