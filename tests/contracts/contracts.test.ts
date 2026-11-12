import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { natsSubject } from "../../src/domain/events.js";
import type { EventName } from "../../src/domain/events.js";
import {
  asyncapi,
  documentedStatuses,
  eventErrors,
  eventErrorsIn,
  internalOpenapi,
  marketsFundingContract,
  openapi,
  paymentsAsyncapi,
  paymentsDebitContract,
  requestErrorsIn,
  responseErrorsIn,
  schemaErrorsIn,
} from "../support/contracts.js";
import { CREATOR, MARKET_1, MARKET_2, TENANT_A, TRADER } from "../support/fakes.js";
import {
  DEFAULT_OFFERS,
  asPlatformAdmin,
  asTenantAdmin,
  asTrader,
  call,
  callInternal,
  createHarness,
  fundingBody,
  grant,
  marketResolved,
  newKey,
  openMarket,
  withKey,
  withdrawalFailed,
} from "../support/harness.js";
import type { Answer, Harness } from "../support/harness.js";

const METHODS = ["get", "post", "put", "patch", "delete"];
type Doc = Record<string, any>;
type Operations = Record<string, Record<string, { security?: unknown[]; operationId?: string; responses: Record<string, any> }>>;

const operationsOf = (doc: Doc): Operations => doc["paths"] as Operations;
const routesOf = (app: { registeredRoutes: Array<{ method: string; url: string }> }): string[] =>
  app.registeredRoutes
    .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
    .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
    .sort();
const documentedRoutes = (doc: Doc): string[] =>
  Object.entries(operationsOf(doc))
    .flatMap(([path, item]) => Object.keys(item).filter((key) => METHODS.includes(key)).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
/** "METHOD path status" for every response every operation documents. */
const documentedAnswers = (doc: Doc): string[] =>
  Object.entries(operationsOf(doc))
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => METHODS.includes(method))
        .flatMap(([method, operation]) => Object.keys(operation.responses).map((status) => `${method.toUpperCase()} ${path} ${status}`)),
    )
    .sort();

// The two OpenAPI files of trading have the same rules (problem+json, 503 with Retry-After on every operation that needs
// a token); the checks are written once and run for both.
describe.each([
  { name: "contracts/openapi.yaml (public)", doc: openapi, open: ["/health/live", "/health/ready", "/health/startup"], operations: 8, authenticated: 5 },
  { name: "contracts/internal.openapi.yaml (internal)", doc: internalOpenapi, open: [], operations: 5, authenticated: 5 },
])("$name", ({ doc, open, operations, authenticated }) => {
  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(doc["openapi"]).toMatch(/^3\.1\./);
    const scheme = Object.values(doc["components"].securitySchemes)[0];
    expect(scheme).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(doc["security"]).toHaveLength(1);

    const ids: string[] = [];
    for (const item of Object.values(operationsOf(doc))) {
      for (const [method, operation] of Object.entries(item)) if (METHODS.includes(method)) ids.push(operation.operationId ?? "");
    }
    expect(ids).toHaveLength(operations);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("leaves only the health probes without a security requirement", () => {
    const unsecured: string[] = [];
    for (const [path, item] of Object.entries(operationsOf(doc))) {
      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.includes(method) && Array.isArray(operation.security) && operation.security.length === 0) unsecured.push(path);
      }
    }
    expect(unsecured.sort()).toEqual(open);
  });

  it("documents 503 with a Retry-After header on every authenticated operation, through one shared response", () => {
    const shared = doc["components"].responses.ServiceUnavailable;
    expect(shared.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    expect(Object.keys(shared.content)).toEqual(["application/problem+json"]);

    const secured: string[] = [];
    for (const [path, item] of Object.entries(operationsOf(doc))) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method) || (Array.isArray(operation.security) && operation.security.length === 0)) continue;
        secured.push(`${method.toUpperCase()} ${path}`);
        expect(operation.responses["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
      }
    }
    expect(secured).toHaveLength(authenticated);
  });

  it("documents the problem+json answer of every error status", () => {
    for (const item of Object.values(operationsOf(doc))) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue;
          const resolved = response.$ref ? doc["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
          expect(Object.keys(resolved.content), `${method} ${status}`).toEqual(["application/problem+json"]);
        }
      }
    }
  });
});

describe("the routes the applications register", () => {
  it("are exactly the paths of contracts/openapi.yaml (public) and of contracts/internal.openapi.yaml (internal), the local route aside", async () => {
    const harness = await createHarness();
    const publicRoutes = routesOf(harness.publicApp);
    const internalRoutes = routesOf(harness.internalApp);
    await harness.close();

    expect(publicRoutes).toHaveLength(8);
    expect(publicRoutes).toEqual(documentedRoutes(openapi));
    expect(internalRoutes).toHaveLength(5);
    expect(internalRoutes).toEqual(documentedRoutes(internalOpenapi));
  });

  it("keep the gateway's prefix on the public side and /v1/internal on the internal side, with no path in both", () => {
    const publicPaths = Object.keys(operationsOf(openapi));
    const internalPaths = Object.keys(operationsOf(internalOpenapi));
    expect(publicPaths.filter((path) => !path.startsWith("/health/")).every((path) => path.startsWith("/v1/trading/"))).toBe(true);
    expect(internalPaths.every((path) => path.startsWith("/v1/internal/"))).toBe(true);
  });

  it("document Cache-Control on every success answer of the public API", () => {
    for (const [path, item] of Object.entries(operationsOf(openapi))) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method) || (Array.isArray(operation.security) && operation.security.length === 0)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith("2")) continue;
          expect(response.headers?.["Cache-Control"], `${method} ${path} ${status}`).toEqual({ $ref: "#/components/headers/CacheControl" });
        }
      }
    }
  });
});

// --- every documented answer, provoked on the real applications and validated against its schema ---

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await openMarket(h.core);
  await grant(h.core, TRADER, 500);
});
afterAll(async () => {
  await h.close();
});

