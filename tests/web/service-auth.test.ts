import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceClient } from "../../src/usecases/ports.js";
import { MARKET_1, TENANT_A, TRADER } from "../support/fakes.js";
import { AUDIENCE } from "../support/tokens.js";
import { asPlatformAdmin, asTenantAdmin, asTrader, call, callInternal, createHarness, expectInternalContract, fundingBody, openMarket, withKey } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await openMarket(h.core);
});
afterAll(async () => {
  await h.close();
});

const WITHDRAWAL = "018f3c1e-7a00-7000-8000-0000000000d1";

/** Every internal endpoint, the client it admits and a request that is valid where one is needed. */
const endpoints = () =>
  [
    ["POST", "/v1/internal/market-funding", "/v1/internal/market-funding", fundingBody(MARKET_1, 10), withKey(MARKET_1), "markets"],
    ["POST", "/v1/internal/debits", "/v1/internal/debits", { withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: TRADER, amount: 10 }, {}, "payments"],
    ["GET", "/v1/internal/markets?status=open", "/v1/internal/markets", undefined, {}, "market-maker"],
    ["GET", `/v1/internal/markets/${MARKET_1}/bot-book`, "/v1/internal/markets/{marketId}/bot-book", undefined, {}, "market-maker"],
    ["PUT", `/v1/internal/markets/${MARKET_1}/bot-orders`, "/v1/internal/markets/{marketId}/bot-orders", { basedOnSequence: 0, offers: [] }, {}, "market-maker"],
  ] as const;
const CLIENTS: ServiceClient[] = ["markets", "payments", "market-maker"];

