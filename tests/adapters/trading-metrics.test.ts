import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { INTERNAL_ERROR, NO_MARKET_STATUS, instrumentTrading, marketStatusOf } from "../../src/adapters/metrics/trading-metrics.js";
import { Conflict, MarketNotOpen, NotFound } from "../../src/usecases/errors.js";
import type { TradingUseCases } from "../../src/usecases/use-cases.js";
import { CREATOR, CREDIT, MARKET_1, TRADER, createCore, fundInput, grant, marketClosed, marketOpened, marketResolved, openMarket, putOffers, tenantAdmin, trader } from "../usecases/core.js";
import type { Core } from "../usecases/core.js";

// The two counters of the orders (src/adapters/metrics/trading-metrics.ts), around the real use cases over the in-memory
// store. Their labels are fixed sets: a kind, an error code and a market status, never an id.

interface Sample {
  labels: Record<string, string | number>;
  value: number;
}

async function samples(registry: Registry, name: string): Promise<Sample[]> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  return (await metric.get()).values as Sample[];
}

async function setup(): Promise<{ core: Core; registry: Registry; useCases: TradingUseCases }> {
  const core = await createCore();
  const registry = new Registry();
  return { core, registry, useCases: instrumentTrading(registry, core.useCases) };
}

const buy = (useCases: TradingUseCases, input: { amount?: number; key: string; marketId?: string; actor?: ReturnType<typeof trader> }) =>
  useCases.placeOrder.execute({ actor: input.actor ?? trader(), idempotencyKey: `test-key-${input.key}`, marketId: input.marketId ?? MARKET_1, side: "YES", amount: input.amount ?? 10 });
const sellYes = (useCases: TradingUseCases, key: string, sharesMicro = 5 * CREDIT) =>
  useCases.sellShares.execute({ actor: trader(), idempotencyKey: `test-key-${key}`, marketId: MARKET_1, side: "YES", sharesMicro });

describe("trading_trades_total", () => {
  it("counts an executed buy and an executed sale by kind, and not the replay of a completed key", async () => {
    const { core, registry, useCases } = await setup();
    await openMarket(core);
    await grant(core, TRADER, 500);

    expect((await buy(useCases, { key: "buy-1" })).replayed).toBe(false);
    expect((await buy(useCases, { key: "buy-1" })).replayed).toBe(true);
    expect((await sellYes(useCases, "sale-1")).replayed).toBe(false);
    expect((await sellYes(useCases, "sale-1")).replayed).toBe(true);

    expect(await samples(registry, "trading_trades_total")).toEqual([
      { value: 1, labels: { kind: "buy" } },
      { value: 1, labels: { kind: "sale" } },
    ]);
    expect(await samples(registry, "trading_orders_refused_total")).toEqual([]);
  });

  it("leaves the other use cases as they are", async () => {
    const { core, useCases } = await setup();
    expect(useCases.getQuote).toBe(core.useCases.getQuote);
    expect(useCases.getPortfolio).toBe(core.useCases.getPortfolio);
  });
});