type Scenario = (harness: Harness) => Promise<Answer>;
const UNKNOWN_MARKET = "018f3c1e-7a00-7000-8000-0000000000f1";
const FUNDED_MARKET = "018f3c1e-7a00-7000-8000-000000000106";
const POOR_MARKET = "018f3c1e-7a00-7000-8000-000000000107";
const WITHDRAWAL_1 = "018f3c1e-7a00-7000-8000-0000000000d1";
const WITHDRAWAL_2 = "018f3c1e-7a00-7000-8000-0000000000d2";

/** The signing keys cannot be fetched while `work` runs: every authenticated endpoint answers 503. */
async function keysDown<T>(harness: Harness, work: () => Promise<T>): Promise<T> {
  harness.failKeys(new errors.JWKSTimeout());
  try {
    return await work();
  } finally {
    harness.failKeys(null);
  }
}

const quoteUrl = (marketId: string, amount: number) => `/v1/trading/quote?marketId=${marketId}&side=YES&amount=${amount}`;
const order = (extra: Record<string, unknown> = {}) => ({ marketId: MARKET_1, side: "YES", amount: 10, ...extra });
const placeOrder = (harness: Harness, key: string | null, body: unknown, token = asTrader()) =>
  call(harness, "POST", "/v1/trading/orders", { token, body, ...(key === null ? {} : { headers: withKey(key) }) });
const REPEATED_KEY = "key-for-the-repeat-200";
const saleQuoteUrl = (marketId: string, sharesMicro: number) => `/v1/trading/sale-quote?marketId=${marketId}&side=YES&sharesMicro=${sharesMicro}`;
const saleBody = (extra: Record<string, unknown> = {}) => ({ marketId: MARKET_1, side: "YES", sharesMicro: 1_000_000, ...extra });
const sellShares = (harness: Harness, key: string | null, body: unknown, token = asTrader()) =>
  call(harness, "POST", "/v1/trading/sales", { token, body, ...(key === null ? {} : { headers: withKey(key) }) });
const REPEATED_SALE_KEY = "key-for-the-sale-repeat-200";

const publicScenarios: Record<string, Scenario> = {
  "GET /v1/trading/quote 200": (x) => call(x, "GET", quoteUrl(MARKET_1, 10)),
  "GET /v1/trading/quote 400": (x) => call(x, "GET", quoteUrl(MARKET_1, 0)),
  "GET /v1/trading/quote 401": (x) => call(x, "GET", quoteUrl(MARKET_1, 10), { token: null }),
  "GET /v1/trading/quote 403": (x) => call(x, "GET", quoteUrl(MARKET_1, 10), { token: asPlatformAdmin() }),
  "GET /v1/trading/quote 404": (x) => call(x, "GET", quoteUrl(UNKNOWN_MARKET, 10)),
  "GET /v1/trading/quote 409": (x) => call(x, "GET", quoteUrl(MARKET_1, 131)),
  "GET /v1/trading/quote 503": (x) => keysDown(x, () => call(x, "GET", quoteUrl(MARKET_1, 10))),
  "POST /v1/trading/orders 201": (x) => placeOrder(x, newKey(x.core), order()),
  "POST /v1/trading/orders 200": async (x) => {
    await placeOrder(x, REPEATED_KEY, order({ amount: 7 }));
    return placeOrder(x, REPEATED_KEY, order({ amount: 7 }));
  },
  "POST /v1/trading/orders 400": (x) => placeOrder(x, null, order()),
  "POST /v1/trading/orders 401": (x) => call(x, "POST", "/v1/trading/orders", { token: null, headers: withKey(newKey(x.core)), body: order() }),
  "POST /v1/trading/orders 403": (x) => placeOrder(x, newKey(x.core), order(), asTenantAdmin()),
  "POST /v1/trading/orders 404": (x) => placeOrder(x, newKey(x.core), order({ marketId: UNKNOWN_MARKET })),
  "POST /v1/trading/orders 409": (x) => placeOrder(x, newKey(x.core), order({ amount: 131 })),
  "POST /v1/trading/orders 422": (x) => placeOrder(x, REPEATED_KEY, order({ amount: 8 })),
  "POST /v1/trading/orders 503": async (x) => {
    x.core.rules.rules.ordersEnabled = false;
    try {
      return await placeOrder(x, newKey(x.core), order());
    } finally {
      x.core.rules.rules.ordersEnabled = true;
    }
  },
  // UC-08. The orders above left the trader 42.5 YES shares; the NO offers hold 300 shares.
  "GET /v1/trading/sale-quote 200": (x) => call(x, "GET", saleQuoteUrl(MARKET_1, 1_000_000)),
  "GET /v1/trading/sale-quote 400": (x) => call(x, "GET", saleQuoteUrl(MARKET_1, 0)),
  "GET /v1/trading/sale-quote 401": (x) => call(x, "GET", saleQuoteUrl(MARKET_1, 1_000_000), { token: null }),
  "GET /v1/trading/sale-quote 403": (x) => call(x, "GET", saleQuoteUrl(MARKET_1, 1_000_000), { token: asPlatformAdmin() }),
  "GET /v1/trading/sale-quote 404": (x) => call(x, "GET", saleQuoteUrl(UNKNOWN_MARKET, 1_000_000)),
  "GET /v1/trading/sale-quote 409": (x) => call(x, "GET", saleQuoteUrl(MARKET_1, 400_000_000)),
  "GET /v1/trading/sale-quote 503": (x) => keysDown(x, () => call(x, "GET", saleQuoteUrl(MARKET_1, 1_000_000))),
  "POST /v1/trading/sales 201": (x) => sellShares(x, newKey(x.core), saleBody()),
  "POST /v1/trading/sales 200": async (x) => {
    await sellShares(x, REPEATED_SALE_KEY, saleBody({ sharesMicro: 2_000_000 }));
    return sellShares(x, REPEATED_SALE_KEY, saleBody({ sharesMicro: 2_000_000 }));
  },
  "POST /v1/trading/sales 400": (x) => sellShares(x, null, saleBody()),
  "POST /v1/trading/sales 401": (x) => call(x, "POST", "/v1/trading/sales", { token: null, headers: withKey(newKey(x.core)), body: saleBody() }),
  "POST /v1/trading/sales 403": (x) => sellShares(x, newKey(x.core), saleBody(), asTenantAdmin()),
  "POST /v1/trading/sales 404": (x) => sellShares(x, newKey(x.core), saleBody({ marketId: UNKNOWN_MARKET })),
  "POST /v1/trading/sales 409": (x) => sellShares(x, newKey(x.core), saleBody({ sharesMicro: 100_000_000 })),
  "POST /v1/trading/sales 422": (x) => sellShares(x, REPEATED_SALE_KEY, saleBody({ sharesMicro: 3_000_000 })),
  "POST /v1/trading/sales 503": async (x) => {
    x.core.rules.rules.ordersEnabled = false;
    try {
      return await sellShares(x, newKey(x.core), saleBody());
    } finally {
      x.core.rules.rules.ordersEnabled = true;
    }
  },
  "GET /v1/trading/portfolio 200": (x) => call(x, "GET", "/v1/trading/portfolio"),
  "GET /v1/trading/portfolio 400": (x) => call(x, "GET", "/v1/trading/portfolio?limit=0"),
  "GET /v1/trading/portfolio 401": (x) => call(x, "GET", "/v1/trading/portfolio", { token: null }),
  "GET /v1/trading/portfolio 403": (x) => call(x, "GET", "/v1/trading/portfolio", { token: asPlatformAdmin() }),
  "GET /v1/trading/portfolio 503": (x) => keysDown(x, () => call(x, "GET", "/v1/trading/portfolio")),
  "GET /health/startup 200": (x) => call(x, "GET", "/health/startup", { token: null }),
  "GET /health/ready 200": (x) => call(x, "GET", "/health/ready", { token: null }),
  "GET /health/ready 503": async (x) => {
    x.setDraining(true);
    try {
      return await call(x, "GET", "/health/ready", { token: null });
    } finally {
      x.setDraining(false);
    }
  },
  "GET /health/live 200": (x) => call(x, "GET", "/health/live", { token: null }),
};

