import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conflict } from "../../src/usecases/errors.js";
import { MARKET_1, TENANT_A, TRADER } from "../support/fakes.js";
import { asPlatformAdmin, asTrader, call, callInternal, createHarness, expectPublicContract, grant, newKey, openMarket, withKey } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await openMarket(h.core);
  await grant(h.core, TRADER, 500);
});
afterAll(async () => {
  await h.close();
});

const NO_STORE = "private, no-store";
const UNKNOWN_MARKET = "018f3c1e-7a00-7000-8000-0000000000f1";
const order = (extra: Record<string, unknown> = {}) => ({ marketId: MARKET_1, side: "YES", amount: 10, ...extra });

describe("Cache-Control (INF-02)", () => {
  it("is private, no-store on every kind of API answer: 200, 201, 400, 401, 403, 404, 409, 422 and 503", async () => {
    const key = newKey(h.core);
    const answers = [
      await call(h, "GET", "/v1/trading/portfolio"), // 200
      await call(h, "POST", "/v1/trading/orders", { headers: withKey(key), body: order() }), // 201
      await call(h, "GET", "/v1/trading/portfolio?limit=0"), // 400
      await call(h, "GET", "/v1/trading/portfolio", { token: null }), // 401
      await call(h, "GET", "/v1/trading/portfolio", { token: asPlatformAdmin() }), // 403
      await call(h, "GET", `/v1/trading/quote?marketId=${UNKNOWN_MARKET}&side=YES&amount=10`), // 404
      await call(h, "GET", `/v1/trading/quote?marketId=${MARKET_1}&side=YES&amount=131`), // 409
      await call(h, "POST", "/v1/trading/orders", { headers: withKey(key), body: order({ amount: 11 }) }), // 422
      await call(h, "GET", "/v1/trading/portfolio", { token: asTrader("someone", "018f3c1e-7a00-7000-8000-0000000000cc") }), // 503
      await call(h, "GET", "/v1/nothing-here"), // 404 of an unknown path
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 201, 400, 401, 403, 404, 409, 422, 503, 404]);
    for (const answer of answers) expect(answer.headers["cache-control"], `status ${answer.status}`).toBe(NO_STORE);
  });

  it("also covers the answers Fastify gives before a route matches: a path parameter that is far too long", async () => {
    const answer = await callInternal(h, "GET", `/v1/internal/markets/${"a".repeat(600)}/bot-book`, { client: "market-maker" });
    expect(answer.status).toBe(414);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.headers["cache-control"]).toBe(NO_STORE);
    // The detail is a fixed text; Fastify's own message repeats the whole URL.
    expect(answer.body).toMatchObject({ code: "uri_too_long", detail: "A path parameter is too long" });
  });

  it("is left off the health probes, which carry no tenant data", async () => {
    for (const probe of ["startup", "ready", "live"]) {
      const answer = await h.publicApp.inject({ method: "GET", url: `/health/${probe}` });
      expect(answer.headers["cache-control"], probe).toBeUndefined();
    }
  });
});

describe("problem details (RFC 9457)", () => {
  it("answers an unknown path with a 404 problem, and an unsupported method with one too", async () => {
    const unknown = await call(h, "GET", "/v1/unknown");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ status: 404, code: "not_found", instance: "/v1/unknown" });
    const put = await h.publicApp.inject({ method: "PUT", url: "/v1/trading/portfolio", headers: { authorization: `Bearer ${await h.sign(asTrader())}` } });
    expect(put.statusCode).toBe(404);
    expect(put.headers["content-type"]).toContain("application/problem+json");
  });

  it("keeps the query out of the problem's instance and answers with the stable type of the code", async () => {
    const answer = await call(h, "GET", "/v1/trading/portfolio?limit=0");
    expect(answer.body).toMatchObject({ instance: "/v1/trading/portfolio", type: "urn:chance:problem:validation-failed", title: "Bad Request" });
    expectPublicContract("/v1/trading/portfolio", "GET", answer);
  });

  it("copies the extension members of a conflict and turns their dates into text, without letting them replace the fixed members", async () => {
    const own = await createHarness();
    const when = new Date("2026-11-02T08:30:00.000Z");
    own.core.useCases.getPortfolio.execute = () => Promise.reject(new Conflict("custom_conflict", "A conflict", { when, nested: { at: [when] }, maxAmount: 7, status: 999, code: "replaced" }));
    const answer = await call(own, "GET", "/v1/trading/portfolio");
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ status: 409, code: "custom_conflict", type: "urn:chance:problem:custom-conflict", when: when.toISOString(), nested: { at: [when.toISOString()] }, maxAmount: 7 });
    await own.close();

    // The real thing: the fresh quote of a price limit arrives as a nested object with its own date.
    const real = await call(h, "POST", "/v1/trading/orders", { headers: withKey(newKey(h.core)), body: order({ maxAveragePriceMicro: 300_000 }) });
    expect(real.status).toBe(409);
    expect(real.body?.["quote"].quotedAt).toBe(h.core.clock.now().toISOString());
    expect(real.body).toMatchObject({ status: 409, code: "price_limit_exceeded", type: "urn:chance:problem:price-limit-exceeded" });
  });

  it("answers malformed JSON, a body that is too large and an unsupported media type with a 4xx problem", async () => {
    const headers = { authorization: `Bearer ${await h.sign(asTrader())}`, "idempotency-key": newKey(h.core) };
    const malformed = await h.publicApp.inject({ method: "POST", url: "/v1/trading/orders", headers: { ...headers, "content-type": "application/json" }, payload: "{not json" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["content-type"]).toContain("application/problem+json");
    const huge = await h.publicApp.inject({ method: "POST", url: "/v1/trading/orders", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(order({ filler: "x".repeat(20_000) })) });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ status: 413, code: "bad_request" });
    const text = await h.publicApp.inject({ method: "POST", url: "/v1/trading/orders", headers: { ...headers, "content-type": "application/xml" }, payload: "<buy/>" });
    expect(text.statusCode).toBe(415);
    const poisoned = await h.publicApp.inject({ method: "POST", url: "/v1/trading/orders", headers: { ...headers, "content-type": "application/json" }, payload: '{"__proto__": {"admin": true}, "marketId": "x"}' });
    expect(poisoned.statusCode).toBe(400);
  });

  it("never leaks an internal error: a failing use case answers 500 with a fixed text and is logged", async () => {
    const failing = await createHarness();
    failing.core.useCases.getPortfolio.execute = () => Promise.reject(new Error("database password is hunter2"));
    failing.core.useCases.listOpenMarkets.execute = () => Promise.reject(new Error("database password is hunter2"));
    const publicAnswer = await call(failing, "GET", "/v1/trading/portfolio");
    expect(publicAnswer.status).toBe(500);
    expect(publicAnswer.body).toMatchObject({ status: 500, code: "internal_error", detail: "The service failed to handle the request" });
    const internalAnswer = await callInternal(failing, "GET", "/v1/internal/markets?status=open", { client: "market-maker" });
    expect(internalAnswer.status).toBe(500);
    expect(JSON.stringify([publicAnswer.body, internalAnswer.body])).not.toContain("hunter2");
    expect(failing.logLines.join("")).toContain("Unhandled error");
    await failing.close();
  });
});

