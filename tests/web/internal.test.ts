import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Offer } from "../../src/domain/order-book.js";
import { CREATOR, MARKET_1, MARKET_2, TENANT_A, TENANT_B, TRADER } from "../support/fakes.js";
import { AUDIENCE } from "../support/tokens.js";
import {
  CREDIT,
  DEFAULT_OFFERS,
  asTenantAdmin,
  asTrader,
  call,
  callInternal,
  createHarness,
  expectInternalContract,
  fundOnly,
  fundingBody,
  grant,
  marketClosed,
  marketOpened,
  newKey,
  openMarket,
  withKey,
} from "../support/harness.js";
import type { Harness } from "../support/harness.js";

const MARKET_3 = "018f3c1e-7a00-7000-8000-000000000103";
const UNKNOWN_MARKET = "018f3c1e-7a00-7000-8000-0000000000f1";
const WITHDRAWAL_1 = "018f3c1e-7a00-7000-8000-0000000000d1";
const WITHDRAWAL_2 = "018f3c1e-7a00-7000-8000-0000000000d2";
const TENANT_C = "018f3c1e-7a00-7000-8000-0000000000cc";

const FUNDING = "/v1/internal/market-funding";
const DEBITS = "/v1/internal/debits";
const bookUrl = (marketId: string) => `/v1/internal/markets/${marketId}/bot-book`;
const ordersUrl = (marketId: string) => `/v1/internal/markets/${marketId}/bot-orders`;
const BOT_BOOK = "/v1/internal/markets/{marketId}/bot-book";
const BOT_ORDERS = "/v1/internal/markets/{marketId}/bot-orders";