const FUNDING = "/v1/internal/market-funding";
const DEBITS = "/v1/internal/debits";
const MARKETS = "/v1/internal/markets";
const ORDERS = "/v1/internal/markets/{marketId}/bot-orders";
const bookUrl = (marketId: string) => `/v1/internal/markets/${marketId}/bot-book`;
const ordersUrl = (marketId: string) => `/v1/internal/markets/${marketId}/bot-orders`;
const fund = (x: Harness, marketId: string, amount: number, options: { creatorId?: string; client?: "markets" | "payments"; token?: null; key?: string | null } = {}) =>
  callInternal(x, "POST", FUNDING, {
    client: options.client ?? "markets",
    ...(options.token === null ? { token: null } : {}),
    body: fundingBody(marketId, amount, options.creatorId ? { creatorId: options.creatorId } : {}),
    ...(options.key === null ? {} : { headers: withKey(options.key ?? marketId) }),
  });
const debit = (x: Harness, withdrawalId: string, amount: number, options: { client?: "markets" | "payments"; headers?: Record<string, string> } = {}) =>
  callInternal(x, "POST", DEBITS, { client: options.client ?? "payments", headers: options.headers ?? {}, body: { withdrawalId, tenantId: TENANT_A, userId: TRADER, amount } });
const putBook = (x: Harness, marketId: string, basedOnSequence: number, offers: unknown, client: "market-maker" | "markets" = "market-maker") =>
  callInternal(x, "PUT", ordersUrl(marketId), { client, body: { basedOnSequence, offers } });

