import { describe, expect, it } from "vitest";
import { CREATOR, CREDIT, MARKET_1, TENANT_A, TRADER, accountsOf, balanceOf, createCore, expectReplayEqual, grant, marketClosed, marketResolved, openMarket, order, sell, systemValue, tenantAdmin, trader } from "./core.js";
import type { Core } from "./core.js";
import { serviceCaller } from "../support/fakes.js";

// UC-08: sell shares before the market closes (buy the other side from the bot, redeem the pairs, one transaction).

const SHARE = 1_000_000;
const OTHER = "trader-2";

/** A market funded with 1000 credits and the default book; the trader bought 100 YES for 40 credits (460 left). */
async function ready(): Promise<Core> {
  const core = await createCore();
  await openMarket(core);
  await grant(core, TRADER, 500);
  await order(core, TRADER, { amount: 40 });
  return core;
}

const marketOf = (core: Core) => core.store.snapshot().tenantData[TENANT_A]?.marketStates.find((market) => market.marketId === MARKET_1);
const bookOf = async (core: Core) => (await core.useCases.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId: MARKET_1 })).offers;
const tradeEvents = (core: Core) => core.store.snapshot().outbox.filter((row) => row.type === "si.chance.trading.TradeExecuted.v1").map((row) => row.payload.data as Record<string, unknown>);
const positionOf = (core: Core, userId = TRADER) => accountsOf(core).find((account) => account.streamId === `account:${userId}`)?.positions[MARKET_1];

