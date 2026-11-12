import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREATOR, MARKET_1, TENANT_A, TRADER, closeTimeIn } from "../support/fakes.js";
import { CREDIT, DEFAULT_OFFERS, asTrader, call, callInternal, createHarness, fundingBody, newKey, withKey } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

const EVENTS = "/v1/internal/local/events";
const TENANT_C = "018f3c1e-7a00-7000-8000-0000000000cc";
const WITHDRAWAL = "018f3c1e-7a00-7000-8000-0000000000d1";

describe("POST /v1/internal/local/events", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ local: true, provision: false });
  });
  afterAll(async () => {
    await h.close();
  });

  /** A CloudEvent as the other services publish it (structured mode), with a fresh id. */
  const cloudEvent = (type: string, tenantId: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    specversion: "1.0",
    id: h.core.ids.newId(),
    source: "/chance/test",
    type,
    subject: "test/1",
    time: h.core.clock.now().toISOString(),
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: "corr-local",
    causationid: "cause-local",
    data,
    ...overrides,
  });
  const send = (event: unknown, client: "markets" | "payments" | "market-maker" = "markets") => callInternal(h, "POST", EVENTS, { client, body: event });
  const balanceOf = async (userId: string) => (await call(h, "GET", "/v1/trading/portfolio", { token: asTrader(userId) })).body?.["balanceMicro"];

  it("drives the whole flow of the local stack: tenant, deposits, funding, market events, an order, settlement, a refund", async () => {
    const tenant = cloudEvent("si.chance.tenants.TenantCreated.v1", TENANT_A, { tenantId: TENANT_A });
    const provisioned = await send(tenant);
    expect(provisioned.status).toBe(200);
    expect(provisioned.body).toEqual({ kind: "tenant_created", result: "provisioned" });
    expect((await send(tenant)).body).toEqual({ kind: "tenant_created", result: "duplicate" });

    const deposit = (userId: string, amount: number) => cloudEvent("si.chance.payments.DepositSucceeded.v1", TENANT_A, { depositId: h.core.ids.newId(), userId, amount });
    const credited = await send(deposit(CREATOR, 1000), "payments");
    expect(credited.body).toEqual({ kind: "deposit_succeeded", result: "credited" });
    const trader = deposit(TRADER, 200);
    expect((await send(trader, "payments")).body).toMatchObject({ result: "credited" });
    expect((await send(trader, "payments")).body).toMatchObject({ result: "duplicate" });
    expect(await balanceOf(TRADER)).toBe(200 * CREDIT);

    const funded = await callInternal(h, "POST", "/v1/internal/market-funding", { client: "markets", headers: withKey(MARKET_1), body: fundingBody(MARKET_1, 1000) });
    expect(funded.status).toBe(201);
    const opened = await send(
      cloudEvent("si.chance.markets.MarketOpened.v1", TENANT_A, {
        marketId: MARKET_1,
        version: 1,
        question: "Will the bridge open before 2027?",
        closeTime: closeTimeIn(h.core.clock, 24).toISOString(),
        startingPrice: 0.4,
        creatorId: CREATOR,
        openedAt: h.core.clock.now().toISOString(),
        fundingAmount: 1000,
      }),
    );
    expect(opened.body).toMatchObject({ kind: "market_opened" });
    const book = await callInternal(h, "GET", `/v1/internal/markets/${MARKET_1}/bot-book`, { client: "market-maker" });
    expect(book.body).toMatchObject({ market: { status: "open" }, tradeSequence: 0 });
    const offers = await callInternal(h, "PUT", `/v1/internal/markets/${MARKET_1}/bot-orders`, { client: "market-maker", body: { basedOnSequence: 0, offers: DEFAULT_OFFERS } });
    expect(offers.status).toBe(200);

    const bought = await call(h, "POST", "/v1/trading/orders", { token: asTrader(TRADER), headers: withKey(newKey(h.core)), body: { marketId: MARKET_1, side: "YES", amount: 10 } });
    expect(bought.status).toBe(201);

    const closed = await send(cloudEvent("si.chance.markets.MarketClosed.v1", TENANT_A, { marketId: MARKET_1, version: 2, closedAt: h.core.clock.now().toISOString(), closedBy: CREATOR }));
    expect(closed.body).toMatchObject({ kind: "market_closed" });
    const resolved = await send(
      cloudEvent("si.chance.markets.MarketResolved.v1", TENANT_A, { marketId: MARKET_1, version: 3, outcome: "YES", resolvedAt: h.core.clock.now().toISOString(), resolvedBy: CREATOR, creatorId: CREATOR }),
    );
    expect(resolved.body).toEqual({ kind: "market_resolved", result: "settled" });

    // 25 winning shares pay 25 credits: 200 - 10 + 25.
    const portfolio = await call(h, "GET", "/v1/trading/portfolio", { token: asTrader(TRADER) });
    expect(portfolio.body?.["balanceMicro"]).toBe(215 * CREDIT);
    expect(portfolio.body?.["payouts"]).toEqual([expect.objectContaining({ marketId: MARKET_1, kind: "winnings", amountMicro: 25 * CREDIT, outcome: "YES" })]);
    expect(h.core.store.snapshot().outbox.map((row) => row.type)).toContain("si.chance.trading.MarketSettled.v1");

    const debit = await callInternal(h, "POST", "/v1/internal/debits", { client: "payments", body: { withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: TRADER, amount: 15 } });
    expect(debit.status).toBe(200);
    expect(await balanceOf(TRADER)).toBe(200 * CREDIT);
    const failed = cloudEvent("si.chance.payments.WithdrawalFailed.v1", TENANT_A, { withdrawalId: WITHDRAWAL, userId: TRADER, amount: 15, reason: "payout_failed" });
    expect((await send(failed, "payments")).body).toEqual({ kind: "withdrawal_failed", result: "refunded" });
    expect(await balanceOf(TRADER)).toBe(215 * CREDIT);
    const again = cloudEvent("si.chance.payments.WithdrawalFailed.v1", TENANT_A, { withdrawalId: WITHDRAWAL, userId: TRADER, amount: 15 });
    expect((await send(again, "payments")).body).toMatchObject({ result: "duplicate" });
    const unknown = cloudEvent("si.chance.payments.WithdrawalFailed.v1", TENANT_A, { withdrawalId: "018f3c1e-7a00-7000-8000-0000000000d8", userId: TRADER, amount: 1 });
    expect((await send(unknown, "payments")).body).toMatchObject({ result: "no_debit" });
  });

  it("admits any of the three service clients, and nobody else", async () => {
    for (const client of ["markets", "payments", "market-maker"] as const) {
      const answer = await send(cloudEvent("si.chance.tenants.TenantCreated.v1", TENANT_C, {}), client);
      expect(answer.status, client).toBe(200);
    }
    expect((await callInternal(h, "POST", EVENTS, { token: null, body: cloudEvent("si.chance.tenants.TenantCreated.v1", TENANT_C, {}) })).status).toBe(401);
    expect((await callInternal(h, "POST", EVENTS, { token: asTrader(), body: cloudEvent("si.chance.tenants.TenantCreated.v1", TENANT_C, {}) })).status).toBe(403);
  });

  it("answers 400 with the reason for an event that is malformed or of a type trading does not consume", async () => {
    const good = cloudEvent("si.chance.payments.DepositSucceeded.v1", TENANT_A, { depositId: h.core.ids.newId(), userId: TRADER, amount: 5 });
    const cases: Array<[string, unknown, string]> = [
      ["unknown type", cloudEvent("si.chance.markets.MarketDeleted.v1", TENANT_A, {}), "type"],
      ["no type", { ...good, type: undefined }, "type"],
      ["no tenant", { ...good, tenantid: undefined }, "event"],
      ["amount out of range", cloudEvent("si.chance.payments.DepositSucceeded.v1", TENANT_A, { depositId: h.core.ids.newId(), userId: TRADER, amount: 0 }), "event"],
      ["tenant of the data differs", cloudEvent("si.chance.markets.MarketClosed.v1", TENANT_A, { tenantId: TENANT_C, marketId: MARKET_1, version: 9, closedAt: h.core.clock.now().toISOString(), closedBy: CREATOR }), "event"],
    ];
    for (const [name, body, field] of cases) {
      const answer = await send(body, "payments");
      expect(answer.status, name).toBe(400);
      expect(answer.body, name).toMatchObject({ code: "validation_failed" });
      expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field), name).toContain(field);
    }
    expect((await send([good])).status).toBe(400);
  });
});

describe("without the local events route", () => {
  it("does not register it: a deployed internal port has no such path", async () => {
    const h = await createHarness();
    expect(h.internalApp.registeredRoutes.map((route) => route.url)).not.toContain(EVENTS);
    const answer = await callInternal(h, "POST", EVENTS, { client: "markets", body: { type: "si.chance.tenants.TenantCreated.v1" } });
    expect(answer.status).toBe(404);
    await h.close();
  });
});
