import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrentUpdate } from "../../src/usecases/errors.js";
import { CREATOR, MARKET_1, MARKET_2, TENANT_A, TENANT_B, TRADER, serviceCaller } from "../support/fakes.js";
import { CREDIT, asTenantAdmin, asTrader, call, createHarness, expectPublicContract, grant, marketClosed, newKey, openMarket, withKey } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

const MARKET_3 = "018f3c1e-7a00-7000-8000-000000000103";
const UNKNOWN_MARKET = "018f3c1e-7a00-7000-8000-0000000000f1";
/** A tenant that never had a TenantCreated. */
const TENANT_C = "018f3c1e-7a00-7000-8000-0000000000cc";

/** A market whose funding was taken but whose MarketOpened has not been processed: status `funded`. */
async function fundOnly(h: Harness, marketId: string): Promise<void> {
  await grant(h.core, CREATOR, 100);
  await h.core.useCases.fundMarket.execute({ caller: serviceCaller("markets"), idempotencyKey: marketId, marketId, tenantId: TENANT_A, creatorId: CREATOR, amount: 100 });
}

const quoteUrl = (marketId: string, side = "YES", amount: number | string = 10) => `/v1/trading/quote?marketId=${marketId}&side=${side}&amount=${amount}`;
const order = (marketId: string, extra: Record<string, unknown> = {}) => ({ marketId, side: "YES", amount: 10, ...extra });