describe("POST /v1/internal/market-funding (markets)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const fund = (marketId: string, amount: number, overrides: { tenantId?: string; creatorId?: string } = {}, key: string | null = marketId) =>
    callInternal(h, "POST", FUNDING, { client: "markets", body: fundingBody(marketId, amount, overrides), ...(key === null ? {} : { headers: withKey(key) }) });

  it("takes the creator's credits and answers 201, then 200 for a repeat of the key without taking them again", async () => {
    await grant(h.core, CREATOR, 1000);
    const first = await fund(MARKET_1, 400);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ marketId: MARKET_1, amount: 400 });
    expect(new Date(first.body?.["fundedAt"]).getTime()).toBe(h.core.clock.now().getTime());
    expectInternalContract(FUNDING, "POST", first);

    const again = await fund(MARKET_1, 400);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expectInternalContract(FUNDING, "POST", again);

    const creator = await call(h, "GET", "/v1/trading/portfolio", { token: asTenantAdmin(CREATOR) });
    expect(creator.body?.["balanceMicro"]).toBe(600 * CREDIT);
    const funded = h.core.store.snapshot().outbox.filter((row) => row.type === "si.chance.trading.MarketFunded.v1");
    expect(funded).toHaveLength(1);
    expect(h.core.store.snapshot().directory[MARKET_1]).toBe(TENANT_A);
  });

  it("answers 409 insufficient_credits, stores nothing, and funds the same key once the creator topped up", async () => {
    const refused = await fund(MARKET_2, 5000, { creatorId: "broke-1" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "insufficient_credits", type: "urn:chance:problem:insufficient-credits" });
    expectInternalContract(FUNDING, "POST", refused);
    expect(h.core.store.snapshot().tenantData[TENANT_A]?.marketStates.find((market) => market.marketId === MARKET_2)).toBeUndefined();

    await grant(h.core, "broke-1", 5000);
    expect((await fund(MARKET_2, 5000, { creatorId: "broke-1" })).status).toBe(201);
  });

  it("answers 409 market_closed for a market trading already processed as closed", async () => {
    await h.core.useCases.recordMarketEvent.execute(marketOpened(h.core, { marketId: MARKET_3 }));
    await h.core.useCases.recordMarketEvent.execute(marketClosed(h.core, { marketId: MARKET_3 }));
    await grant(h.core, CREATOR, 100);
    const answer = await fund(MARKET_3, 100);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "market_closed" });
    expectInternalContract(FUNDING, "POST", answer);
  });

  it("answers 422 when the key is used again with another body, or for a market of another tenant", async () => {
    const another = await fund(MARKET_1, 401);
    expect(another.status).toBe(422);
    expect(another.body).toMatchObject({ code: "idempotency_key_reused" });
    expectInternalContract(FUNDING, "POST", another);

    const otherTenant = await fund(MARKET_1, 400, { tenantId: TENANT_B });
    expect(otherTenant.status).toBe(422);
  });

  it("answers 400 with the fields at fault: the key must equal the market id, and the body is strict", async () => {
    const good = fundingBody(MARKET_2, 10);
    const cases: Array<[string, unknown, string | null, string]> = [
      ["no key", good, null, "Idempotency-Key"],
      ["key of another market", good, MARKET_1, "Idempotency-Key"],
      ["unknown field", { ...good, email: "someone@example.test" }, MARKET_2, "email"],
      ["amount zero", { ...good, amount: 0 }, MARKET_2, "amount"],
      ["amount above the contract", { ...good, amount: 1_000_001 }, MARKET_2, "amount"],
      ["amount as text", { ...good, amount: "10" }, MARKET_2, "amount"],
      ["amount with decimals", { ...good, amount: 1.5 }, MARKET_2, "amount"],
      ["market id", { ...good, marketId: "not-a-uuid" }, MARKET_2, "marketId"],
      ["tenant id", { ...good, tenantId: "acme" }, MARKET_2, "tenantId"],
      ["empty creator", { ...good, creatorId: "" }, MARKET_2, "creatorId"],
      ["long creator", { ...good, creatorId: "c".repeat(256) }, MARKET_2, "creatorId"],
      ["missing creator", { marketId: MARKET_2, tenantId: TENANT_A, amount: 10 }, MARKET_2, "creatorId"],
    ];
    for (const [name, body, key, field] of cases) {
      const answer = await callInternal(h, "POST", FUNDING, { client: "markets", body, ...(key === null ? {} : { headers: withKey(key) }) });
      expect(answer.status, name).toBe(400);
      expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), name).toContain(field);
      expectInternalContract(FUNDING, "POST", answer);
    }
  });

  it("provisions a tenant whose TenantCreated was never seen instead of answering tenant_not_ready", async () => {
    expect(h.core.store.snapshot().tenants).not.toContain(TENANT_C);
    const answer = await fund("018f3c1e-7a00-7000-8000-000000000105", 100, { tenantId: TENANT_C, creatorId: "nobody" });
    // The creator has no credits there (balance 0), so the funding is refused for that reason, not because of the tenant.
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "insufficient_credits" });
    expect(h.core.store.snapshot().tenants).toContain(TENANT_C);
  });

  it("takes the tenant from the body, never from the service token", async () => {
    const own = await createHarness();
    await grant(own.core, CREATOR, 100);
    const token = { sub: "service-account-markets", azp: "markets", audience: AUDIENCE, roles: ["tenant-admin"], organization: [TENANT_B] };
    const answer = await callInternal(own, "POST", FUNDING, { token, body: fundingBody(MARKET_1, 100), headers: withKey(MARKET_1) });
    expect(answer.status).toBe(201);
    expect(own.core.store.snapshot().directory[MARKET_1]).toBe(TENANT_A);
    await own.close();
  });
});

