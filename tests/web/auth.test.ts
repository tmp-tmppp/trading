import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_1, TENANT_A, TENANT_B } from "../support/fakes.js";
import { asPlatformAdmin, asTenantAdmin, asTrader, call, createHarness, expectPublicContract, newKey, withKey } from "../support/harness.js";
import type { Harness } from "../support/harness.js";
import { TENANT_ADMIN_GROUP, TRADER_GROUP } from "../support/tokens.js";
import type { TokenOptions } from "../support/tokens.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/** Every public endpoint with a request that is valid where one is needed. */
const endpoints = () =>
  [
    ["GET", `/v1/trading/quote?marketId=${MARKET_1}&side=YES&amount=10`, "/v1/trading/quote", undefined, {}],
    ["POST", "/v1/trading/orders", "/v1/trading/orders", { marketId: MARKET_1, side: "YES", amount: 10 }, withKey(newKey(h.core))],
    ["GET", "/v1/trading/portfolio", "/v1/trading/portfolio", undefined, {}],
  ] as const;

describe("authentication (401)", () => {
  it("answers 401 without a token, with a malformed header and with a bad token, on every endpoint", async () => {
    for (const [method, url, path, body, headers] of endpoints()) {
      const variants: Array<Record<string, string>> = [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer not.a.jwt" }];
      for (const extra of variants) {
        const answer = await call(h, method, url, { token: null, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url}`).toBe(401);
        expect(answer.headers["content-type"]).toContain("application/problem+json");
        expect(answer.headers["www-authenticate"]).toContain("Bearer");
        expect(answer.body).toMatchObject({ status: 401, code: "unauthorized", type: "urn:chance:problem:unauthorized" });
        expectPublicContract(path, method, answer);
      }
    }
  });

  it("answers 401 for a token with the wrong issuer, audience or signature, or an expired one", async () => {
    const bad = [
      await h.keys.sign({ ...asTrader(), issuer: "http://localhost:8081/realms/other" }),
      await h.keys.sign({ ...asTrader(), audience: "someone-else" }),
      await h.keys.signWithOtherKey(asTrader()),
      await h.keys.sign({ ...asTrader(), expiresIn: -60 }),
    ];
    for (const token of bad) {
      const answer = await h.publicApp.inject({ method: "GET", url: "/v1/trading/portfolio", headers: { authorization: `Bearer ${token}` } });
      expect(answer.statusCode).toBe(401);
    }
  });

  it("answers 401 for a correctly signed token that has no exp claim (it would never expire)", async () => {
    const token = await h.keys.sign({ ...asTrader(), noExpiry: true });
    const answer = await h.publicApp.inject({ method: "GET", url: "/v1/trading/portfolio", headers: { authorization: `Bearer ${token}` } });
    expect(answer.statusCode).toBe(401);
    expect(answer.headers["www-authenticate"]).toContain("Bearer");
    expect(answer.json()).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("answers 401 for an unsigned token", async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.`;
    const answer = await h.publicApp.inject({ method: "GET", url: "/v1/trading/portfolio", headers: { authorization: `Bearer ${unsigned}` } });
    expect(answer.statusCode).toBe(401);
  });

  it("answers 401 for a token that names more than one organization, whatever the groups in them", async () => {
    const bothTraders = { sub: "multi-1", memberships: { [TENANT_A]: [TRADER_GROUP], [TENANT_B]: [TRADER_GROUP] } };
    const oneWithoutGroup = { sub: "multi-2", memberships: { [TENANT_A]: [TRADER_GROUP], [TENANT_B]: [] } };
    const oldShape = { sub: "multi-3", roles: ["trader"], organization: [TENANT_A, TENANT_B] };
    for (const token of [bothTraders, oneWithoutGroup, oldShape]) {
      for (const [method, url, , body, headers] of endpoints()) {
        const answer = await call(h, method, url, { token, headers, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url} ${JSON.stringify(token)}`).toBe(401);
        expect(answer.headers["www-authenticate"]).toContain("invalid_token");
      }
    }
  });

  it("does not write the token into the logs", async () => {
    const token = await h.sign(asTrader("log-trader"));
    await h.publicApp.inject({ method: "GET", url: "/v1/trading/portfolio", headers: { authorization: `Bearer ${token}` } });
    expect(h.logLines.join("")).not.toContain(token);
  });
});

describe("the identity provider's signing keys (503)", () => {
  it("answers 503 with Retry-After, not 401, when the keys cannot be fetched, and recovers when they can", async () => {
    h.failKeys(new Error("connect ECONNREFUSED"));
    try {
      for (const [method, url, path, body, headers] of endpoints()) {
        const answer = await call(h, method, url, { headers, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url}`).toBe(503);
        expect(answer.headers["retry-after"]).toBe("5");
        expect(answer.body).toMatchObject({ code: "identity_provider_unavailable", status: 503 });
        expectPublicContract(path, method, answer);
      }
    } finally {
      h.failKeys(null);
    }
    expect((await call(h, "GET", "/v1/trading/portfolio")).status).toBe(200);
  });

  it("tells a key problem from a token problem: a timeout or a broken key set is 503, a key that does not match is 401", async () => {
    try {
      for (const failure of [new errors.JWKSTimeout(), new errors.JWKSInvalid("the key set is not valid"), new TypeError("fetch failed")]) {
        h.failKeys(failure);
        expect((await call(h, "GET", "/v1/trading/portfolio")).status, failure.name).toBe(503);
      }
      h.failKeys(new errors.JWKSNoMatchingKey());
      expect((await call(h, "GET", "/v1/trading/portfolio")).status).toBe(401);
    } finally {
      h.failKeys(null);
    }
  });
});

/** Every endpoint answers 403 to the token. */
async function expectForbiddenEverywhere(token: TokenOptions): Promise<void> {
  for (const [method, url, path, body, headers] of endpoints()) {
    const answer = await call(h, method, url, { token, headers, ...(body === undefined ? {} : { body }) });
    expect(answer.status, `${method} ${url} ${JSON.stringify(token)}`).toBe(403);
    expect(answer.body).toMatchObject({ status: 403, code: "forbidden", type: "urn:chance:problem:forbidden" });
    expectPublicContract(path, method, answer);
  }
}

describe("roles and tenants (403)", () => {
  it("answers 403 to a platform admin on every endpoint, also with a tenant and a tenant group in the token", async () => {
    await expectForbiddenEverywhere(asPlatformAdmin());
    await expectForbiddenEverywhere({ sub: "p-2", roles: ["platform-admin"], memberships: { [TENANT_A]: [TRADER_GROUP] } });
    await expectForbiddenEverywhere({ sub: "p-3", roles: ["platform-admin"], memberships: { [TENANT_A]: [TENANT_ADMIN_GROUP] } });
  });

  it("answers 403 to a token without a tenant or with a tenant that is not a UUID", async () => {
    const tokens: TokenOptions[] = [
      { sub: "u" },
      { sub: "u", organization: null },
      { sub: "u", memberships: {} },
      { sub: "u", memberships: { acme: [TENANT_ADMIN_GROUP] } },
      { sub: "u", memberships: { acme: [TRADER_GROUP] } },
    ];
    for (const token of tokens) await expectForbiddenEverywhere(token);
  });

  it("answers 403 before it validates the query or the body", async () => {
    expect((await call(h, "GET", "/v1/trading/quote?nonsense=1", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "GET", "/v1/trading/portfolio?limit=0", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "POST", "/v1/trading/orders", { token: asTenantAdmin(), body: { nonsense: true } })).status).toBe(403);
    expect((await call(h, "POST", "/v1/trading/orders", { token: asPlatformAdmin(), body: { marketId: "not-a-uuid", side: "MAYBE", amount: "ten" } })).status).toBe(403);
  });

  it("lets a tenant admin (the group /tenant-admin) quote and read the portfolio but never order", async () => {
    const admin = asTenantAdmin();
    expect((await call(h, "GET", `/v1/trading/quote?marketId=${MARKET_1}&side=YES&amount=10`, { token: admin })).status).not.toBe(403);
    const portfolio = await call(h, "GET", "/v1/trading/portfolio", { token: admin });
    expect(portfolio.status).toBe(200);
    // A tenant admin's portfolio lists the markets they funded; a trader's has no such list.
    expect(portfolio.body?.["fundedMarkets"]).toEqual([]);

    const order = await call(h, "POST", "/v1/trading/orders", { token: admin, headers: withKey(newKey(h.core)), body: { marketId: MARKET_1, side: "YES", amount: 10 } });
    expect(order.status).toBe(403);
    expect(order.body).toMatchObject({ code: "forbidden", detail: "Only traders place orders" });
  });

  it("lets a trader (the group /trader) quote, read the portfolio and order", async () => {
    const trader = asTrader();
    expect((await call(h, "GET", `/v1/trading/quote?marketId=${MARKET_1}&side=YES&amount=10`, { token: trader })).status).not.toBe(403);
    const portfolio = await call(h, "GET", "/v1/trading/portfolio", { token: trader });
    expect(portfolio.status).toBe(200);
    expect(portfolio.body?.["fundedMarkets"]).toBeNull();
    const order = await call(h, "POST", "/v1/trading/orders", { token: trader, headers: withKey(newKey(h.core)), body: { marketId: MARKET_1, side: "YES", amount: 10 } });
    expect(order.status).not.toBe(403);
  });

  it("answers 403 to a token whose organization has both groups, no group or a group that is not a tenant role", async () => {
    const groups: Array<[string, string[]]> = [
      ["both groups", [TRADER_GROUP, TENANT_ADMIN_GROUP]],
      ["both groups, other order", [TENANT_ADMIN_GROUP, TRADER_GROUP]],
      ["no group", []],
      ["an unknown group", ["/viewer"]],
      ["a nested group", ["/trader/sub"]],
      ["a path without the slash", ["trader"]],
      ["another case", ["/Trader"]],
      ["an empty group", [""]],
      ["a valid group and an unknown one", [TRADER_GROUP, "/viewer"]],
      ["the same group twice", [TRADER_GROUP, TRADER_GROUP]],
    ];
    for (const [name, list] of groups) {
      await expectForbiddenEverywhere({ sub: `groups-${name}`, memberships: { [TENANT_A]: list } });
    }
    const answer = await call(h, "GET", "/v1/trading/portfolio", { token: { sub: "both-1", memberships: { [TENANT_A]: [TRADER_GROUP, TENANT_ADMIN_GROUP] } } });
    expect(answer.body).toMatchObject({ code: "forbidden", detail: expect.stringContaining("exactly one group") });
  });

  it("answers 403 when the organization claim cannot carry a group: no object, no entry, no groups array, a group that is no text", async () => {
    const claims: Array<string[] | Record<string, unknown> | string> = [
      [TENANT_A],
      TENANT_A,
      { [TENANT_A]: {} },
      { [TENANT_A]: { id: "1" } },
      { [TENANT_A]: "/trader" },
      { [TENANT_A]: null },
      { [TENANT_A]: { groups: "/trader" } },
      { [TENANT_A]: { groups: { 0: "/trader" } } },
      { [TENANT_A]: { groups: [42] } },
      { [TENANT_A]: { groups: [["/trader"]] } },
      { [TENANT_A]: { groups: [{ path: "/trader" }] } },
      { [TENANT_A]: { group: ["/trader"], role: "trader", roles: ["trader"] } },
    ];
    for (const organization of claims) await expectForbiddenEverywhere({ sub: "u", organization });
  });

  it("refuses the old shape: a realm role trader or tenant-admin, with no group of the organization, is 403", async () => {
    const tokens: TokenOptions[] = [
      { sub: "old-1", roles: ["trader"], organization: [TENANT_A] },
      { sub: "old-2", roles: ["tenant-admin"], organization: [TENANT_A] },
      { sub: "old-3", roles: ["trader", "tenant-admin"], organization: [TENANT_A] },
      { sub: "old-4", roles: ["trader"], organization: { [TENANT_A]: { id: "1" } } },
      { sub: "old-5", roles: ["tenant-admin"], memberships: { [TENANT_A]: [] } },
      { sub: "old-6", roles: ["trader"], organization: TENANT_A },
      { sub: "old-7", roles: ["trader"] },
    ];
    for (const token of tokens) await expectForbiddenEverywhere(token);
  });

  it("takes the role from the group alone: a realm role neither adds a role nor changes the one the group gives", async () => {
    const body = { marketId: MARKET_1, side: "YES", amount: 10 };
    // A realm role tenant-admin beside the group /trader: still a trader, who may order.
    const trader = await call(h, "POST", "/v1/trading/orders", { token: { sub: "mix-1", roles: ["tenant-admin"], memberships: { [TENANT_A]: [TRADER_GROUP] } }, headers: withKey(newKey(h.core)), body });
    expect(trader.status).not.toBe(403);
    // A realm role trader beside the group /tenant-admin: still a tenant admin, who may not.
    const admin = await call(h, "POST", "/v1/trading/orders", { token: { sub: "mix-2", roles: ["trader"], memberships: { [TENANT_A]: [TENANT_ADMIN_GROUP] } }, headers: withKey(newKey(h.core)), body });
    expect(admin.status).toBe(403);
    expect(admin.body).toMatchObject({ detail: "Only traders place orders" });
    // Other realm roles beside the group do no harm.
    expect((await call(h, "GET", "/v1/trading/portfolio", { token: { sub: "mix-3", roles: ["offline_access", "uma_authorization"], memberships: { [TENANT_A]: [TRADER_GROUP] } } })).status).toBe(200);
  });

  it("takes the tenant from the token, never from the request", async () => {
    const asA = await call(h, "GET", "/v1/trading/portfolio", { token: asTrader("owner-1"), headers: { "x-tenant-id": TENANT_B } });
    expect(asA.status).toBe(200);
    expect((await call(h, "GET", `/v1/trading/portfolio?tenantId=${TENANT_B}`)).status).toBe(400);
    const order = await call(h, "POST", "/v1/trading/orders", { headers: withKey(newKey(h.core)), body: { marketId: MARKET_1, side: "YES", amount: 10, tenantId: TENANT_B } });
    expect(order.status).toBe(400);
    expect(order.body?.["errors"]).toEqual([expect.objectContaining({ field: "tenantId" })]);
  });
});