describe("GET /v1/trading/quote", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await openMarket(h.core);
    await fundOnly(h, MARKET_2);
    await openMarket(h.core, { marketId: MARKET_3, creatorId: "admin-3" });
    await h.core.useCases.recordMarketEvent.execute(marketClosed(h.core, { marketId: MARKET_3 }));
  });
  afterAll(async () => {
    await h.close();
  });

  it("prices the buy from the cheapest offers up, spends exactly the amount and changes nothing", async () => {
    const answer = await call(h, "GET", quoteUrl(MARKET_1));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      marketId: MARKET_1,
      side: "YES",
      amount: 10,
      costMicro: 10 * CREDIT,
      sharesMicro: 25_000_000,
      averagePriceMicro: 400_000,
      worstPriceMicro: 400_000,
      fills: [{ priceMicro: 400_000, sharesMicro: 25_000_000, costMicro: 10 * CREDIT }],
      tradeSequence: 0,
    });
    expect(new Date(answer.body?.["quotedAt"]).toISOString()).toBe(h.core.clock.now().toISOString());
    expectPublicContract("/v1/trading/quote", "GET", answer);

    const snapshot = JSON.stringify(h.core.store.snapshot().tenantData);
    await call(h, "GET", quoteUrl(MARKET_1, "NO", 50));
    expect(JSON.stringify(h.core.store.snapshot().tenantData)).toBe(snapshot);
  });

  it("walks up the book when the amount is larger than the cheapest offers, on either side", async () => {
    const yes = await call(h, "GET", quoteUrl(MARKET_1, "YES", 60));
    expect(yes.body?.["fills"]).toHaveLength(2);
    expect(yes.body?.["worstPriceMicro"]).toBe(450_000);
    const no = await call(h, "GET", quoteUrl(MARKET_1, "NO", 10));
    // 10 credits buy 16 666 666 microshares at 0.60: the cost rounds up, so the average is 600 001 (rounding favours the bot).
    expect(no.body).toMatchObject({ side: "NO", worstPriceMicro: 600_000, sharesMicro: 16_666_666, costMicro: 10 * CREDIT, averagePriceMicro: 600_001 });
  });

  it("is open to a tenant admin and takes the market id in any letter case", async () => {
    const admin = await call(h, "GET", quoteUrl(MARKET_1), { token: asTenantAdmin() });
    expect(admin.status).toBe(200);
    const upper = await call(h, "GET", quoteUrl(MARKET_1.toUpperCase()));
    expect(upper.status).toBe(200);
    expect(upper.body?.["marketId"]).toBe(MARKET_1);
  });

  it("answers 400 with the fields at fault for an invalid query", async () => {
    const cases: Array<[string, string]> = [
      [`/v1/trading/quote?marketId=${MARKET_1}&side=YES`, "amount"],
      [`/v1/trading/quote?side=YES&amount=10`, "marketId"],
      [quoteUrl(MARKET_1, "yes"), "side"],
      [quoteUrl(MARKET_1, "MAYBE"), "side"],
      [quoteUrl(MARKET_1, "YES", 0), "amount"],
      [quoteUrl(MARKET_1, "YES", 1_000_001), "amount"],
      [quoteUrl(MARKET_1, "YES", "2.5"), "amount"],
      [quoteUrl(MARKET_1, "YES", "ten"), "amount"],
      [quoteUrl("not-a-uuid"), "marketId"],
      [`${quoteUrl(MARKET_1)}&nonsense=1`, "nonsense"],
      [`${quoteUrl(MARKET_1)}&tenantId=${TENANT_B}`, "tenantId"],
    ];
    for (const [url, field] of cases) {
      const answer = await call(h, "GET", url);
      expect(answer.status, url).toBe(400);
      expect(answer.body, url).toMatchObject({ code: "validation_failed", type: "urn:chance:problem:validation-failed" });
      expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), url).toContain(field);
      expectPublicContract("/v1/trading/quote", "GET", answer);
    }
  });

  it("answers 404 for a market that does not exist, and for another tenant's market exactly like it", async () => {
    const unknown = await call(h, "GET", quoteUrl(UNKNOWN_MARKET));
    const other = await call(h, "GET", quoteUrl(MARKET_1), { token: asTrader("t-b", TENANT_B) });
    expect(unknown.status).toBe(404);
    expect(other.status).toBe(404);
    expect({ ...other.body, instance: undefined }).toEqual({ ...unknown.body, instance: undefined });
    expectPublicContract("/v1/trading/quote", "GET", other);
  });

  it("answers 409 market_not_open for a market that is only funded, and for a closed one", async () => {
    for (const marketId of [MARKET_2, MARKET_3]) {
      const answer = await call(h, "GET", quoteUrl(marketId));
      expect(answer.status, marketId).toBe(409);
      expect(answer.body).toMatchObject({ code: "market_not_open", type: "urn:chance:problem:market-not-open" });
      expectPublicContract("/v1/trading/quote", "GET", answer);
    }
  });

  it("answers 409 insufficient_liquidity with the largest amount the offers can absorb", async () => {
    const answer = await call(h, "GET", quoteUrl(MARKET_1, "YES", 131));
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "insufficient_liquidity", maxAmount: 130 });
    expectPublicContract("/v1/trading/quote", "GET", answer);
    expect((await call(h, "GET", quoteUrl(MARKET_1, "YES", 130))).status).toBe(200);
  });

  it("answers 503 with Retry-After while the caller's tenant is not set up", async () => {
    const answer = await call(h, "GET", quoteUrl(MARKET_1), { token: asTrader("t-c", TENANT_C) });
    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("5");
    expect(answer.body).toMatchObject({ code: "tenant_not_ready" });
    expectPublicContract("/v1/trading/quote", "GET", answer);
  });
});