describe("POST /v1/internal/debits (payments)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await grant(h.core, TRADER, 100);
  });
  afterAll(async () => {
    await h.close();
  });

  const debit = (withdrawalId: string, amount: number, overrides: { tenantId?: string; userId?: string } = {}, headers: Record<string, string> = {}) =>
    callInternal(h, "POST", DEBITS, { client: "payments", body: { withdrawalId, tenantId: overrides.tenantId ?? TENANT_A, userId: overrides.userId ?? TRADER, amount }, headers });
  const balance = async () => (await call(h, "GET", "/v1/trading/portfolio", { token: asTrader(TRADER) })).body?.["balanceMicro"];

  it("debits and answers 200 {withdrawalId, status: debited}; a repeat answers 200 again and debits nothing more", async () => {
    const first = await debit(WITHDRAWAL_1, 40);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ withdrawalId: WITHDRAWAL_1, status: "debited" });
    expectInternalContract(DEBITS, "POST", first);
    expect(await balance()).toBe(60 * CREDIT);

    const again = await debit(WITHDRAWAL_1, 40);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const withHeader = await debit(WITHDRAWAL_1, 40, {}, withKey(WITHDRAWAL_1));
    expect(withHeader.status).toBe(200);
    expect(await balance()).toBe(60 * CREDIT);
  });

  it("answers 409 insufficient_credits, definitive for the withdrawal: it stays 409 after the user topped up", async () => {
    const refused = await debit(WITHDRAWAL_2, 1000);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "insufficient_credits" });
    expectInternalContract(DEBITS, "POST", refused);

    await grant(h.core, TRADER, 2000);
    const again = await debit(WITHDRAWAL_2, 1000);
    expect(again.status).toBe(409);
    expect(await balance()).toBe(2060 * CREDIT);
  });

  it("answers 422 when a withdrawal id is repeated with another amount, user or tenant", async () => {
    for (const other of [() => debit(WITHDRAWAL_1, 41), () => debit(WITHDRAWAL_1, 40, { userId: "someone-else" }), () => debit(WITHDRAWAL_1, 40, { tenantId: TENANT_B })]) {
      const answer = await other();
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({ code: "idempotency_key_reused" });
      expectInternalContract(DEBITS, "POST", answer);
    }
  });

  it("answers 400 for a header that is not the withdrawal id and for an invalid body", async () => {
    const good = { withdrawalId: WITHDRAWAL_1, tenantId: TENANT_A, userId: TRADER, amount: 40 };
    const cases: Array<[string, unknown, Record<string, string>, string]> = [
      ["header of another id", good, withKey(WITHDRAWAL_2), "Idempotency-Key"],
      ["unknown field", { ...good, note: "x" }, {}, "note"],
      ["amount zero", { ...good, amount: 0 }, {}, "amount"],
      ["amount as text", { ...good, amount: "40" }, {}, "amount"],
      ["withdrawal id", { ...good, withdrawalId: "w-1" }, {}, "withdrawalId"],
      ["tenant id", { ...good, tenantId: "acme" }, {}, "tenantId"],
      ["empty user", { ...good, userId: "" }, {}, "userId"],
      ["missing user", { withdrawalId: WITHDRAWAL_1, tenantId: TENANT_A, amount: 40 }, {}, "userId"],
    ];
    for (const [name, body, headers, field] of cases) {
      const answer = await callInternal(h, "POST", DEBITS, { client: "payments", body, headers });
      expect(answer.status, name).toBe(400);
      expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), name).toContain(field);
      expectInternalContract(DEBITS, "POST", answer);
    }
  });

  it("provisions a tenant whose TenantCreated was never seen and treats a user without an account as balance 0", async () => {
    const answer = await debit("018f3c1e-7a00-7000-8000-0000000000d3", 5, { tenantId: TENANT_C, userId: "nobody" });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "insufficient_credits" });
    expect(h.core.store.snapshot().tenants).toContain(TENANT_C);
  });
});