const internalScenarios: Record<string, Scenario> = {
  "POST /v1/internal/market-funding 201": async (x) => {
    await grant(x.core, "admin-funding", 100);
    return fund(x, FUNDED_MARKET, 100, { creatorId: "admin-funding" });
  },
  "POST /v1/internal/market-funding 200": (x) => fund(x, FUNDED_MARKET, 100, { creatorId: "admin-funding" }),
  "POST /v1/internal/market-funding 400": (x) => fund(x, MARKET_2, 100, { key: null }),
  "POST /v1/internal/market-funding 401": (x) => fund(x, MARKET_2, 100, { token: null }),
  "POST /v1/internal/market-funding 403": (x) => fund(x, MARKET_2, 100, { client: "payments" }),
  "POST /v1/internal/market-funding 409": (x) => fund(x, POOR_MARKET, 100, { creatorId: "poor-creator" }),
  "POST /v1/internal/market-funding 422": (x) => fund(x, FUNDED_MARKET, 101, { creatorId: "admin-funding" }),
  "POST /v1/internal/market-funding 503": (x) => keysDown(x, () => fund(x, MARKET_2, 100)),
  "POST /v1/internal/debits 200": (x) => debit(x, WITHDRAWAL_1, 10),
  "POST /v1/internal/debits 400": (x) => debit(x, WITHDRAWAL_2, 10, { headers: withKey(WITHDRAWAL_1) }),
  "POST /v1/internal/debits 401": (x) => callInternal(x, "POST", DEBITS, { token: null, body: { withdrawalId: WITHDRAWAL_2, tenantId: TENANT_A, userId: TRADER, amount: 10 } }),
  "POST /v1/internal/debits 403": (x) => debit(x, WITHDRAWAL_2, 10, { client: "markets" }),
  "POST /v1/internal/debits 409": (x) => debit(x, WITHDRAWAL_2, 100_000),
  "POST /v1/internal/debits 422": (x) => debit(x, WITHDRAWAL_1, 11),
  "POST /v1/internal/debits 503": (x) => keysDown(x, () => debit(x, WITHDRAWAL_2, 10)),
  "GET /v1/internal/markets 200": (x) => callInternal(x, "GET", `${MARKETS}?status=open`, { client: "market-maker" }),
  "GET /v1/internal/markets 400": (x) => callInternal(x, "GET", MARKETS, { client: "market-maker" }),
  "GET /v1/internal/markets 401": (x) => callInternal(x, "GET", `${MARKETS}?status=open`, { token: null }),
  "GET /v1/internal/markets 403": (x) => callInternal(x, "GET", `${MARKETS}?status=open`, { client: "markets" }),
  "GET /v1/internal/markets 503": (x) => keysDown(x, () => callInternal(x, "GET", `${MARKETS}?status=open`, { client: "market-maker" })),
  "GET /v1/internal/markets/{marketId}/bot-book 200": (x) => callInternal(x, "GET", bookUrl(MARKET_1), { client: "market-maker" }),
  "GET /v1/internal/markets/{marketId}/bot-book 400": (x) => callInternal(x, "GET", bookUrl("not-a-uuid"), { client: "market-maker" }),
  "GET /v1/internal/markets/{marketId}/bot-book 401": (x) => callInternal(x, "GET", bookUrl(MARKET_1), { token: null }),
  "GET /v1/internal/markets/{marketId}/bot-book 403": (x) => callInternal(x, "GET", bookUrl(MARKET_1), { client: "payments" }),
  "GET /v1/internal/markets/{marketId}/bot-book 404": (x) => callInternal(x, "GET", bookUrl(UNKNOWN_MARKET), { client: "market-maker" }),
  "GET /v1/internal/markets/{marketId}/bot-book 503": (x) => keysDown(x, () => callInternal(x, "GET", bookUrl(MARKET_1), { client: "market-maker" })),
  "PUT /v1/internal/markets/{marketId}/bot-orders 200": async (x) => {
    const book = await x.core.useCases.getBotBook.execute({ caller: { client: "market-maker", correlationId: "c", causationId: "r" }, marketId: MARKET_1 });
    return putBook(x, MARKET_1, book.tradeSequence, DEFAULT_OFFERS);
  },
  "PUT /v1/internal/markets/{marketId}/bot-orders 400": (x) => putBook(x, MARKET_1, 0, [{ side: "YES", priceMicro: 405_000, sharesMicro: 1 }]),
  "PUT /v1/internal/markets/{marketId}/bot-orders 401": (x) => callInternal(x, "PUT", ordersUrl(MARKET_1), { token: null, body: { basedOnSequence: 0, offers: [] } }),
  "PUT /v1/internal/markets/{marketId}/bot-orders 403": (x) => putBook(x, MARKET_1, 0, [], "markets"),
  "PUT /v1/internal/markets/{marketId}/bot-orders 404": (x) => putBook(x, UNKNOWN_MARKET, 0, []),
  "PUT /v1/internal/markets/{marketId}/bot-orders 409": (x) => putBook(x, MARKET_1, 9999, []),
  "PUT /v1/internal/markets/{marketId}/bot-orders 503": (x) => keysDown(x, () => putBook(x, MARKET_1, 0, [])),
};