describe("POST /v1/trading/orders", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await openMarket(h.core);
    await fundOnly(h, MARKET_2);
    await grant(h.core, TRADER, 500);
  });
  afterAll(async () => {
    await h.close();
  });

  async function place(body: unknown, key: string | null = newKey(h.core), token = asTrader()) {
    return call(h, "POST", "/v1/trading/orders", { token, body, ...(key === null ? {} : { headers: withKey(key) }) });
  }

  it("buys for exactly the amount: 201 with the fills, the new balance, the position and the trade sequence (DM-17)", async () => {
    const answer = await place(order(MARKET_1), newKey(h.core), asTrader(TRADER));
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      marketId: MARKET_1,
      side: "YES",
      amount: 10,
      costMicro: 10 * CREDIT,
      sharesMicro: 25_000_000,
      averagePriceMicro: 400_000,
      tradeSequence: 1,
      balanceMicro: 490 * CREDIT,
      position: { marketId: MARKET_1, yesMicro: 25_000_000, noMicro: 0 },
    });
    expect(answer.body?.["tradeId"]).toMatch(/^[0-9a-f-]{36}$/);
    expectPublicContract("/v1/trading/orders", "POST", answer);
  });

  it("answers a repeat of a completed key with 200 and the same order, and buys nothing again (REL-03)", async () => {
    const key = newKey(h.core);
    const first = await place(order(MARKET_1, { amount: 20 }), key);
    const again = await place(order(MARKET_1, { amount: 20 }), key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expectPublicContract("/v1/trading/orders", "POST", again);
    const portfolio = await call(h, "GET", "/v1/trading/portfolio");
    expect(portfolio.body?.["recentTrades"].filter((trade: { tradeId: string }) => trade.tradeId === first.body?.["tradeId"])).toHaveLength(1);
  });

  it("answers a retry of an executed order with 200 even after orders were paused or the maximum was lowered", async () => {
    const key = newKey(h.core);
    const first = await place(order(MARKET_1, { amount: 5 }), key);
    expect(first.status).toBe(201);
    const before = { ...h.core.rules.rules };
    try {
      h.core.rules.rules.ordersEnabled = false;
      const paused = await place(order(MARKET_1, { amount: 5 }), key);
      expect(paused.status).toBe(200);
      expect(paused.body).toEqual(first.body);

      h.core.rules.rules.ordersEnabled = true;
      h.core.rules.rules.orderAmountMax = 1;
      const lowered = await place(order(MARKET_1, { amount: 5 }), key);
      expect(lowered.status).toBe(200);
      expect(lowered.body).toEqual(first.body);
    } finally {
      h.core.rules.rules = before;
    }
  });

  it("answers 422 when a key is used again with another body", async () => {
    const key = newKey(h.core);
    expect((await place(order(MARKET_1), key)).status).toBe(201);
    for (const other of [order(MARKET_1, { amount: 11 }), order(MARKET_1, { side: "NO" }), order(MARKET_1, { maxAveragePriceMicro: 500_000 })]) {
      const answer = await place(other, key);
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({ code: "idempotency_key_reused", type: "urn:chance:problem:idempotency-key-reused" });
      expectPublicContract("/v1/trading/orders", "POST", answer);
    }
  });

  it("answers 400 with the fields at fault for an invalid body or Idempotency-Key", async () => {
    const cases: Array<[string, unknown, string | null, string]> = [
      ["no key", order(MARKET_1), null, "Idempotency-Key"],
      ["short key", order(MARKET_1), "abc", "Idempotency-Key"],
      ["key with a space", order(MARKET_1), "a key with spaces", "Idempotency-Key"],
      ["unknown field", order(MARKET_1, { tenantId: TENANT_B }), newKey(h.core), "tenantId"],
      ["amount as text", order(MARKET_1, { amount: "10" }), newKey(h.core), "amount"],
      ["amount with decimals", order(MARKET_1, { amount: 10.5 }), newKey(h.core), "amount"],
      ["amount zero", order(MARKET_1, { amount: 0 }), newKey(h.core), "amount"],
      ["amount above the contract", order(MARKET_1, { amount: 1_000_001 }), newKey(h.core), "amount"],
      ["market id", order("not-a-uuid"), newKey(h.core), "marketId"],
      ["lower-case side", order(MARKET_1, { side: "yes" }), newKey(h.core), "side"],
      ["price limit zero", order(MARKET_1, { maxAveragePriceMicro: 0 }), newKey(h.core), "maxAveragePriceMicro"],
      ["price limit one credit", order(MARKET_1, { maxAveragePriceMicro: 1_000_000 }), newKey(h.core), "maxAveragePriceMicro"],
      ["price limit as text", order(MARKET_1, { maxAveragePriceMicro: "300000" }), newKey(h.core), "maxAveragePriceMicro"],
      ["missing field", { marketId: MARKET_1, side: "YES" }, newKey(h.core), "amount"],
      ["no body", undefined, newKey(h.core), "body"],
    ];
    for (const [name, body, key, field] of cases) {
      const answer = await place(body, key);
      expect(answer.status, name).toBe(400);
      expect(answer.body, name).toMatchObject({ code: "validation_failed" });
      expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), name).toContain(field);
      expectPublicContract("/v1/trading/orders", "POST", answer);
    }
  });

  it("answers 400 for an amount above ORDER_AMOUNT_MAX, and an order below it still goes through", async () => {
    const before = { ...h.core.rules.rules };
    try {
      h.core.rules.rules.orderAmountMax = 5;
      const refused = await place(order(MARKET_1, { amount: 6 }));
      expect(refused.status).toBe(400);
      expect(refused.body?.["errors"]).toEqual([expect.objectContaining({ field: "amount" })]);
      expect((await place(order(MARKET_1, { amount: 5 }))).status).toBe(201);
    } finally {
      h.core.rules.rules = before;
    }
  });

  it("answers 404 for an unknown market, and for another tenant's market exactly like it", async () => {
    await grant(h.core, "trader-b", 100, TENANT_B);
    const unknown = await place(order(UNKNOWN_MARKET));
    const other = await place(order(MARKET_1), newKey(h.core), asTrader("trader-b", TENANT_B));
    expect(unknown.status).toBe(404);
    expect(other.status).toBe(404);
    expectPublicContract("/v1/trading/orders", "POST", other);
  });

  it("answers 409 market_not_open for a market that is only funded and for one that closed", async () => {
    expect((await place(order(MARKET_2))).body).toMatchObject({ code: "market_not_open" });
    const closing = await openMarket(h.core, { marketId: MARKET_3, creatorId: "admin-3" });
    await h.core.useCases.recordMarketEvent.execute(marketClosed(h.core, { marketId: closing }));
    const answer = await place(order(MARKET_3));
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "market_not_open" });
    expectPublicContract("/v1/trading/orders", "POST", answer);
  });

  it("answers 409 insufficient_credits and keeps no key: the same key works after the user has credits", async () => {
    const key = newKey(h.core);
    const refused = await place(order(MARKET_1), key, asTrader("poor-1"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "insufficient_credits", type: "urn:chance:problem:insufficient-credits" });
    expectPublicContract("/v1/trading/orders", "POST", refused);

    await grant(h.core, "poor-1", 50);
    const later = await place(order(MARKET_1), key, asTrader("poor-1"));
    expect(later.status).toBe(201);
  });

  it("answers 409 insufficient_liquidity with maxAmount", async () => {
    const answer = await place(order(MARKET_1, { amount: 131 }));
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "insufficient_liquidity" });
    expect(answer.body?.["maxAmount"]).toBeLessThan(131);
    expectPublicContract("/v1/trading/orders", "POST", answer);
  });

  it("answers 409 price_limit_exceeded (DM-18) with a fresh quote, and buys nothing", async () => {
    const before = (await call(h, "GET", "/v1/trading/portfolio")).body?.["balanceMicro"];
    const answer = await place(order(MARKET_1, { amount: 10, maxAveragePriceMicro: 300_000 }));
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "price_limit_exceeded", maxAveragePriceMicro: 300_000 });
    // Earlier orders of this block used the cheapest level up, so the fresh quote is above the limit but not above the book.
    const fresh = answer.body?.["quote"];
    expect(fresh).toMatchObject({ marketId: MARKET_1, side: "YES", amount: 10 });
    expect(fresh.averagePriceMicro).toBe(answer.body?.["averagePriceMicro"]);
    expect(fresh.averagePriceMicro).toBeGreaterThan(300_000);
    expect(typeof answer.body?.["quote"].quotedAt).toBe("string");
    expectPublicContract("/v1/trading/orders", "POST", answer);
    expect((await call(h, "GET", "/v1/trading/portfolio")).body?.["balanceMicro"]).toBe(before);
    // The limit is a ceiling on the average price: at or above the price, the order fills.
    expect((await place(order(MARKET_1, { amount: 10, maxAveragePriceMicro: fresh.averagePriceMicro }))).status).toBe(201);
  });

  it("answers 503 with Retry-After when orders are paused, and the same order goes through when they are back", async () => {
    const key = newKey(h.core);
    const before = { ...h.core.rules.rules };
    try {
      h.core.rules.rules.ordersEnabled = false;
      const paused = await place(order(MARKET_1), key);
      expect(paused.status).toBe(503);
      expect(paused.headers["retry-after"]).toBe("30");
      expect(paused.body).toMatchObject({ code: "orders_paused" });
      expectPublicContract("/v1/trading/orders", "POST", paused);
    } finally {
      h.core.rules.rules = before;
    }
    expect((await place(order(MARKET_1), key)).status).toBe(201);
  });

  it("answers 503 tenant_not_ready for a tenant that is not set up, and concurrent_update when the accounts kept changing", async () => {
    const notReady = await place(order(MARKET_1), newKey(h.core), asTrader("t-c", TENANT_C));
    expect(notReady.status).toBe(503);
    expect(notReady.headers["retry-after"]).toBe("5");
    expect(notReady.body).toMatchObject({ code: "tenant_not_ready" });

    const original = h.core.useCases.placeOrder.execute.bind(h.core.useCases.placeOrder);
    h.core.useCases.placeOrder.execute = () => Promise.reject(new ConcurrentUpdate());
    try {
      const busy = await place(order(MARKET_1));
      expect(busy.status).toBe(503);
      expect(busy.headers["retry-after"]).toBe("1");
      expect(busy.body).toMatchObject({ code: "concurrent_update" });
      expectPublicContract("/v1/trading/orders", "POST", busy);
    } finally {
      h.core.useCases.placeOrder.execute = original;
    }
  });

  it("writes TradeExecuted with the caller's correlation id into the outbox in the same step", async () => {
    const answer = await call(h, "POST", "/v1/trading/orders", {
      headers: { ...withKey(newKey(h.core)), "x-correlation-id": "trace-order-1" },
      body: order(MARKET_1),
    });
    expect(answer.status).toBe(201);
    const event = h.core.store.snapshot().outbox.find((row) => row.type === "si.chance.trading.TradeExecuted.v1" && (row.payload.data as { tradeId: string }).tradeId === answer.body?.["tradeId"]);
    expect(event?.payload).toMatchObject({ correlationid: "trace-order-1", tenantid: TENANT_A, subject: `market/${MARKET_1}` });
  });
});