describe("GetSaleQuote", () => {
  it("plans a sale from the other side's cheapest offer without changing anything, for traders and tenant admins", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    const quote = await core.useCases.getSaleQuote.execute({ actor: trader(), marketId: MARKET_1, side: "YES", sharesMicro: 50 * SHARE });

    expect(quote).toEqual({
      marketId: MARKET_1,
      side: "YES",
      sharesMicro: 50 * SHARE,
      proceedsMicro: 20 * CREDIT,
      averagePriceMicro: 400_000,
      costMicro: 30 * CREDIT,
      fills: [{ priceMicro: 600_000, sharesMicro: 50 * SHARE, costMicro: 30 * CREDIT }],
      tradeSequence: 1,
      quotedAt: core.clock.now(),
    });
    expect(core.store.snapshot()).toEqual(before);
    await expect(core.useCases.getSaleQuote.execute({ actor: tenantAdmin(), marketId: MARKET_1, side: "NO", sharesMicro: SHARE })).resolves.toMatchObject({ costMicro: 450_000 });
  });

  it("answers the most the offers can take, a missing market, a closed market and invalid shares", async () => {
    const core = await ready();
    const quote = (sharesMicro: number, marketId = MARKET_1) => core.useCases.getSaleQuote.execute({ actor: trader(), marketId, side: "YES", sharesMicro });
    await expect(quote(300 * SHARE + 1)).rejects.toMatchObject({ code: "insufficient_liquidity", details: { maxSharesMicro: 300 * SHARE } });
    await expect(quote(SHARE, "018f3c1e-7a00-7000-8000-000000000999")).rejects.toMatchObject({ code: "not_found" });
    await expect(quote(0)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(core.useCases.getSaleQuote.execute({ actor: trader(), marketId: MARKET_1, side: "MAYBE", sharesMicro: 1 })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(core.useCases.getSaleQuote.execute({ actor: trader("x", "018f3c1e-7a00-7000-8000-0000000000cc"), marketId: MARKET_1, side: "YES", sharesMicro: 1 })).rejects.toMatchObject({ code: "tenant_not_ready" });
    await core.useCases.recordMarketEvent.execute(marketClosed(core));
    await expect(quote(SHARE)).rejects.toMatchObject({ code: "market_not_open" });
  });
});

describe("SellShares", () => {
  it("sells: the position shrinks, the proceeds arrive, the book and the sequence move, TradeExecuted says sale", async () => {
    const core = await ready();
    const valueBefore = systemValue(core);

    const { result, replayed } = await sell(core, TRADER, { sharesMicro: 50 * SHARE, key: "sale-key-1" });

    expect(replayed).toBe(false);
    expect(result).toEqual({
      tradeId: expect.any(String),
      marketId: MARKET_1,
      side: "YES",
      sharesMicro: 50 * SHARE,
      proceedsMicro: 20 * CREDIT,
      averagePriceMicro: 400_000,
      costMicro: 30 * CREDIT,
      fills: [{ priceMicro: 600_000, sharesMicro: 50 * SHARE, costMicro: 30 * CREDIT }],
      tradeSequence: 2,
      executedAt: core.clock.now(),
      balanceMicro: 480 * CREDIT,
      position: { marketId: MARKET_1, yesMicro: 50 * SHARE, noMicro: 0 },
    });
    expect(balanceOf(core, TRADER)).toBe(480 * CREDIT);
    expect(positionOf(core)).toEqual({ yesMicro: 50 * SHARE, noMicro: 0 });
    expect(marketOf(core)?.tradeSequence).toBe(2);
    expect(await bookOf(core)).toContainEqual({ side: "NO", priceMicro: 600_000, sharesMicro: 50 * SHARE });
    expect(tradeEvents(core).at(-1)).toEqual({
      tradeId: result.tradeId,
      marketId: MARKET_1,
      userId: TRADER,
      side: "NO",
      sharesMicro: 50 * SHARE,
      costMicro: 30 * CREDIT,
      averagePriceMicro: 600_000,
      lastPriceMicro: 600_000,
      yesPriceMicro: 400_000,
      tradeSequence: 2,
      executedAt: core.clock.now().toISOString(),
      kind: "sale",
    });
    expect(tradeEvents(core)[0]?.["kind"]).toBe("buy");
    // A sale moves value between the trader and the bot account, never creates or destroys it.
    expect(systemValue(core)).toBe(valueBefore);
    await expectReplayEqual(core);
  });

  it("sells everything held, and a trader with no credits left can sell", async () => {
    const core = await createCore();
    await openMarket(core);
    await grant(core, OTHER, 40);
    await order(core, OTHER, { amount: 40 }); // all 40 credits: 100 YES, balance 0
    expect(balanceOf(core, OTHER)).toBe(0);
    const { result } = await sell(core, OTHER, { sharesMicro: 100 * SHARE });
    expect(result).toMatchObject({ proceedsMicro: 40 * CREDIT, balanceMicro: 40 * CREDIT, position: { yesMicro: 0, noMicro: 0 } });
    expect(positionOf(core, OTHER)).toBeUndefined();
    await expectReplayEqual(core);
  });

  it("answers a repeat of the same key and body with the stored result, sells nothing again, and refuses the key with another body", async () => {
    const core = await ready();
    const first = await sell(core, TRADER, { sharesMicro: 10 * SHARE, key: "sale-key-2" });
    const after = core.store.snapshot();
    core.clock.advanceMs(60_000);

    const again = await sell(core, TRADER, { sharesMicro: 10 * SHARE, key: "sale-key-2" });

    expect(again).toEqual({ result: first.result, replayed: true });
    expect(core.store.snapshot()).toEqual(after);
    await expect(sell(core, TRADER, { sharesMicro: 11 * SHARE, key: "sale-key-2" })).rejects.toMatchObject({ kind: "unprocessable", code: "idempotency_key_reused" });
    await expect(sell(core, TRADER, { sharesMicro: 10 * SHARE, key: "sale-key-2", minProceedsMicro: 1 })).rejects.toMatchObject({ code: "idempotency_key_reused" });
    // One key names one request of the user: an order's key cannot become a sale, nor a sale's key an order.
    await order(core, TRADER, { amount: 5, key: "order-key-9" });
    await expect(sell(core, TRADER, { sharesMicro: SHARE, key: "order-key-9" })).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(order(core, TRADER, { amount: 5, key: "sale-key-2" })).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });

  it("refuses tenant admins, a missing key, a bad body and an unknown tenant before anything else", async () => {
    const core = await ready();
    await expect(core.useCases.sellShares.execute({ actor: tenantAdmin(), idempotencyKey: undefined, marketId: "x", side: "?", sharesMicro: 0 })).rejects.toMatchObject({ kind: "forbidden" });
    await expect(sell(core, TRADER, { sharesMicro: SHARE, key: "short" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(sell(core, TRADER, { sharesMicro: 0.5 })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(sell(core, TRADER, { sharesMicro: SHARE, minProceedsMicro: 0 })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(sell(core, TRADER, { sharesMicro: SHARE }, "018f3c1e-7a00-7000-8000-0000000000cc")).rejects.toMatchObject({ code: "tenant_not_ready" });
  });

  it("refuses a sale of more than the position holds and one the offers cannot take; nothing is stored under the key", async () => {
    const core = await ready();
    const before = core.store.snapshot();
    await expect(sell(core, TRADER, { sharesMicro: 100 * SHARE + 1, key: "sale-key-3" })).rejects.toMatchObject({
      kind: "conflict",
      code: "insufficient_shares",
      details: { side: "YES", heldMicro: 100 * SHARE },
    });
    await expect(sell(core, TRADER, { side: "NO", sharesMicro: 1, key: "sale-key-4" })).rejects.toMatchObject({ code: "insufficient_shares", details: { heldMicro: 0 } });
    await expect(sell(core, OTHER, { sharesMicro: 1 })).rejects.toMatchObject({ code: "insufficient_shares" });
    expect(core.store.snapshot()).toEqual(before);
    // The refused key is free: the same key sells once the body fits.
    await expect(sell(core, TRADER, { sharesMicro: 100 * SHARE, key: "sale-key-3" })).resolves.toMatchObject({ replayed: false });

    const thin = await createCore();
    await openMarket(thin, { offers: [{ side: "YES", priceMicro: 400_000, sharesMicro: 100 * SHARE }, { side: "NO", priceMicro: 600_000, sharesMicro: 10 * SHARE }] });
    await grant(thin, TRADER, 100);
    await order(thin, TRADER, { amount: 20 });
    await expect(sell(thin, TRADER, { sharesMicro: 11 * SHARE })).rejects.toMatchObject({ code: "insufficient_liquidity", details: { maxSharesMicro: 10 * SHARE } });
  });

  it("refuses proceeds below minProceedsMicro with a fresh sale quote, and sells at the limit", async () => {
    const core = await ready();
    const refused = sell(core, TRADER, { sharesMicro: 50 * SHARE, minProceedsMicro: 20 * CREDIT + 1 });
    await expect(refused).rejects.toMatchObject({
      code: "proceeds_below_minimum",
      details: {
        proceedsMicro: 20 * CREDIT,
        minProceedsMicro: 20 * CREDIT + 1,
        quote: { side: "YES", sharesMicro: 50 * SHARE, proceedsMicro: 20 * CREDIT, costMicro: 30 * CREDIT, tradeSequence: 1, quotedAt: core.clock.now().toISOString() },
      },
    });
    await expect(sell(core, TRADER, { sharesMicro: 50 * SHARE, minProceedsMicro: 20 * CREDIT })).resolves.toMatchObject({ result: { proceedsMicro: 20 * CREDIT } });
    // Dust that would return nothing is refused even without a limit.
    await expect(sell(core, TRADER, { sharesMicro: 1 })).rejects.toMatchObject({ code: "proceeds_below_minimum", details: { proceedsMicro: 0 } });
  });

  it("refuses a closed market, a market past its close time and paused trading", async () => {
    const core = await ready();
    core.rules.rules = { ...core.rules.rules, ordersEnabled: false };
    await expect(sell(core, TRADER, { sharesMicro: SHARE })).rejects.toMatchObject({ kind: "unavailable", code: "orders_paused" });
    core.rules.rules = { ...core.rules.rules, ordersEnabled: true, orderAmountMax: 1 };
    // ORDER_AMOUNT_MAX limits credits spent on a buy, not shares sold.
    await expect(sell(core, TRADER, { sharesMicro: 10 * SHARE })).resolves.toMatchObject({ replayed: false });

    core.clock.advanceMs(25 * 3_600_000);
    await expect(sell(core, TRADER, { sharesMicro: SHARE })).rejects.toMatchObject({ code: "market_not_open" });

    const closed = await ready();
    await closed.useCases.recordMarketEvent.execute(marketClosed(closed));
    await expect(sell(closed, TRADER, { sharesMicro: SHARE })).rejects.toMatchObject({ code: "market_not_open" });
    await expect(sell(closed, TRADER, { sharesMicro: SHARE, marketId: "018f3c1e-7a00-7000-8000-000000000999" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("shows the sale in the portfolio, newest first, with its proceeds and the price per share sold", async () => {
    const core = await ready();
    const { result } = await sell(core, TRADER, { sharesMicro: 25 * SHARE });
    const portfolio = await core.useCases.getPortfolio.execute({ actor: trader() });
    expect(portfolio.recentTrades).toEqual([
      { tradeId: result.tradeId, marketId: MARKET_1, kind: "sale", side: "YES", sharesMicro: 25 * SHARE, costMicro: 15 * CREDIT, proceedsMicro: 10 * CREDIT, averagePriceMicro: 400_000, tradeSequence: 2, executedAt: core.clock.now() },
      expect.objectContaining({ kind: "buy", side: "YES", sharesMicro: 100 * SHARE, costMicro: 40 * CREDIT, proceedsMicro: null, averagePriceMicro: 400_000, tradeSequence: 1 }),
    ]);
    expect(portfolio.positions).toEqual([expect.objectContaining({ marketId: MARKET_1, yesMicro: 75 * SHARE, noMicro: 0 })]);
    expect(portfolio.balanceMicro).toBe(470 * CREDIT);
  });
});

describe("settlement after sales", () => {
  it("YES pays the shares still held; every credit is back in a balance", async () => {
    const core = await ready();
    await sell(core, TRADER, { sharesMicro: 50 * SHARE });
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));
    expect(balanceOf(core, TRADER)).toBe((480 + 50) * CREDIT);
    expect(systemValue(core)).toBe(1500 * CREDIT);
    expect(balanceOf(core, CREATOR) + balanceOf(core, TRADER)).toBe(1500 * CREDIT);
    await expectReplayEqual(core);
  });

  it("INVALID refunds the net payment: what the buy cost plus the other side's cost minus the pairs returned", async () => {
    const core = await ready();
    await sell(core, TRADER, { sharesMicro: 50 * SHARE });
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID"));
    // Paid 40 (buy) + 30 (the NO shares of the sale), returned 50 (the pairs): a refund of 20, back to the 500 granted.
    const refunded = core.store.snapshot().tenantData[TENANT_A]?.ledger.find((row) => row.type === "PositionRefunded" && row.streamId === `account:${TRADER}`);
    expect(refunded?.data).toEqual({ marketId: MARKET_1, yesMicro: 50 * SHARE, noMicro: 0, paidMicro: 70 * CREDIT, returnedMicro: 50 * CREDIT, refundMicro: 20 * CREDIT });
    expect(balanceOf(core, TRADER)).toBe(500 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(1000 * CREDIT);
    await expectReplayEqual(core);
  });
});