describe("correlation", () => {
  it("returns the correlation id the caller sent, on both ports", async () => {
    const publicAnswer = await call(h, "GET", "/v1/trading/portfolio", { headers: { "x-correlation-id": "trace-abc.123" } });
    expect(publicAnswer.headers["x-correlation-id"]).toBe("trace-abc.123");
    const internalAnswer = await callInternal(h, "GET", "/v1/internal/markets?status=open", { client: "market-maker", headers: { "x-correlation-id": "trace-int.1" } });
    expect(internalAnswer.headers["x-correlation-id"]).toBe("trace-int.1");
  });

  it("generates a UUID when none is sent or when the value is not acceptable, also on errors", async () => {
    const none = await call(h, "GET", "/v1/trading/portfolio");
    expect(none.headers["x-correlation-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const odd = await call(h, "GET", "/v1/trading/portfolio", { headers: { "x-correlation-id": "bad value with spaces" } });
    expect(odd.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const unauthorized = await call(h, "GET", "/v1/trading/portfolio", { token: null, headers: { "x-correlation-id": "on-a-401" } });
    expect(unauthorized.headers["x-correlation-id"]).toBe("on-a-401");
  });

  it("binds the correlation id, the user and the tenant to the request log", async () => {
    await call(h, "GET", "/v1/trading/portfolio", { token: asTrader("log-user"), headers: { "x-correlation-id": "log-corr-1" } });
    const lines = h.logLines.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line["correlationId"] === "log-corr-1" && line["userId"] === "log-user" && line["tenantId"] === TENANT_A)).toBe(true);
  });

  it("puts the caller's correlation id into the events and the ledger meta of an order and a debit", async () => {
    const withdrawal = "018f3c1e-7a00-7000-8000-0000000000d9";
    await callInternal(h, "POST", "/v1/internal/debits", {
      client: "payments",
      headers: { "x-correlation-id": "trace-debit-1" },
      body: { withdrawalId: withdrawal, tenantId: TENANT_A, userId: TRADER, amount: 5 },
    });
    const ledger = h.core.store.snapshot().tenantData[TENANT_A]?.ledger ?? [];
    const debited = ledger.find((event) => event.type === "WithdrawalDebited");
    expect(debited?.meta).toMatchObject({ correlationId: "trace-debit-1" });
    expect(debited?.meta.causationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("health", () => {
  it("answers the three probes without a token, as the contract says", async () => {
    for (const [probe, path] of [
      ["startup", "/health/startup"],
      ["ready", "/health/ready"],
      ["live", "/health/live"],
    ] as const) {
      const answer = await call(h, "GET", `/health/${probe}`, { token: null });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ status: "up" });
      expectPublicContract(path, "GET", answer);
    }
  });

  it("is not ready when the database does not answer, and still alive", async () => {
    const own = await createHarness();
    own.core.store.ping = () => Promise.reject(new Error("the database is down"));
    const ready = await call(own, "GET", "/health/ready", { token: null });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: "not_ready" });
    expectPublicContract("/health/ready", "GET", ready);
    expect((await call(own, "GET", "/health/live", { token: null })).status).toBe(200);
    await own.close();
  });

  it("turns not ready as soon as the process drains (SIGTERM), while the other probes and the API keep answering", async () => {
    const own = await createHarness();
    own.setDraining(true);
    const ready = await call(own, "GET", "/health/ready", { token: null });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: "shutting_down" });
    expectPublicContract("/health/ready", "GET", ready);
    expect((await call(own, "GET", "/health/live", { token: null })).status).toBe(200);
    expect((await call(own, "GET", "/health/startup", { token: null })).status).toBe(200);
    expect((await call(own, "GET", "/v1/trading/portfolio")).status).toBe(200);
    await own.close();
  });

  it("does not ask the database while draining", async () => {
    const own = await createHarness();
    let asked = 0;
    own.core.store.ping = () => {
      asked += 1;
      return Promise.resolve();
    };
    own.setDraining(true);
    await call(own, "GET", "/health/ready", { token: null });
    expect(asked).toBe(0);
    await own.close();
  });
});