describe("UC-08: GET /v1/trading/sale-quote and POST /v1/trading/sales", () => {
  let h: Harness;
  const SHARE = 1_000_000;
  beforeAll(async () => {
    h = await createHarness();
    await openMarket(h.core);
    await openMarket(h.core, { marketId: MARKET_3, creatorId: "admin-3" });
    await grant(h.core, TRADER, 500);
    // 100 YES in each market for 40 credits.
    for (const marketId of [MARKET_1, MARKET_3]) expect((await call(h, "POST", "/v1/trading/orders", { headers: withKey(newKey(h.core)), body: order(marketId, { amount: 40 }) })).status).toBe(201);
    await h.core.useCases.recordMarketEvent.execute(marketClosed(h.core, { marketId: MARKET_3 }));
  });
  afterAll(async () => {
    await h.close();
  });

  const saleQuoteUrl = (marketId: string, sharesMicro: number | string, side = "YES") => `/v1/trading/sale-quote?marketId=${marketId}&side=${side}&sharesMicro=${sharesMicro}`;
  const sale = (marketId: string, extra: Record<string, unknown> = {}) => ({ marketId, side: "YES", sharesMicro: 10 * SHARE, ...extra });
  async function sell(body: unknown, key: string | null = newKey(h.core), token = asTrader()) {
    return call(h, "POST", "/v1/trading/sales", { token, body, ...(key === null ? {} : { headers: withKey(key) }) });
  }

  it("quotes a sale for a trader and a tenant admin, in any letter case of the market id, and changes nothing", async () => {
    const before = h.core.store.snapshot();
    const answer = await call(h, "GET", saleQuoteUrl(MARKET_1.toUpperCase(), 10 * SHARE));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ marketId: MARKET_1, side: "YES", sharesMicro: 10 * SHARE, costMicro: 6 * CREDIT, proceedsMicro: 4 * CREDIT, averagePriceMicro: 400_000, tradeSequence: 1 });
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expectPublicContract("/v1/trading/sale-quote", "GET", answer);
    expect((await call(h, "GET", saleQuoteUrl(MARKET_1, SHARE), { token: asTenantAdmin() })).status).toBe(200);
    expect(h.core.store.snapshot()).toEqual(before);
  });

  it("answers 400 for an invalid sale query and 409 for a closed market or more than the offers hold", async () => {
    for (const url of [saleQuoteUrl(MARKET_1, 0), saleQuoteUrl(MARKET_1, "1.5"), saleQuoteUrl(MARKET_1, "9007199254740992"), saleQuoteUrl("nope", 1), saleQuoteUrl(MARKET_1, 1, "yes"), `${saleQuoteUrl(MARKET_1, 1)}&amount=1`]) {
      const answer = await call(h, "GET", url);
      expect(answer.status, url).toBe(400);
      expectPublicContract("/v1/trading/sale-quote", "GET", answer);
    }
    expect((await call(h, "GET", saleQuoteUrl(MARKET_3, SHARE))).body).toMatchObject({ status: 409, code: "market_not_open" });
    expect((await call(h, "GET", saleQuoteUrl(MARKET_1, 300 * SHARE + 1))).body).toMatchObject({ status: 409, code: "insufficient_liquidity", maxSharesMicro: 300 * SHARE });
  });

  it("sells: 201 with the proceeds, the new balance, the position and the trade sequence (DM-17); a repeat is 200", async () => {
    const key = newKey(h.core);
    const answer = await sell(sale(MARKET_1), key);
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      marketId: MARKET_1,
      side: "YES",
      sharesMicro: 10 * SHARE,
      costMicro: 6 * CREDIT,
      proceedsMicro: 4 * CREDIT,
      fills: [{ priceMicro: 600_000, sharesMicro: 10 * SHARE, costMicro: 6 * CREDIT }],
      tradeSequence: 2,
      balanceMicro: 424 * CREDIT,
      position: { marketId: MARKET_1, yesMicro: 90 * SHARE, noMicro: 0 },
    });
    expectPublicContract("/v1/trading/sales", "POST", answer);
    const again = await sell(sale(MARKET_1), key);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(answer.body);
    expect((await sell(sale(MARKET_1, { sharesMicro: 11 * SHARE }), key)).body).toMatchObject({ status: 422, code: "idempotency_key_reused" });
  });

  it("checks the role before the body: a tenant admin gets 403 even for an invalid body", async () => {
    const answer = await sell({ nonsense: true }, null, asTenantAdmin());
    expect(answer.status).toBe(403);
    expectPublicContract("/v1/trading/sales", "POST", answer);
  });

  it("answers 400 with the fields at fault for an invalid sale body or Idempotency-Key", async () => {
    const cases: Array<[string, unknown, string | null, string]> = [
      ["no key", sale(MARKET_1), null, "Idempotency-Key"],
      ["unknown field", sale(MARKET_1, { amount: 10 }), newKey(h.core), "amount"],
      ["shares zero", sale(MARKET_1, { sharesMicro: 0 }), newKey(h.core), "sharesMicro"],
      ["shares as text", sale(MARKET_1, { sharesMicro: "10" }), newKey(h.core), "sharesMicro"],
      ["shares with decimals", sale(MARKET_1, { sharesMicro: 1.5 }), newKey(h.core), "sharesMicro"],
      ["shares beyond exact integers", sale(MARKET_1, { sharesMicro: 2 ** 53 }), newKey(h.core), "sharesMicro"],
      ["minimum zero", sale(MARKET_1, { minProceedsMicro: 0 }), newKey(h.core), "minProceedsMicro"],
      ["market id", sale("not-a-uuid"), newKey(h.core), "marketId"],
      ["missing shares", { marketId: MARKET_1, side: "YES" }, newKey(h.core), "sharesMicro"],
    ];
    for (const [name, body, key, field] of cases) {
      const answer = await sell(body, key);
      expect(answer.status, name).toBe(400);
      expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), name).toContain(field);
      expectPublicContract("/v1/trading/sales", "POST", answer);
    }
  });

  it("answers 409 for more shares than held, a closed market and proceeds below the minimum (with a fresh quote)", async () => {
    expect((await sell(sale(MARKET_1, { sharesMicro: 1_000 * SHARE }))).body).toMatchObject({ status: 409, code: "insufficient_shares", heldMicro: 90 * SHARE });
    expect((await sell(sale(MARKET_3))).body).toMatchObject({ status: 409, code: "market_not_open" });
    const limited = await sell(sale(MARKET_1, { minProceedsMicro: 5 * CREDIT }));
    expect(limited.body).toMatchObject({ status: 409, code: "proceeds_below_minimum", proceedsMicro: 4 * CREDIT, quote: { proceedsMicro: 4 * CREDIT, sharesMicro: 10 * SHARE } });
    expectPublicContract("/v1/trading/sales", "POST", limited);
  });

  it("writes TradeExecuted (kind sale) with the caller's correlation id into the outbox in the same step", async () => {
    const answer = await call(h, "POST", "/v1/trading/sales", { headers: { ...withKey(newKey(h.core)), "x-correlation-id": "trace-sale-1" }, body: sale(MARKET_1, { side: "YES", sharesMicro: SHARE }) });
    expect(answer.status).toBe(201);
    const event = h.core.store.snapshot().outbox.find((row) => row.type === "si.chance.trading.TradeExecuted.v1" && (row.payload.data as { tradeId: string }).tradeId === answer.body?.["tradeId"]);
    expect(event?.payload).toMatchObject({ correlationid: "trace-sale-1", data: { kind: "sale", side: "NO", sharesMicro: SHARE } });
  });
});

