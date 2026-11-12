import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { MARKET_1, TENANT_A, TENANT_B, TRADER } from "../support/fakes.js";
import { asPlatformAdmin, asTrader, call, callInternal, createHarness, grant, newKey, openMarket, withKey } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

// The metrics wired into both real applications the way src/main.ts wires them: one registry, the tenant label is the
// tenant of the token that the service verified, and the internal port is labelled with route templates too. The
// convention itself is tested in tests/adapters/metrics.test.ts.

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
  await openMarket(h.core);
  await grant(h.core, TRADER, 500);
});
afterAll(async () => {
  await h.close();
});

async function counter(labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the public application", () => {
  it("counts a request under the template of its route and the tenant of its token", async () => {
    const answer = await call(h, "GET", "/v1/trading/portfolio", { token: asTrader(TRADER, TENANT_A) });
    expect(answer.status).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/trading/portfolio", status_code: "200", tenant: TENANT_A })).toBe(1);
  });

  it("counts an order and a refused call under the tenant of the token, never a market or user id", async () => {
    const created = await call(h, "POST", "/v1/trading/orders", { headers: withKey(newKey(h.core)), body: { marketId: MARKET_1, side: "YES", amount: 10 } });
    expect(created.status).toBe(201);
    const refused = await call(h, "GET", "/v1/trading/portfolio", { token: asPlatformAdmin() });
    expect(refused.status).toBe(403);
    expect(await counter({ method: "POST", route: "/v1/trading/orders", status_code: "201", tenant: TENANT_A })).toBe(1);
    expect(await counter({ method: "GET", route: "/v1/trading/portfolio", status_code: "403", tenant: "none" })).toBe(1);
    const text = await metrics.registry.metrics();
    for (const secret of [MARKET_1, TRADER, TENANT_B]) expect(text, secret).not.toContain(secret);
  });

  it('counts a request without a token as 401 for the tenant "none"', async () => {
    const answer = await call(h, "GET", "/v1/trading/portfolio", { token: null });
    expect(answer.status).toBe(401);
    expect(await counter({ method: "GET", route: "/v1/trading/portfolio", status_code: "401", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the public port: the 404 is counted as "unmatched"', async () => {
    const response = await h.publicApp.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBeGreaterThanOrEqual(1);
  });
});

describe("the metrics of the internal application", () => {
  it('labels a service call with its route template and the tenant "none": a service token names no tenant', async () => {
    const answer = await callInternal(h, "GET", "/v1/internal/markets?status=open", { client: "market-maker" });
    expect(answer.status).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/internal/markets", status_code: "200", tenant: "none" })).toBe(1);
  });

  it("uses the template of a route with a path parameter, never the market id", async () => {
    const answer = await callInternal(h, "GET", `/v1/internal/markets/${MARKET_1}/bot-book`, { client: "market-maker" });
    expect(answer.status).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/internal/markets/:marketId/bot-book", status_code: "200", tenant: "none" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(MARKET_1);
  });

  it("counts a call without a token as 401 and an unknown path as unmatched", async () => {
    expect((await callInternal(h, "GET", "/v1/internal/markets?status=open", { token: null })).status).toBe(401);
    expect(await counter({ method: "GET", route: "/v1/internal/markets", status_code: "401", tenant: "none" })).toBe(1);
    const before = await counter({ route: "unmatched", status_code: "404", tenant: "none" });
    const response = await h.internalApp.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ route: "unmatched", status_code: "404", tenant: "none" })).toBe(before + 1);
  });
});

describe("the harness without metrics", () => {
  it("answers the same: the hook is optional", async () => {
    const plain = await createHarness();
    expect((await call(plain, "GET", "/v1/trading/portfolio", { token: null })).status).toBe(401);
    await plain.close();
  });
});