describe("the market maker's endpoints", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await openMarket(h.core);
    await openMarket(h.core, { marketId: MARKET_2, creatorId: "admin-2" });
    await openMarket(h.core, { marketId: MARKET_3, creatorId: "admin-3", tenantId: TENANT_B });
  });
  afterAll(async () => {
    await h.close();
  });

  const asBot = { client: "market-maker" } as const;
  const put = (marketId: string, basedOnSequence: unknown, offers: unknown) => callInternal(h, "PUT", ordersUrl(marketId), { ...asBot, body: { basedOnSequence, offers } });
  const offer = (side: "YES" | "NO", priceMicro: number, sharesMicro = 10_000_000): Offer => ({ side, priceMicro, sharesMicro });

  it("lists the open markets of every tenant by tenant id and market id, a page at a time", async () => {
    const all = await callInternal(h, "GET", "/v1/internal/markets?status=open", asBot);
    expect(all.status).toBe(200);
    expectInternalContract("/v1/internal/markets", "GET", all);
    const items = all.body?.["items"] as Array<{ marketId: string; tenantId: string }>;
    expect(items.map((item) => [item.tenantId, item.marketId])).toEqual([
      [TENANT_A, MARKET_1],
      [TENANT_A, MARKET_2],
      [TENANT_B, MARKET_3],
    ]);
    expect(items[0]).toMatchObject({ status: "open", version: 1, startingPriceMicro: 400_000, fundingMicro: 1000 * CREDIT, tradeSequence: 0 });
    expect(all.body?.["nextCursor"]).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const answer = await callInternal(h, "GET", `/v1/internal/markets?status=open&limit=2${cursor ? `&cursor=${cursor}` : ""}`, asBot);
      expect(answer.status).toBe(200);
      seen.push(...(answer.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId));
      cursor = answer.body?.["nextCursor"] ?? null;
      if (cursor === null) break;
    }
    expect(seen).toEqual([MARKET_1, MARKET_2, MARKET_3]);
  });

  it("answers 400 for a missing or other status, a limit out of range, an unknown parameter or a cursor that is not one", async () => {
    for (const query of ["", "status=closed", "status=open&limit=0", "status=open&limit=501", "status=open&nonsense=1", "status=open&cursor=garbage"]) {
      const answer = await callInternal(h, "GET", `/v1/internal/markets?${query}`, asBot);
      expect(answer.status, query).toBe(400);
      expectInternalContract("/v1/internal/markets", "GET", answer);
    }
  });

  it("shows the bot's book with its holdings and the market's trade sequence, and answers 404 for an unknown market", async () => {
    const answer = await callInternal(h, "GET", bookUrl(MARKET_1), asBot);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      market: { marketId: MARKET_1, tenantId: TENANT_A, status: "open" },
      holdings: { balanceMicro: 0, yesMicro: 1000 * CREDIT, noMicro: 1000 * CREDIT },
      tradeSequence: 0,
      offersPricedOnSequence: 0,
      maxOffersPerSide: 10,
    });
    expect(answer.body?.["offers"]).toEqual(DEFAULT_OFFERS);
    expectInternalContract(BOT_BOOK, "GET", answer);

    const unknown = await callInternal(h, "GET", bookUrl(UNKNOWN_MARKET), asBot);
    expect(unknown.status).toBe(404);
    expectInternalContract(BOT_BOOK, "GET", unknown);
    expect((await callInternal(h, "GET", bookUrl("not-a-uuid"), asBot)).status).toBe(400);
  });

  it("shows the runtime offer limit on GET and on the PUT answer, follows a change without a restart, and refuses a list above it", async () => {
    // Its own harness: the rule and the book change, and the tests around it share one.
    const own = await createHarness();
    await openMarket(own.core);
    const putOwn = (offers: unknown) => callInternal(own, "PUT", ordersUrl(MARKET_1), { ...asBot, body: { basedOnSequence: 0, offers } });
    own.core.rules.rules = { ...own.core.rules.rules, maxOffersPerSide: 2 };
    expect((await callInternal(own, "GET", bookUrl(MARKET_1), asBot)).body).toMatchObject({ maxOffersPerSide: 2 });

    const refused = await putOwn([offer("YES", 300_000), offer("YES", 310_000), offer("YES", 320_000)]);
    expect(refused.status).toBe(400);
    expectInternalContract(BOT_ORDERS, "PUT", refused);

    const accepted = await putOwn([offer("YES", 300_000), offer("YES", 310_000)]);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ maxOffersPerSide: 2 });
    expectInternalContract(BOT_ORDERS, "PUT", accepted);

    own.core.rules.rules = { ...own.core.rules.rules, maxOffersPerSide: 7 };
    const raised = await callInternal(own, "GET", bookUrl(MARKET_1), asBot);
    expect(raised.body).toMatchObject({ maxOffersPerSide: 7 });
    expectInternalContract(BOT_BOOK, "GET", raised);
    await own.close();
  });

  it("accepts the new book after a trade only when it is based on tradeSequence: offersPricedOnSequence is stale (ADR-041)", async () => {
    await grant(h.core, TRADER, 100);
    const bought = await call(h, "POST", "/v1/trading/orders", { headers: withKey(newKey(h.core)), body: { marketId: MARKET_2, side: "YES", amount: 10 } });
    expect(bought.status).toBe(201);

    const book = (await callInternal(h, "GET", bookUrl(MARKET_2), asBot)).body as { tradeSequence: number; offersPricedOnSequence: number };
    // A fill keeps the sequence the offers were priced on, so after the trade the two differ.
    expect(book.tradeSequence).toBe(1);
    expect(book.offersPricedOnSequence).toBe(0);

    const stale = await put(MARKET_2, book.offersPricedOnSequence, [offer("YES", 400_000), offer("NO", 600_000)]);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "stale_sequence", tradeSequence: 1 });
    expectInternalContract(BOT_ORDERS, "PUT", stale);

    const fresh = await put(MARKET_2, book.tradeSequence, [offer("YES", 420_000), offer("NO", 580_000)]);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ tradeSequence: 1, offersPricedOnSequence: 1 });
    expect(fresh.body?.["offers"]).toEqual([offer("YES", 420_000), offer("NO", 580_000)]);
    expectInternalContract(BOT_ORDERS, "PUT", fresh);
  });

  it("replaces the book completely, an empty list cancels every offer, and a quote then finds no liquidity", async () => {
    const empty = await put(MARKET_1, 0, []);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ offers: [], offersPricedOnSequence: null });
    const quote = await call(h, "GET", `/v1/trading/quote?marketId=${MARKET_1}&side=YES&amount=1`);
    expect(quote.status).toBe(409);
    expect(quote.body).toMatchObject({ code: "insufficient_liquidity", maxAmount: 0 });
    expect((await put(MARKET_1, 0, DEFAULT_OFFERS)).status).toBe(200);
  });

  it("answers 400 for offers the contract or the domain refuses, and names crossed offers", async () => {
    const cases: Array<[string, unknown, unknown, string | null]> = [
      ["price off the grid", 0, [offer("YES", 405_000)], "offers.0.priceMicro"],
      ["price above the grid", 0, [offer("YES", 1_000_000)], "offers.0.priceMicro"],
      ["shares zero", 0, [offer("YES", 400_000, 0)], "offers.0.sharesMicro"],
      ["unknown field", 0, [{ ...offer("YES", 400_000), extra: 1 }], "offers.0.extra"],
      ["lower-case side", 0, [{ side: "yes", priceMicro: 400_000, sharesMicro: 1 }], "offers.0.side"],
      ["sequence as text", "0", [], "basedOnSequence"],
      ["negative sequence", -1, [], "basedOnSequence"],
      ["offers missing", 0, undefined, "offers"],
      ["a repeated price", 0, [offer("YES", 400_000), offer("YES", 400_000)], null],
      ["more offers than allowed", 0, Array.from({ length: 11 }, (_, i) => offer("YES", 100_000 + i * 10_000, 1_000_000)), null],
      ["crossed offers", 0, [offer("YES", 400_000), offer("NO", 500_000)], null],
    ];
    for (const [name, based, offers, field] of cases) {
      const answer = await put(MARKET_1, based, offers);
      expect(answer.status, name).toBe(400);
      expect(answer.body, name).toMatchObject({ code: name === "crossed offers" ? "crossed_offers" : "validation_failed" });
      if (field !== null) expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), name).toContain(field);
      expectInternalContract(BOT_ORDERS, "PUT", answer);
    }
  });

  it("answers 404 for an unknown market and 400 for a path that is not a UUID", async () => {
    const unknown = await put(UNKNOWN_MARKET, 0, []);
    expect(unknown.status).toBe(404);
    expectInternalContract(BOT_ORDERS, "PUT", unknown);
    expect((await put("not-a-uuid", 0, [])).status).toBe(400);
  });

  it("answers 409 insufficient_holdings with the numbers when a side is offered beyond what the bot can back", async () => {
    const answer = await put(MARKET_1, 0, [offer("YES", 400_000, 1500 * CREDIT)]);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "insufficient_holdings", side: "YES", offeredMicro: 1500 * CREDIT, availableMicro: 1000 * CREDIT });
    expectInternalContract(BOT_ORDERS, "PUT", answer);
  });

  it("takes offers on a funded copy that is not open yet, while an order there is refused; a closed market refuses them (market_not_open)", async () => {
    const funded = "018f3c1e-7a00-7000-8000-000000000104";
    await fundOnly(h.core, funded, { creatorId: "admin-4" });
    const rested = await put(funded, 0, [offer("YES", 400_000), offer("NO", 600_000)]);
    expect(rested.status).toBe(200);
    expect(rested.body).toMatchObject({ market: { status: "funded" } });
    await grant(h.core, "trader-4", 10);
    const refused = await call(h, "POST", "/v1/trading/orders", { token: asTrader("trader-4"), headers: withKey(newKey(h.core)), body: { marketId: funded, side: "YES", amount: 1 } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "market_not_open" });

    await h.core.useCases.recordMarketEvent.execute(marketClosed(h.core, { marketId: MARKET_2, version: 5 }));
    const closed = await put(MARKET_2, 1, [offer("YES", 420_000)]);
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ code: "market_not_open" });
    expectInternalContract(BOT_ORDERS, "PUT", closed);
    // MarketClosed cancelled the offers.
    expect((await callInternal(h, "GET", bookUrl(MARKET_2), asBot)).body?.["offers"]).toEqual([]);
  });

  it("serves the market of any tenant by its id: the tenant comes from the directory, not from the token", async () => {
    const answer = await callInternal(h, "GET", bookUrl(MARKET_3), asBot);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ market: { marketId: MARKET_3, tenantId: TENANT_B } });
  });
});