describe("GET /v1/trading/portfolio", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await openMarket(h.core);
    await grant(h.core, TRADER, 500);
  });
  afterAll(async () => {
    await h.close();
  });

  it("shows zeros to a user without an account, and no funded markets to a trader", async () => {
    const answer = await call(h, "GET", "/v1/trading/portfolio", { token: asTrader("newcomer") });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ balanceMicro: 0, withdrawableCredits: 0, positions: [], recentTrades: [], payouts: [], fundedMarkets: null });
    expectPublicContract("/v1/trading/portfolio", "GET", answer);
  });

  it("lists balance, positions with the market copy, recent trades newest first and the limit", async () => {
    for (let i = 0; i < 3; i += 1) {
      h.core.clock.tick();
      const placed = await call(h, "POST", "/v1/trading/orders", { headers: withKey(newKey(h.core)), body: order(MARKET_1, { amount: 10 + i }) });
      expect(placed.status).toBe(201);
    }
    const answer = await call(h, "GET", "/v1/trading/portfolio");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ balanceMicro: (500 - 33) * CREDIT, withdrawableCredits: 467, fundedMarkets: null });
    expect(answer.body?.["positions"]).toEqual([
      { marketId: MARKET_1, yesMicro: expect.any(Number), noMicro: 0, question: "Will the bridge open before 2027?", status: "open", closeTime: expect.any(String) },
    ]);
    const trades = answer.body?.["recentTrades"] as Array<{ tradeSequence: number; costMicro: number }>;
    expect(trades.map((trade) => trade.tradeSequence)).toEqual([3, 2, 1]);
    expect(trades.map((trade) => trade.costMicro)).toEqual([12 * CREDIT, 11 * CREDIT, 10 * CREDIT]);
    expectPublicContract("/v1/trading/portfolio", "GET", answer);

    const limited = await call(h, "GET", "/v1/trading/portfolio?limit=1");
    expect(limited.body?.["recentTrades"]).toHaveLength(1);
    expect(limited.body?.["recentTrades"][0].tradeSequence).toBe(3);
  });

  it("gives a tenant admin the markets they funded, and sees nothing of another tenant", async () => {
    const admin = await call(h, "GET", "/v1/trading/portfolio", { token: asTenantAdmin() });
    expect(admin.status).toBe(200);
    expect(admin.body?.["fundedMarkets"]).toEqual([
      { marketId: MARKET_1, question: "Will the bridge open before 2027?", status: "open", fundingMicro: 1000 * CREDIT, returnedMicro: null, settledAt: null },
    ]);
    expectPublicContract("/v1/trading/portfolio", "GET", admin);

    const otherTenant = await call(h, "GET", "/v1/trading/portfolio", { token: asTrader(TRADER, TENANT_B) });
    expect(otherTenant.status).toBe(200);
    expect(otherTenant.body).toMatchObject({ balanceMicro: 0, positions: [], recentTrades: [] });
  });

  it("answers 400 for an invalid limit or an unknown parameter", async () => {
    for (const query of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "nonsense=1"]) {
      const answer = await call(h, "GET", `/v1/trading/portfolio?${query}`);
      expect(answer.status, query).toBe(400);
      expectPublicContract("/v1/trading/portfolio", "GET", answer);
    }
  });

  it("answers 503 with Retry-After while the caller's tenant is not set up", async () => {
    const answer = await call(h, "GET", "/v1/trading/portfolio", { token: asTrader("t-c", TENANT_C) });
    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("5");
    expectPublicContract("/v1/trading/portfolio", "GET", answer);
  });
});