describe("trading_orders_refused_total", () => {
  it("names the status of the market for market_not_open: funded, closed, resolved", async () => {
    const { core, registry, useCases } = await setup();
    await grant(core, CREATOR, 1000);
    await grant(core, TRADER, 500);
    await core.useCases.fundMarket.execute(fundInput());
    await expect(buy(useCases, { key: "k-funded" })).rejects.toMatchObject({ code: "market_not_open" });

    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    await putOffers(core, MARKET_1, [{ side: "YES", priceMicro: 500_000, sharesMicro: 100_000_000 }]);
    await core.useCases.recordMarketEvent.execute(marketClosed(core));
    await expect(buy(useCases, { key: "k-closed" })).rejects.toMatchObject({ code: "market_not_open" });
    await expect(sellYes(useCases, "k-closed-sale")).rejects.toMatchObject({ code: "market_not_open" });

    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));
    await expect(buy(useCases, { key: "k-resolved" })).rejects.toMatchObject({ code: "market_not_open" });

    const values = await samples(registry, "trading_orders_refused_total");
    const count = (kind: string, status: string) => values.find((sample) => sample.labels["kind"] === kind && sample.labels["market_status"] === status)?.value;
    expect(count("buy", "funded")).toBe(1);
    expect(count("buy", "closed")).toBe(1);
    expect(count("sale", "closed")).toBe(1);
    expect(count("buy", "resolved")).toBe(1);
    expect(values.every((sample) => sample.labels["reason"] === "market_not_open")).toBe(true);
  });

  it('counts the other refusals by their error code, with the market status "none"', async () => {
    const { core, registry, useCases } = await setup();
    await openMarket(core);
    await grant(core, TRADER, 500);
    await expect(buy(useCases, { key: "k-missing", marketId: "018f3c1e-7a00-7000-8000-0000000000f1" })).rejects.toMatchObject({ code: "not_found" });
    await expect(buy(useCases, { key: "k-big", amount: 100_000_000 })).rejects.toBeInstanceOf(Error);
    await expect(buy(useCases, { key: "k-admin", actor: tenantAdmin() })).rejects.toBeInstanceOf(Error);

    const values = await samples(registry, "trading_orders_refused_total");
    expect(values.length).toBeGreaterThanOrEqual(2);
    for (const sample of values) {
      expect(sample.labels["kind"]).toBe("buy");
      expect(sample.labels["market_status"]).toBe(NO_MARKET_STATUS);
    }
    expect(values.find((sample) => sample.labels["reason"] === "not_found")?.value).toBe(1);
    // No id of a market, tenant or user is a label value anywhere.
    expect(await registry.metrics()).not.toContain(MARKET_1);
    expect(await registry.metrics()).not.toContain(TRADER);
  });

  it("counts a failure that is no use-case error as internal_error and rethrows it unchanged", async () => {
    const core = await createCore();
    const registry = new Registry();
    const boom = new Error("the store is gone");
    core.useCases.placeOrder.execute = () => Promise.reject(boom);
    core.useCases.sellShares.execute = () => Promise.reject(boom);
    const useCases = instrumentTrading(registry, core.useCases);
    await expect(buy(useCases, { key: "k" })).rejects.toBe(boom);
    await expect(sellYes(useCases, "k")).rejects.toBe(boom);
    expect(await samples(registry, "trading_orders_refused_total")).toEqual([
      { value: 1, labels: { kind: "buy", reason: INTERNAL_ERROR, market_status: NO_MARKET_STATUS } },
      { value: 1, labels: { kind: "sale", reason: INTERNAL_ERROR, market_status: NO_MARKET_STATUS } },
    ]);
  });
});

describe("marketStatusOf", () => {
  it("reads the status of a market_not_open error and nothing else", () => {
    expect(marketStatusOf(new MarketNotOpen("x", { status: "closed" }))).toBe("closed");
    expect(marketStatusOf(new MarketNotOpen("x", { status: "open" }))).toBe("open");
    expect(marketStatusOf(new MarketNotOpen("x", { status: "made-up-by-a-bug" }))).toBe(NO_MARKET_STATUS);
    expect(marketStatusOf(new MarketNotOpen("x", { status: 5 }))).toBe(NO_MARKET_STATUS);
    expect(marketStatusOf(new MarketNotOpen("x"))).toBe(NO_MARKET_STATUS);
    expect(marketStatusOf(new Conflict("market_closed", "x", { status: "closed" }))).toBe(NO_MARKET_STATUS);
    expect(marketStatusOf(new NotFound())).toBe(NO_MARKET_STATUS);
    expect(marketStatusOf(new Error("x"))).toBe(NO_MARKET_STATUS);
    expect(marketStatusOf("closed")).toBe(NO_MARKET_STATUS);
  });
});