describe("authentication (401)", () => {
  it("answers 401 without a token, with a malformed header and with a bad token, on every endpoint", async () => {
    for (const [method, url, path, body, headers] of endpoints()) {
      const variants: Array<Record<string, string>> = [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer not.a.jwt" }];
      for (const extra of variants) {
        const answer = await callInternal(h, method, url, { token: null, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url}`).toBe(401);
        expect(answer.headers["content-type"]).toContain("application/problem+json");
        expect(answer.headers["www-authenticate"]).toContain("Bearer");
        expect(answer.body).toMatchObject({ status: 401, code: "unauthorized" });
        expectInternalContract(path, method, answer);
      }
    }
  });

  it("answers 401 for a token with the wrong issuer, audience or signature, an expired one, one without exp, and an unsigned one", async () => {
    const sub = "service-account-markets";
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x","azp":"markets"}').toString("base64url")}.`;
    const bad = [
      await h.keys.sign({ sub, azp: "markets", audience: AUDIENCE, issuer: "http://localhost:8081/realms/other" }),
      await h.keys.sign({ sub, azp: "markets", audience: "someone-else" }),
      await h.keys.signWithOtherKey({ sub, azp: "markets", audience: AUDIENCE }),
      await h.keys.sign({ sub, azp: "markets", audience: AUDIENCE, expiresIn: -60 }),
      await h.keys.sign({ sub, azp: "markets", audience: AUDIENCE, noExpiry: true }),
      unsigned,
    ];
    for (const token of bad) {
      const answer = await h.internalApp.inject({ method: "GET", url: "/v1/internal/markets?status=open", headers: { authorization: `Bearer ${token}` } });
      expect(answer.statusCode).toBe(401);
    }
  });

  it("does not write the token into the logs", async () => {
    const token = await h.signService("market-maker");
    await h.internalApp.inject({ method: "GET", url: "/v1/internal/markets?status=open", headers: { authorization: `Bearer ${token}` } });
    expect(h.logLines.join("")).not.toContain(token);
  });
});

describe("the identity provider's signing keys (503)", () => {
  it("answers 503 with Retry-After, not 401, when the keys cannot be fetched, and recovers when they can", async () => {
    h.failKeys(new errors.JWKSTimeout());
    try {
      for (const [method, url, path, body, headers, client] of endpoints()) {
        const answer = await callInternal(h, method, url, { client, headers, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url}`).toBe(503);
        expect(answer.headers["retry-after"]).toBe("5");
        expect(answer.body).toMatchObject({ code: "identity_provider_unavailable" });
        expectInternalContract(path, method, answer);
      }
    } finally {
      h.failKeys(null);
    }
    expect((await callInternal(h, "GET", "/v1/internal/markets?status=open", { client: "market-maker" })).status).toBe(200);
  });
});

describe("one client per endpoint (403)", () => {
  it("lets each endpoint admit exactly its own client", async () => {
    for (const [method, url, path, body, headers, admitted] of endpoints()) {
      for (const client of CLIENTS) {
        const answer = await callInternal(h, method, url, { client, headers, ...(body === undefined ? {} : { body }) });
        if (client === admitted) {
          expect([401, 403], `${method} ${url} as ${client}`).not.toContain(answer.status);
        } else {
          expect(answer.status, `${method} ${url} as ${client}`).toBe(403);
          expect(answer.body).toMatchObject({ status: 403, code: "forbidden", type: "urn:chance:problem:forbidden" });
          expectInternalContract(path, method, answer);
        }
      }
    }
  });

  it("answers 403 to a user's token (trader, tenant admin, platform admin) on every endpoint: no client matches", async () => {
    for (const token of [asTrader(), asTenantAdmin(), asPlatformAdmin()]) {
      for (const [method, url, , body, headers] of endpoints()) {
        const answer = await callInternal(h, method, url, { token, headers, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url} ${JSON.stringify(token)}`).toBe(403);
      }
    }
  });

  it("answers 403 to a valid token of an unknown client, one with no client claim, and one with an empty client claim", async () => {
    const tokens = [
      { sub: "svc", azp: "other-service", audience: AUDIENCE },
      { sub: "svc", audience: AUDIENCE },
      { sub: "svc", azp: "", audience: AUDIENCE },
    ];
    for (const token of tokens) {
      for (const [method, url, , body, headers] of endpoints()) {
        const answer = await callInternal(h, method, url, { token, headers, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url} ${JSON.stringify(token)}`).toBe(403);
      }
    }
  });

  it("answers 403 before it validates the path, the query or the body", async () => {
    const wrong = { client: "payments" } as const;
    expect((await callInternal(h, "POST", "/v1/internal/market-funding", { ...wrong, body: { nonsense: true } })).status).toBe(403);
    expect((await callInternal(h, "GET", "/v1/internal/markets?status=closed&nonsense=1", wrong)).status).toBe(403);
    expect((await callInternal(h, "GET", "/v1/internal/markets/not-a-uuid/bot-book", wrong)).status).toBe(403);
    expect((await callInternal(h, "PUT", `/v1/internal/markets/${MARKET_1}/bot-orders`, { ...wrong, body: { offers: "x" } })).status).toBe(403);
  });
});

describe("the audience of the internal port", () => {
  it("is the public audience by default, and its own when INTERNAL_AUTH_AUDIENCE differs: the two kinds of token never cross", async () => {
    const own = await createHarness({ internalAudience: "chance-internal" });
    try {
      // A user's token has the public audience: the internal port refuses it before it looks at roles or clients.
      expect((await callInternal(own, "GET", "/v1/internal/markets?status=open", { token: asTrader() })).status).toBe(401);
      // A service token has the internal audience: the public port refuses it.
      const serviceToken = await own.signService("market-maker");
      const publicAnswer = await own.publicApp.inject({ method: "GET", url: "/v1/trading/portfolio", headers: { authorization: `Bearer ${serviceToken}` } });
      expect(publicAnswer.statusCode).toBe(401);
      expect((await callInternal(own, "GET", "/v1/internal/markets?status=open", { client: "market-maker" })).status).toBe(200);
    } finally {
      await own.close();
    }
  });
});

describe("what each port serves", () => {
  it("keeps the two applications apart: no health probes and no trading routes on the internal port, no internal routes on the public one", async () => {
    const live = await h.internalApp.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(404);
    const trading = await callInternal(h, "GET", "/v1/trading/portfolio", { client: "market-maker" });
    expect(trading.status).toBe(404);
    const internalOnPublic = await call(h, "GET", "/v1/internal/markets?status=open");
    expect(internalOnPublic.status).toBe(404);
    expect(h.internalApp.registeredRoutes).toHaveLength(5);
  });

  it("answers every internal answer with Cache-Control private, no-store and a correlation id", async () => {
    const answers = [
      await callInternal(h, "GET", "/v1/internal/markets?status=open", { client: "market-maker", headers: { "x-correlation-id": "trace-int-1" } }),
      await callInternal(h, "GET", "/v1/internal/markets?status=closed", { client: "market-maker" }),
      await callInternal(h, "GET", "/v1/internal/markets?status=open", { token: null }),
      await callInternal(h, "GET", "/v1/internal/markets?status=open", { client: "markets" }),
      await callInternal(h, "GET", "/v1/internal/nothing-here", { client: "markets" }),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 400, 401, 403, 404]);
    for (const answer of answers) expect(answer.headers["cache-control"], `status ${answer.status}`).toBe("private, no-store");
    expect(answers[0]?.headers["x-correlation-id"]).toBe("trace-int-1");
  });
});
