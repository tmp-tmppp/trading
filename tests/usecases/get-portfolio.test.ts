import { describe, expect, it } from "vitest";
import { CREATOR, CREDIT, MARKET_1, MARKET_2, TENANT_B, TRADER, createCore, grant, marketClosed, marketResolved, openMarket, order, tenantAdmin, trader } from "./core.js";
import type { Core } from "./core.js";

const OTHER = "trader-2";

async function tradedMarket(): Promise<Core> {
  const core = await createCore();
  await openMarket(core);
  await grant(core, TRADER, 200);
  await grant(core, OTHER, 100);
  await order(core, TRADER, { amount: 40 });
  await order(core, OTHER, { side: "NO", amount: 30 });
  return core;
}

const portfolioOf = (core: Core, userId: string, role: "trader" | "tenant-admin" = "trader", limit?: number) =>
  core.useCases.getPortfolio.execute({ actor: role === "trader" ? trader(userId) : tenantAdmin(userId), ...(limit === undefined ? {} : { limit }) });

describe("GetPortfolio", () => {
  it("shows zeros for a user without an account", async () => {
    const core = await createCore();

    expect(await portfolioOf(core, "nobody")).toEqual({ balanceMicro: 0, withdrawableCredits: 0, positions: [], recentTrades: [], payouts: [], fundedMarkets: null });
  });

  it("shows the balance, the positions with their market, and the trades newest first", async () => {
    const core = await tradedMarket();
    core.clock.advanceMs(1000);
    await order(core, TRADER, { side: "NO", amount: 12 });

    const portfolio = await portfolioOf(core, TRADER);

    expect(portfolio).toMatchObject({ balanceMicro: 148 * CREDIT, withdrawableCredits: 148, fundedMarkets: null, payouts: [] });
    expect(portfolio.positions).toEqual([
      { marketId: MARKET_1, yesMicro: 100_000_000, noMicro: 20_000_000, question: "Will the bridge open before 2027?", status: "open", closeTime: new Date(new Date("2026-11-01T10:00:00.000Z").getTime() + 24 * 3_600_000) },
    ]);
    expect(portfolio.recentTrades.map((trade) => [trade.side, trade.costMicro, trade.tradeSequence])).toEqual([["NO", 12 * CREDIT, 3], ["YES", 40 * CREDIT, 1]]);
    expect(portfolio.recentTrades[0]).toMatchObject({ marketId: MARKET_1, sharesMicro: 20_000_000, averagePriceMicro: 600_000, executedAt: new Date("2026-11-01T10:00:01.000Z") });
  });

  it("caps the trades at the limit and refuses a limit outside 1 to 100", async () => {
    const core = await tradedMarket();
    await order(core, TRADER, { amount: 10 });
    await order(core, TRADER, { amount: 10 });

    expect((await portfolioOf(core, TRADER, "trader", 2)).recentTrades.map((trade) => trade.tradeSequence)).toEqual([4, 3]);
    await expect(portfolioOf(core, TRADER, "trader", 0)).rejects.toMatchObject({ kind: "validation", fields: [{ field: "limit" }] });
    await expect(portfolioOf(core, TRADER, "trader", 101)).rejects.toMatchObject({ fields: [{ field: "limit" }] });
  });

  it("shows the winnings after the resolution, with the fraction of a credit that a withdrawal cannot take", async () => {
    const core = await createCore();
    await openMarket(core, { offers: [{ side: "YES", priceMicro: 450_000, sharesMicro: 200_000_000 }, { side: "NO", priceMicro: 550_000, sharesMicro: 200_000_000 }] });
    await grant(core, TRADER, 100);
    await order(core, TRADER, { amount: 20 });
    await core.useCases.recordMarketEvent.execute(marketClosed(core));
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));

    const portfolio = await portfolioOf(core, TRADER);

    // 20 credits bought 44 444 444 YES microshares at 0.45; each winning microshare pays one microcredit.
    expect(portfolio).toMatchObject({ balanceMicro: 80 * CREDIT + 44_444_444, withdrawableCredits: 124, positions: [] });
    expect(portfolio.payouts).toEqual([{ marketId: MARKET_1, kind: "winnings", amountMicro: 44_444_444, outcome: "YES", paidAt: core.clock.now() }]);
  });

  it("shows a losing position as a settled payout of zero", async () => {
    const core = await tradedMarket();
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));

    expect((await portfolioOf(core, OTHER)).payouts).toEqual([{ marketId: MARKET_1, kind: "winnings", amountMicro: 0, outcome: "YES", paidAt: core.clock.now() }]);
  });

  it("shows a tenant admin the markets funded and what came back at resolution; a trader sees null", async () => {
    const core = await tradedMarket();
    await openMarket(core, { marketId: MARKET_2, credits: 100, creatorId: CREATOR, offers: [] });
    const open = await portfolioOf(core, CREATOR, "tenant-admin");
    expect(open.fundedMarkets).toEqual([
      { marketId: MARKET_2, question: "Will the bridge open before 2027?", status: "open", fundingMicro: 100 * CREDIT, returnedMicro: null, settledAt: null },
      { marketId: MARKET_1, question: "Will the bridge open before 2027?", status: "open", fundingMicro: 1000 * CREDIT, returnedMicro: null, settledAt: null },
    ]);

    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));

    const done = await portfolioOf(core, CREATOR, "tenant-admin");
    expect(done.fundedMarkets?.find((market) => market.marketId === MARKET_1)).toMatchObject({ status: "resolved", returnedMicro: 970 * CREDIT, settledAt: core.clock.now() });
    expect(done.payouts).toEqual([{ marketId: MARKET_1, kind: "returned", amountMicro: 970 * CREDIT, outcome: null, paidAt: core.clock.now() }]);
    expect((await portfolioOf(core, TRADER)).fundedMarkets).toBeNull();
  });

  it("keeps tenants apart and answers 503 for an unregistered tenant", async () => {
    const core = await tradedMarket();

    expect(await core.useCases.getPortfolio.execute({ actor: trader(TRADER, TENANT_B) })).toMatchObject({ balanceMicro: 0, positions: [], recentTrades: [] });
    await expect(core.useCases.getPortfolio.execute({ actor: trader(TRADER, "018f3c1e-7a00-7000-8000-0000000000cc") })).rejects.toMatchObject({ kind: "unavailable", code: "tenant_not_ready" });
  });
});