/** The three kinds of answer carry the headers the contracts document. */
function expectHeaders(path: string, answer: Answer): void {
  if (!path.startsWith("/v1/")) return;
  expect(answer.headers["cache-control"]).toBe("private, no-store");
  expect(answer.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  if (answer.status === 503) expect(Number(answer.headers["retry-after"])).toBeGreaterThan(0);
  if (answer.status === 401 && path.startsWith("/v1/trading/")) expect(answer.headers["www-authenticate"]).toContain("Bearer");
}

describe("every status code of contracts/openapi.yaml", () => {
  it("is provoked by exactly one scenario below, and no scenario provokes an undocumented one", () => {
    expect(Object.keys(publicScenarios).sort()).toEqual(documentedAnswers(openapi));
  });

  for (const [name, scenario] of Object.entries(publicScenarios)) {
    it(`${name} answers with a body that validates against its schema`, async () => {
      const [method = "", path = "", status = ""] = name.split(" ");
      const answer = await scenario(h);
      expect(answer.status, JSON.stringify(answer.body)).toBe(Number(status));
      expect(responseErrorsIn(openapi, path, method, answer.status, answer.body)).toEqual([]);
      expectHeaders(path, answer);
    });
  }
});

describe("every status code of contracts/internal.openapi.yaml", () => {
  it("is provoked by exactly one scenario below, and no scenario provokes an undocumented one", () => {
    expect(Object.keys(internalScenarios).sort()).toEqual(documentedAnswers(internalOpenapi));
  });

  for (const [name, scenario] of Object.entries(internalScenarios)) {
    it(`${name} answers with a body that validates against its schema`, async () => {
      const [method = "", path = "", status = ""] = name.split(" ");
      const answer = await scenario(h);
      expect(answer.status, JSON.stringify(answer.body)).toBe(Number(status));
      expect(responseErrorsIn(internalOpenapi, path, method, answer.status, answer.body)).toEqual([]);
      expectHeaders(path, answer);
    });
  }
});

describe("the offer limit of the bot book (contracts/internal.openapi.yaml)", () => {
  const BOT_BOOK = "/v1/internal/markets/{marketId}/bot-book";

  it("is a required integer from 1 to 50 of GET bot-book and of the book PUT bot-orders returns", async () => {
    const answer = await callInternal(h, "GET", bookUrl(MARKET_1), { client: "market-maker" });
    expect(answer.status).toBe(200);
    const book = answer.body as Record<string, unknown>;
    expect(book["maxOffersPerSide"]).toBe(h.core.rules.rules.maxOffersPerSide);
    expect(responseErrorsIn(internalOpenapi, BOT_BOOK, "GET", 200, book)).toEqual([]);

    const without = { ...book };
    delete without["maxOffersPerSide"];
    expect(responseErrorsIn(internalOpenapi, BOT_BOOK, "GET", 200, without)).not.toEqual([]);
    for (const outside of [0, 51, 2.5, "10"]) {
      expect(responseErrorsIn(internalOpenapi, BOT_BOOK, "GET", 200, { ...book, maxOffersPerSide: outside }), String(outside)).not.toEqual([]);
    }

    const replaced = await putBook(h, MARKET_1, book["tradeSequence"] as number, DEFAULT_OFFERS);
    expect(replaced.status).toBe(200);
    expect(replaced.body?.["maxOffersPerSide"]).toBe(h.core.rules.rules.maxOffersPerSide);
  });
});

describe("the request bodies of the contracts", () => {
  it("are accepted when they validate against the contract and refused with 400 when they do not (one schema, two checks)", async () => {
    const own = await createHarness();
    await openMarket(own.core);
    const known = fundingBody(MARKET_1, 10);
    const cases: Array<[string, string, string, unknown, (body: unknown) => Promise<Answer>]> = [
      ["funding", FUNDING, "post", known, (body) => callInternal(own, "POST", FUNDING, { client: "markets", body, headers: withKey(MARKET_1) })],
      ["funding, amount 0", FUNDING, "post", { ...known, amount: 0 }, (body) => callInternal(own, "POST", FUNDING, { client: "markets", body, headers: withKey(MARKET_1) })],
      ["funding, extra field", FUNDING, "post", { ...known, extra: 1 }, (body) => callInternal(own, "POST", FUNDING, { client: "markets", body, headers: withKey(MARKET_1) })],
      ["debit", DEBITS, "post", { withdrawalId: WITHDRAWAL_1, tenantId: TENANT_A, userId: TRADER, amount: 1 }, (body) => callInternal(own, "POST", DEBITS, { client: "payments", body })],
      ["debit, amount above the maximum", DEBITS, "post", { withdrawalId: WITHDRAWAL_1, tenantId: TENANT_A, userId: TRADER, amount: 1_000_001 }, (body) => callInternal(own, "POST", DEBITS, { client: "payments", body })],
      ["bot orders", ORDERS.replace("{marketId}", MARKET_1), "put", { basedOnSequence: 0, offers: DEFAULT_OFFERS }, (body) => callInternal(own, "PUT", ordersUrl(MARKET_1), { client: "market-maker", body })],
      ["bot orders, price off the grid", ORDERS.replace("{marketId}", MARKET_1), "put", { basedOnSequence: 0, offers: [{ side: "NO", priceMicro: 5, sharesMicro: 1 }] }, (body) => callInternal(own, "PUT", ordersUrl(MARKET_1), { client: "market-maker", body })],
      ["order", "/v1/trading/orders", "post", order({ maxAveragePriceMicro: 500_000 }), (body) => placeOrder(own, newKey(own.core), body)],
      ["order, price limit zero", "/v1/trading/orders", "post", order({ maxAveragePriceMicro: 0 }), (body) => placeOrder(own, newKey(own.core), body)],
      ["order, unknown side", "/v1/trading/orders", "post", order({ side: "MAYBE" }), (body) => placeOrder(own, newKey(own.core), body)],
    ];
    await grant(own.core, TRADER, 100);
    for (const [name, path, method, body, send] of cases) {
      const doc = path.startsWith("/v1/internal") ? internalOpenapi : openapi;
      const templated = path.replace(MARKET_1, "{marketId}");
      const valid = requestErrorsIn(doc, templated, method, body).length === 0;
      const answer = await send(body);
      // A body the contract accepts is never a 400 (the funding of the market that is already funded is a 422, not a shape error).
      if (valid) expect([400, 401, 403], `${name} -> ${answer.status} ${JSON.stringify(answer.body)}`).not.toContain(answer.status);
      else expect(answer.status, name).toBe(400);
    }
    await own.close();
  });
});

// --- the events ---

describe("contracts/asyncapi.yaml", () => {
  const SCHEMA_OF: Record<string, string> = {
    "si.chance.trading.TradeExecuted.v1": "TradeExecutedEvent",
    "si.chance.trading.MarketFunded.v1": "MarketFundedEvent",
    "si.chance.trading.MarketSettled.v1": "MarketSettledEvent",
    "si.chance.trading.WithdrawalRefunded.v1": "WithdrawalRefundedEvent",
  };

  /** A scenario that makes the use cases write all four events: a funded market, a YES and a NO buy, a refund, a settlement. */
  async function scenario() {
    const own = await createHarness();
    await openMarket(own.core);
    await grant(own.core, TRADER, 500);
    expect((await placeOrder(own, newKey(own.core), order({ amount: 10 }))).status).toBe(201);
    expect((await placeOrder(own, newKey(own.core), order({ amount: 10, side: "NO" }))).status).toBe(201);
    expect((await debit(own, WITHDRAWAL_1, 20)).status).toBe(200);
    await own.core.useCases.recordPaymentEvent.execute(withdrawalFailed(own.core, WITHDRAWAL_1, TRADER, 20));
    await own.core.useCases.recordMarketEvent.execute(marketResolved(own.core, "YES", { version: 3 }));
    return own;
  }

  it("is AsyncAPI 3.0 with one channel and one send operation per published event, and the consumed ones", () => {
    expect(asyncapi["asyncapi"]).toMatch(/^3\.0\./);
    const names: EventName[] = ["TradeExecuted", "MarketFunded", "MarketSettled", "WithdrawalRefunded"];
    const channels = Object.values(asyncapi["channels"] as Record<string, { address: string }>).map((channel) => channel.address).sort();
    expect(channels).toEqual(
      [...names.map((name) => natsSubject(name, "{tenantId}")), "chance.tenants.TenantCreated.{tenantId}", "chance.markets.{event}.{tenantId}", "chance.payments.{event}.{tenantId}"].sort(),
    );
    const actions = Object.values(asyncapi["operations"] as Record<string, { action: string }>).map((operation) => operation.action).sort();
    expect(actions).toEqual(["receive", "receive", "receive", "send", "send", "send", "send"]);
  });

  it("accepts the four events the use cases really write to the outbox, each with its subject and its id as the deduplication key", async () => {
    const own = await scenario();
    const rows = own.core.store.snapshot().outbox;
    expect([...new Set(rows.map((row) => row.type))].sort()).toEqual(Object.keys(SCHEMA_OF).sort());
    for (const row of rows) {
      expect(eventErrors(SCHEMA_OF[row.type] ?? "", row.payload), row.type).toEqual([]);
      expect(row.id).toBe(row.payload.id);
      expect(row.subject).toBe(natsSubject(row.type.split(".")[3] as EventName, TENANT_A));
      expect(row.payload.tenantid).toBe(TENANT_A);
    }
    await own.close();
  });

  it("accepts MarketSettled of an INVALID resolution (UC-16) and the portfolio's refund entry", async () => {
    const own = await createHarness();
    await openMarket(own.core);
    await grant(own.core, TRADER, 500);
    expect((await placeOrder(own, newKey(own.core), order({ amount: 10 }))).status).toBe(201);
    await own.core.useCases.recordMarketEvent.execute(marketResolved(own.core, "INVALID", { version: 3 }));
    const settled = own.core.store.snapshot().outbox.find((row) => row.type === "si.chance.trading.MarketSettled.v1");
    expect(settled?.payload.data).toMatchObject({ outcome: "INVALID", payoutTotalMicro: 10_000_000, payoutCount: 1, returnedToCreatorMicro: 1_000_000_000 });
    expect(eventErrors("MarketSettledEvent", settled?.payload)).toEqual([]);
    const portfolio = await call(own, "GET", "/v1/trading/portfolio");
    expect(portfolio.status).toBe(200);
    expect(portfolio.body?.["payouts"]).toEqual([expect.objectContaining({ kind: "refund", outcome: "INVALID", amountMicro: 10_000_000 })]);
    expect(responseErrorsIn(openapi, "/v1/trading/portfolio", "GET", 200, portfolio.body)).toEqual([]);
    await own.close();
  });

  it("accepts the TradeExecuted of a sale (UC-08, kind sale: the buy of the other side) and the portfolio's sale entry", async () => {
    const own = await createHarness();
    await openMarket(own.core);
    await grant(own.core, TRADER, 500);
    expect((await placeOrder(own, newKey(own.core), order({ amount: 10 }))).status).toBe(201);
    const sold = await sellShares(own, newKey(own.core), saleBody({ sharesMicro: 5_000_000 }));
    expect(sold.status).toBe(201);
    expect(responseErrorsIn(openapi, "/v1/trading/sales", "POST", 201, sold.body)).toEqual([]);
    // 5 YES sold = 5 NO bought at 0.60 for 3 credits, the 5 pairs redeemed for 5: 2 credits of proceeds.
    expect(sold.body).toMatchObject({ side: "YES", sharesMicro: 5_000_000, costMicro: 3_000_000, proceedsMicro: 2_000_000, averagePriceMicro: 400_000 });
    const trades = own.core.store.snapshot().outbox.filter((row) => row.type === "si.chance.trading.TradeExecuted.v1").map((row) => row.payload);
    expect(trades.map((event) => (event.data as Record<string, unknown>)["kind"])).toEqual(["buy", "sale"]);
    for (const event of trades) expect(eventErrors("TradeExecutedEvent", event)).toEqual([]);
    expect(trades[1]?.data).toMatchObject({ side: "NO", sharesMicro: 5_000_000, costMicro: 3_000_000, lastPriceMicro: 600_000, yesPriceMicro: 400_000, tradeSequence: 2 });
    const portfolio = await call(own, "GET", "/v1/trading/portfolio");
    expect(responseErrorsIn(openapi, "/v1/trading/portfolio", "GET", 200, portfolio.body)).toEqual([]);
    expect(portfolio.body?.["recentTrades"]).toEqual([
      expect.objectContaining({ kind: "sale", side: "YES", sharesMicro: 5_000_000, proceedsMicro: 2_000_000 }),
      expect.objectContaining({ kind: "buy", side: "YES", proceedsMicro: null }),
    ]);
    // An event without kind (a producer before UC-08) still validates: the field is optional.
    const { kind: _kind, ...withoutKind } = trades[0]?.data as Record<string, unknown>;
    expect(eventErrors("TradeExecutedEvent", { ...trades[0], data: withoutKind })).toEqual([]);
    expect(eventErrors("TradeExecutedEvent", { ...trades[0], data: { ...withoutKind, kind: "swap" } })).not.toEqual([]);
    await own.close();
  });

  it("states the YES price of a trade as the contract describes it: the last price for YES, one credit minus it for NO", async () => {
    const own = await scenario();
    const trades = own.core.store.snapshot().outbox.filter((row) => row.type === "si.chance.trading.TradeExecuted.v1").map((row) => row.payload.data as Record<string, number | string>);
    const yes = trades.find((trade) => trade["side"] === "YES");
    const no = trades.find((trade) => trade["side"] === "NO");
    expect(yes?.["yesPriceMicro"]).toBe(yes?.["lastPriceMicro"]);
    expect(no?.["yesPriceMicro"]).toBe(1_000_000 - Number(no?.["lastPriceMicro"]));
    expect(trades.map((trade) => trade["tradeSequence"])).toEqual([1, 2]);
    await own.close();
  });

  it("rejects an event that breaks the contract", async () => {
    const own = await scenario();
    const good = own.core.store.snapshot().outbox.find((row) => row.type === "si.chance.trading.TradeExecuted.v1")?.payload as Record<string, any>;
    expect(eventErrors("TradeExecutedEvent", good)).toEqual([]);
    const { tenantid: _removed, ...withoutTenant } = good;
    expect(eventErrors("TradeExecutedEvent", withoutTenant)).not.toEqual([]);
    expect(eventErrors("TradeExecutedEvent", { ...good, specversion: "0.3" })).not.toEqual([]);
    expect(eventErrors("TradeExecutedEvent", { ...good, type: "si.chance.trading.MarketFunded.v1" })).not.toEqual([]);
    expect(eventErrors("TradeExecutedEvent", { ...good, source: "/chance/markets" })).not.toEqual([]);
    expect(eventErrors("TradeExecutedEvent", { ...good, id: "not-a-uuid" })).not.toEqual([]);
    // A field the contract does not know, such as a user's e-mail address, must not slip into the data (DM-14).
    expect(eventErrors("TradeExecutedEvent", { ...good, data: { ...good["data"], email: "someone@example.test" } })).not.toEqual([]);
    expect(eventErrors("TradeExecutedEvent", { ...good, data: { ...good["data"], yesPriceMicro: 5 } })).not.toEqual([]);
    await own.close();
  });

  it("describes the consumed events loosely: what the sibling services publish passes, an unknown type or a missing tenant does not", () => {
    const base = { specversion: "1.0", id: "018f3c1e-7a00-7000-8000-000000000001", tenantid: TENANT_A, correlationid: "c", data: {} };
    for (const type of [
      "si.chance.tenants.TenantCreated.v1",
      "si.chance.markets.MarketOpened.v1",
      "si.chance.markets.MarketClosed.v1",
      "si.chance.markets.MarketResolved.v1",
      "si.chance.payments.DepositSucceeded.v1",
      "si.chance.payments.WithdrawalFailed.v1",
    ]) {
      expect(eventErrors("ConsumedEvent", { ...base, type }), type).toEqual([]);
    }
    expect(eventErrors("ConsumedEvent", { ...base, type: "si.chance.markets.MarketDeleted.v1" })).not.toEqual([]);
    const { tenantid: _removed, ...withoutTenant } = { ...base, type: "si.chance.markets.MarketOpened.v1" };
    expect(eventErrors("ConsumedEvent", withoutTenant)).not.toEqual([]);
  });

  it("emits a WithdrawalRefunded that validates against payments' proposal of it (the consumer's side)", async () => {
    const own = await scenario();
    const refunded = own.core.store.snapshot().outbox.find((row) => row.type === "si.chance.trading.WithdrawalRefunded.v1");
    expect(refunded).toBeDefined();
    expect(eventErrorsIn(paymentsAsyncapi, "WithdrawalRefundedEvent", refunded?.payload)).toEqual([]);
    await own.close();
  });
});

// --- the consumers' side: what the calling services expect of the internal API ---

/** A schema without the prose, so that two files that word a description differently still compare equal. */
const withoutDescriptions = (schema: unknown): unknown => JSON.parse(JSON.stringify(schema, (key, value: unknown) => (key === "description" ? undefined : value)));

describe("markets' outgoing contract of the funding call", () => {
  const contract: Doc = marketsFundingContract;
  let own: Harness;
  beforeAll(async () => {
    own = await createHarness();
    await grant(own.core, CREATOR, 1000);
  });
  afterAll(async () => {
    await own.close();
  });

  it("names the same server, the same path and the same request as trading's internal contract", () => {
    expect((contract["servers"] as Array<{ url: string }>)[0]?.url).toBe((internalOpenapi["servers"] as Array<{ url: string }>)[0]?.url);
    expect(Object.keys(contract["paths"])).toEqual([FUNDING]);
    expect(withoutDescriptions(internalOpenapi["components"].schemas.MarketFundingRequest)).toEqual(withoutDescriptions(contract["components"].schemas.MarketFundingRequest));
    expect(withoutDescriptions(contract["paths"][FUNDING].post.parameters)).toEqual(withoutDescriptions(internalOpenapi["paths"][FUNDING].post.parameters));
  });

  it("documents every status trading answers: trading documents no status markets does not know", () => {
    const known = documentedStatuses(contract, FUNDING, "post");
    for (const status of documentedStatuses(internalOpenapi, FUNDING, "post")) expect(known, `status ${status}`).toContain(status);
  });

  it("is answered in the form markets reads: 201 then 200 with a MarketFunding, 409 with the code insufficient_credits, 422, 400, 401, 403 and 503", async () => {
    const answers: Answer[] = [];
    answers.push(await fund(own, MARKET_1, 400)); // 201
    answers.push(await fund(own, MARKET_1, 400)); // 200: a repeat of a funded key
    answers.push(await fund(own, MARKET_2, 5000)); // 409: the creator has 600 left
    answers.push(await fund(own, MARKET_1, 401)); // 422
    answers.push(await fund(own, MARKET_2, 5000, { key: null })); // 400
    answers.push(await fund(own, MARKET_2, 5000, { token: null })); // 401
    answers.push(await fund(own, MARKET_2, 5000, { client: "payments" })); // 403
    answers.push(await keysDown(own, () => fund(own, MARKET_2, 5000))); // 503
    expect(answers.map((answer) => answer.status)).toEqual([201, 200, 409, 422, 400, 401, 403, 503]);
    for (const answer of answers) expect(responseErrorsIn(contract, FUNDING, "post", answer.status, answer.body), `${answer.status}`).toEqual([]);

    // markets puts the market back in draft on exactly this code and type, and retries an answer that is not definitive.
    expect(answers[2]?.body).toMatchObject({ code: "insufficient_credits", type: "urn:chance:problem:insufficient-credits" });
    expect(answers.map((answer) => answer.body?.["code"])).not.toContain("idempotency_in_progress");
    expect(answers[7]?.headers["retry-after"]).toBeDefined();
    // The refusals took and stored nothing: the creator still has what the one funding left.
    const creator = await call(own, "GET", "/v1/trading/portfolio", { token: asTenantAdmin() });
    expect(creator.body?.["balanceMicro"]).toBe(600 * 1_000_000);
  });

  it("accepts every body markets' schema accepts, and refuses every body it refuses", async () => {
    const fresh = (n: number) => `018f3c1e-7a00-7000-8000-0000000002${String(n).padStart(2, "0")}`;
    const bodies: unknown[] = [
      fundingBody(fresh(1), 1),
      fundingBody(fresh(2), 1_000_000),
      fundingBody(fresh(3), 10, { creatorId: "c".repeat(255) }),
      fundingBody(fresh(4), 0),
      fundingBody(fresh(5), 1_000_001),
      fundingBody(fresh(6), 1.5),
      { ...fundingBody(fresh(7), 10), amount: "10" },
      { ...fundingBody(fresh(8), 10), marketId: "not-a-uuid" },
      { ...fundingBody(fresh(9), 10), tenantId: "acme" },
      { ...fundingBody(fresh(10), 10), creatorId: "" },
      { ...fundingBody(fresh(11), 10), creatorId: "c".repeat(256) },
      { ...fundingBody(fresh(12), 10), email: "someone@example.test" },
      { marketId: fresh(13), tenantId: TENANT_A, amount: 10 },
    ];
    for (const body of bodies) {
      const marketId = (body as { marketId: string }).marketId;
      const valid = requestErrorsIn(contract, FUNDING, "post", body).length === 0;
      const answer = await callInternal(own, "POST", FUNDING, { client: "markets", body, headers: withKey(marketId) });
      if (valid) expect(answer.status, JSON.stringify(body)).not.toBe(400);
      else expect(answer.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("payments' proposal of the debit call", () => {
  const contract: Doc = paymentsDebitContract;
  let own: Harness;
  beforeAll(async () => {
    own = await createHarness();
    await grant(own.core, TRADER, 100);
  });
  afterAll(async () => {
    await own.close();
  });

  it("names the same path, request and result as trading's internal contract", () => {
    expect(Object.keys(contract["paths"])).toEqual([DEBITS]);
    expect(withoutDescriptions(internalOpenapi["components"].schemas.DebitRequest)).toEqual(withoutDescriptions(contract["components"].schemas.DebitRequest));
    expect(withoutDescriptions(internalOpenapi["components"].schemas.DebitResult)).toEqual(withoutDescriptions(contract["components"].schemas.DebitResult));
  });

  it("documents every status payments handles, and adds at most the 422 of a withdrawal id reused across tenants", () => {
    const trading = documentedStatuses(internalOpenapi, DEBITS, "post");
    const proposal = documentedStatuses(contract, DEBITS, "post");
    for (const status of proposal) expect(trading, `status ${status}`).toContain(status);
    expect(trading).toContain(422);
    expect(trading.filter((status) => !proposal.includes(status) && status !== 422)).toEqual([]);
  });

  it("is answered in the form payments reads: 200 debited, 409 insufficient_credits, definitive both; 400, 401, 403 and 503 with Retry-After", async () => {
    const answers: Answer[] = [];
    answers.push(await debit(own, WITHDRAWAL_1, 30)); // 200 without the optional Idempotency-Key header (payments sends it; equal to withdrawalId)
    answers.push(await debit(own, WITHDRAWAL_1, 30)); // 200 again: idempotent by withdrawalId
    answers.push(await debit(own, WITHDRAWAL_2, 5000)); // 409
    answers.push(await debit(own, WITHDRAWAL_2, 5000)); // 409 again, definitive
    answers.push(await debit(own, WITHDRAWAL_2, 0)); // 400
    answers.push(await callInternal(own, "POST", DEBITS, { token: null, body: { withdrawalId: WITHDRAWAL_2, tenantId: TENANT_A, userId: TRADER, amount: 1 } })); // 401
    answers.push(await debit(own, WITHDRAWAL_2, 1, { client: "markets" })); // 403
    answers.push(await keysDown(own, () => debit(own, WITHDRAWAL_2, 1))); // 503
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 409, 409, 400, 401, 403, 503]);
    for (const answer of answers) expect(responseErrorsIn(contract, DEBITS, "post", answer.status, answer.body), `${answer.status}`).toEqual([]);
    expect(answers[0]?.body).toEqual({ withdrawalId: WITHDRAWAL_1, status: "debited" });
    expect(answers[2]?.body).toMatchObject({ code: "insufficient_credits" });
    expect(answers[7]?.headers["retry-after"]).toBeDefined();
  });

  it("accepts every body payments' schema accepts, and refuses every body it refuses", async () => {
    const id = (n: number) => `018f3c1e-7a00-7000-8000-0000000003${String(n).padStart(2, "0")}`;
    const good = (n: number) => ({ withdrawalId: id(n), tenantId: TENANT_A, userId: TRADER, amount: 1 });
    const bodies: unknown[] = [
      good(1),
      { ...good(2), amount: 1_000_000 },
      { ...good(3), userId: "u".repeat(255) },
      { ...good(4), amount: 0 },
      { ...good(5), amount: 1_000_001 },
      { ...good(6), amount: 2.5 },
      { ...good(7), amount: "1" },
      { ...good(8), withdrawalId: "w-8" },
      { ...good(9), tenantId: "acme" },
      { ...good(10), userId: "" },
      { ...good(11), userId: "u".repeat(256) },
      { ...good(12), iban: "SI56 0000 0000 0000 000" },
      { withdrawalId: id(13), tenantId: TENANT_A, amount: 1 },
    ];
    for (const body of bodies) {
      const valid = requestErrorsIn(contract, DEBITS, "post", body).length === 0;
      const answer = await callInternal(own, "POST", DEBITS, { client: "payments", body });
      if (valid) expect(answer.status, JSON.stringify(body)).not.toBe(400);
      else expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect(schemaErrorsIn(contract, "DebitResult", { withdrawalId: id(1), status: "debited" })).toEqual([]);
  });
});
