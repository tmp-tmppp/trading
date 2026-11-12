import { describe, expect, it } from "vitest";
import { averagePriceMicro } from "../../src/domain/units.js";
import { LedgerConflict } from "../../src/usecases/errors.js";
import { PlaceOrder } from "../../src/usecases/place-order.js";
import { CREATOR, CREDIT, MARKET_1, TENANT_A, TENANT_B, TRADER, accountsOf, balanceOf, createCore, expectReplayEqual, fundInput, grant, marketClosed, marketOpened, marketResolved, openMarket, order, putOffers, systemValue, tenantAdmin, trader, wrapRepositories } from "./core.js";
import type { Core } from "./core.js";

const OTHER = "trader-2";

/** A market funded with 1000 credits and quoted with the default book, and a trader with 500 credits. */
async function ready(): Promise<Core> {
  const core = await createCore();
  await openMarket(core);
  await grant(core, TRADER, 500);
  return core;
}

const marketOf = (core: Core) => core.store.snapshot().tenantData[TENANT_A]?.marketStates.find((market) => market.marketId === MARKET_1);
const botOf = (core: Core) => accountsOf(core).find((account) => account.streamId === `bot:${MARKET_1}`);
const tradeEvents = (core: Core) => core.store.snapshot().outbox.filter((row) => row.type === "si.chance.trading.TradeExecuted.v1");

describe("GetQuote", () => {
  it("plans a buy from the cheapest offer without changing anything", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    const quote = await core.useCases.getQuote.execute({ actor: trader(), marketId: MARKET_1, side: "YES", amount: 20 });

    expect(quote).toEqual({
      marketId: MARKET_1,
      side: "YES",
      amount: 20,
      sharesMicro: 50_000_000,
      costMicro: 20 * CREDIT,
      averagePriceMicro: 400_000,
      worstPriceMicro: 400_000,
      fills: [{ priceMicro: 400_000, sharesMicro: 50_000_000, costMicro: 20 * CREDIT }],
      tradeSequence: 0,
      quotedAt: core.clock.now(),
    });
    expect(core.store.snapshot()).toEqual(before);
  });

  it("walks up the levels, quotes the NO side from its own offers and answers a tenant admin too", async () => {
    const core = await ready();

    const yes = await core.useCases.getQuote.execute({ actor: tenantAdmin(), marketId: MARKET_1, side: "YES", amount: 60 });
    const no = await core.useCases.getQuote.execute({ actor: trader(), marketId: MARKET_1, side: "NO", amount: 30 });

    expect(yes.fills).toEqual([
      { priceMicro: 400_000, sharesMicro: 100_000_000, costMicro: 40 * CREDIT },
      { priceMicro: 450_000, sharesMicro: 44_444_444, costMicro: 20 * CREDIT },
    ]);
    expect(yes).toMatchObject({ sharesMicro: 144_444_444, costMicro: 60 * CREDIT, worstPriceMicro: 450_000, averagePriceMicro: averagePriceMicro(60 * CREDIT, 144_444_444) });
    expect(no).toMatchObject({ side: "NO", sharesMicro: 50_000_000, costMicro: 30 * CREDIT, averagePriceMicro: 600_000 });
  });

  it("is fill or kill: more than the offers hold answers the largest amount they can absorb", async () => {
    const core = await ready();

    await expect(core.useCases.getQuote.execute({ actor: trader(), marketId: MARKET_1, side: "YES", amount: 131 })).rejects.toMatchObject({
      kind: "conflict",
      code: "insufficient_liquidity",
      details: { maxAmount: 130 },
    });
    expect(await core.useCases.getQuote.execute({ actor: trader(), marketId: MARKET_1, side: "YES", amount: 130 })).toMatchObject({ costMicro: 130 * CREDIT });
  });

  it("refuses bad input, an unknown market, another tenant's market and an unregistered tenant", async () => {
    const core = await ready();
    const quote = (input: { marketId?: string; side?: string; amount?: number }, tenantId = TENANT_A) =>
      core.useCases.getQuote.execute({ actor: trader(TRADER, tenantId), marketId: MARKET_1, side: "YES", amount: 10, ...input });

    await expect(quote({ marketId: "x" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "marketId" }] });
    await expect(quote({ side: "MAYBE" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "side" }] });
    await expect(quote({ amount: 0 })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "amount" }] });
    await expect(quote({ marketId: "018f3c1e-7a00-7000-8000-000000000999" })).rejects.toMatchObject({ kind: "not_found" });
    await expect(quote({}, TENANT_B)).rejects.toMatchObject({ kind: "not_found" });
    await expect(quote({}, "018f3c1e-7a00-7000-8000-0000000000cc")).rejects.toMatchObject({ kind: "unavailable", code: "tenant_not_ready" });
  });

  it("refuses a market that is funded but not open, closed, resolved, or past its close time (409 market_not_open)", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.fundMarket.execute(fundInput());
    const quote = () => core.useCases.getQuote.execute({ actor: trader(), marketId: MARKET_1, side: "YES", amount: 10 });

    await expect(quote()).rejects.toMatchObject({ kind: "conflict", code: "market_not_open", details: { status: "funded" } });
    await core.useCases.recordMarketEvent.execute(marketOpened(core, { closeTime: new Date(core.clock.now().getTime() + 3_600_000) }));
    await putOffers(core, MARKET_1, [{ side: "YES", priceMicro: 500_000, sharesMicro: 100_000_000 }]);
    expect(await quote()).toMatchObject({ costMicro: 10 * CREDIT });

    core.clock.advanceMs(3_600_000);
    await expect(quote()).rejects.toMatchObject({ code: "market_not_open" });
  });
});

describe("PlaceOrder: a buy", () => {
  it("spends exactly the amount, moves shares and credits, advances the sequence and publishes TradeExecuted", async () => {
    const core = await ready();
    const valueBefore = systemValue(core);

    const placed = await order(core, TRADER, { amount: 20, key: "order-key-1" });

    expect(placed.replayed).toBe(false);
    expect(placed.result).toMatchObject({
      marketId: MARKET_1,
      side: "YES",
      amount: 20,
      sharesMicro: 50_000_000,
      costMicro: 20 * CREDIT,
      averagePriceMicro: 400_000,
      worstPriceMicro: 400_000,
      fills: [{ priceMicro: 400_000, sharesMicro: 50_000_000, costMicro: 20 * CREDIT }],
      tradeSequence: 1,
      executedAt: core.clock.now(),
      balanceMicro: 480 * CREDIT,
      position: { marketId: MARKET_1, yesMicro: 50_000_000, noMicro: 0 },
    });
    expect(balanceOf(core, TRADER)).toBe(480 * CREDIT);
    expect(botOf(core)).toMatchObject({ balanceMicro: 20 * CREDIT, positions: { [MARKET_1]: { yesMicro: 950_000_000, noMicro: 1000 * CREDIT } } });
    expect(accountsOf(core).find((account) => account.streamId === `account:${TRADER}`)?.positions).toEqual({ [MARKET_1]: { yesMicro: 50_000_000, noMicro: 0 } });
    expect(marketOf(core)?.tradeSequence).toBe(1);
    expect(systemValue(core)).toBe(valueBefore);
    const book = core.store.snapshot().tenantData[TENANT_A]?.botOrders[0];
    expect(book?.offers).toEqual([
      { side: "YES", priceMicro: 400_000, sharesMicro: 50_000_000 },
      { side: "YES", priceMicro: 450_000, sharesMicro: 200_000_000 },
      { side: "NO", priceMicro: 600_000, sharesMicro: 100_000_000 },
      { side: "NO", priceMicro: 650_000, sharesMicro: 200_000_000 },
    ]);
    expect(book?.pricedOnSequence).toBe(0);
    expect(tradeEvents(core)).toHaveLength(1);
    expect(tradeEvents(core)[0]).toMatchObject({
      subject: `chance.trading.TradeExecuted.${TENANT_A}`,
      aggregateId: MARKET_1,
      payload: {
        subject: `market/${MARKET_1}`,
        correlationid: `corr-${TRADER}`,
        causationid: `req-${TRADER}`,
        data: {
          tradeId: placed.result.tradeId,
          marketId: MARKET_1,
          userId: TRADER,
          side: "YES",
          sharesMicro: 50_000_000,
          costMicro: 20 * CREDIT,
          averagePriceMicro: 400_000,
          lastPriceMicro: 400_000,
          yesPriceMicro: 400_000,
          tradeSequence: 1,
          executedAt: core.clock.now().toISOString(),
        },
      },
    });
    await expectReplayEqual(core);
  });

  it("writes one SharesBought and one BotSharesSold with the user's meta and contiguous versions", async () => {
    const core = await ready();

    const first = await order(core, TRADER, { amount: 10 });
    const second = await order(core, TRADER, { amount: 10 });

    const ledger = core.store.snapshot().tenantData[TENANT_A]?.ledger ?? [];
    const mine = ledger.filter((event) => event.streamId === `account:${TRADER}`);
    expect(mine.map((event) => [event.type, event.version])).toEqual([["CreditsGranted", 1], ["SharesBought", 2], ["SharesBought", 3]]);
    expect(mine[1]).toMatchObject({ businessKey: first.result.tradeId, meta: { actor: TRADER, correlationId: `corr-${TRADER}`, causationId: `req-${TRADER}` } });
    const bot = ledger.filter((event) => event.streamId === `bot:${MARKET_1}`);
    expect(bot.map((event) => [event.type, event.version])).toEqual([["BotFunded", 1], ["BotSharesSold", 2], ["BotSharesSold", 3]]);
    expect(bot[2]).toMatchObject({ businessKey: second.result.tradeId, data: { pairsCreatedMicro: 0, tradeSequence: 2 } });
    expect(second.result.tradeSequence).toBe(2);
  });

  it("walks up the levels, spends exactly the amount and removes an emptied level", async () => {
    const core = await ready();
    const valueBefore = systemValue(core);

    const { result } = await order(core, TRADER, { amount: 60 });

    expect(result.fills).toEqual([
      { priceMicro: 400_000, sharesMicro: 100_000_000, costMicro: 40 * CREDIT },
      { priceMicro: 450_000, sharesMicro: 44_444_444, costMicro: 20 * CREDIT },
    ]);
    expect(result).toMatchObject({ sharesMicro: 144_444_444, costMicro: 60 * CREDIT, worstPriceMicro: 450_000, balanceMicro: 440 * CREDIT });
    expect(botOf(core)).toMatchObject({ balanceMicro: 60 * CREDIT, positions: { [MARKET_1]: { yesMicro: 855_555_556, noMicro: 1000 * CREDIT } } });
    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders[0]?.offers.filter((offer) => offer.side === "YES")).toEqual([{ side: "YES", priceMicro: 450_000, sharesMicro: 155_555_556 }]);
    expect(systemValue(core)).toBe(valueBefore);
  });

  it("buys NO from the NO offers and publishes the YES-equivalent price", async () => {
    const core = await ready();

    const { result } = await order(core, TRADER, { side: "NO", amount: 30 });

    expect(result).toMatchObject({ side: "NO", sharesMicro: 50_000_000, costMicro: 30 * CREDIT, position: { yesMicro: 0, noMicro: 50_000_000 } });
    expect(botOf(core)?.positions[MARKET_1]).toEqual({ yesMicro: 1000 * CREDIT, noMicro: 950_000_000 });
    expect(tradeEvents(core)[0]?.payload.data).toMatchObject({ side: "NO", lastPriceMicro: 600_000, yesPriceMicro: 400_000 });
  });

  it("takes the whole book when the amount equals what the offers hold", async () => {
    const core = await ready();
    await grant(core, TRADER, 500);

    const { result } = await order(core, TRADER, { amount: 130 });

    expect(result.costMicro).toBe(130 * CREDIT);
    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders[0]?.offers.map((offer) => offer.side)).toEqual(["NO", "NO"]);
  });

  it("creates the pairs the bot lacks from its credits, so no state goes below zero", async () => {
    const core = await createCore();
    await openMarket(core, { credits: 100, offers: [{ side: "YES", priceMicro: 500_000, sharesMicro: 100 * CREDIT }, { side: "NO", priceMicro: 500_000, sharesMicro: 100 * CREDIT }] });
    await grant(core, TRADER, 100);
    await grant(core, OTHER, 100);
    const valueBefore = systemValue(core);

    await order(core, TRADER, { amount: 50 });
    expect(botOf(core)).toMatchObject({ balanceMicro: 50 * CREDIT, positions: { [MARKET_1]: { yesMicro: 0, noMicro: 100 * CREDIT } } });
    // Each credit can become a pair, so the bot may now offer YES shares it does not hold: 50 credits back 50 shares.
    await putOffers(core, MARKET_1, [{ side: "YES", priceMicro: 500_000, sharesMicro: 50 * CREDIT }, { side: "NO", priceMicro: 500_000, sharesMicro: 100 * CREDIT }]);
    await order(core, OTHER, { amount: 25 });

    expect(botOf(core)).toMatchObject({ balanceMicro: 25 * CREDIT, positions: { [MARKET_1]: { yesMicro: 0, noMicro: 150 * CREDIT } } });
    const sold = core.store.snapshot().tenantData[TENANT_A]?.ledger.filter((event) => event.type === "BotSharesSold");
    expect(sold?.map((event) => (event.type === "BotSharesSold" ? event.data.pairsCreatedMicro : -1))).toEqual([0, 50 * CREDIT]);
    expect(accountsOf(core).find((account) => account.streamId === `account:${OTHER}`)?.positions).toEqual({ [MARKET_1]: { yesMicro: 50 * CREDIT, noMicro: 0 } });
    expect(systemValue(core)).toBe(valueBefore);
    await expectReplayEqual(core);
  });

  it("is fill or kill: nothing changes and no key is stored when the offers cannot absorb the amount", async () => {
    const core = await ready();
    await grant(core, TRADER, 500);
    const before = core.store.snapshot();

    await expect(order(core, TRADER, { amount: 131, key: "too-much-key" })).rejects.toMatchObject({ kind: "conflict", code: "insufficient_liquidity", details: { maxAmount: 130 } });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("refuses a buy above the balance with the amount that is withdrawable, and changes nothing", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    await expect(order(core, TRADER, { amount: 501 })).rejects.toMatchObject({ kind: "conflict", code: "insufficient_credits", details: { withdrawableCredits: 500 } });
    await expect(order(core, "nobody", { amount: 5 })).rejects.toMatchObject({ code: "insufficient_credits", details: { withdrawableCredits: 0 } });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("never sells one offer twice when two orders race for it", async () => {
    const core = await createCore();
    await openMarket(core, { offers: [{ side: "YES", priceMicro: 400_000, sharesMicro: 100_000_000 }, { side: "NO", priceMicro: 600_000, sharesMicro: 100_000_000 }] });
    await grant(core, TRADER, 100);
    await grant(core, OTHER, 100);

    const results = await Promise.allSettled([order(core, TRADER, { amount: 30 }), order(core, OTHER, { amount: 30 })]);

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "insufficient_liquidity", details: { maxAmount: 10 } } });
    expect(marketOf(core)?.tradeSequence).toBe(1);
    expect(balanceOf(core, OTHER)).toBe(100 * CREDIT);
  });
});

describe("PlaceOrder: DM-18 price protection", () => {
  it("refuses with a fresh quote when the average price would be above the limit, and stores no key", async () => {
    const core = await ready();
    const before = core.store.snapshot();
    const average = averagePriceMicro(60 * CREDIT, 144_444_444) ?? 0;

    const refused = order(core, TRADER, { amount: 60, key: "limit-key-1", maxAveragePriceMicro: 400_000 });

    await expect(refused).rejects.toMatchObject({
      kind: "conflict",
      code: "price_limit_exceeded",
      details: {
        averagePriceMicro: average,
        maxAveragePriceMicro: 400_000,
        quote: { marketId: MARKET_1, side: "YES", amount: 60, sharesMicro: 144_444_444, costMicro: 60 * CREDIT, tradeSequence: 0, quotedAt: core.clock.now().toISOString() },
      },
    });
    expect(core.store.snapshot()).toEqual(before);
    // The key was not stored, so the same key may be used again with a limit that holds.
    expect(await order(core, TRADER, { amount: 60, key: "limit-key-1", maxAveragePriceMicro: 450_000 })).toMatchObject({ replayed: false });
  });

  it("compares exactly: a limit equal to the average passes, one below it fails", async () => {
    const core = await ready();
    const average = averagePriceMicro(60 * CREDIT, 144_444_444) ?? 0;

    await expect(order(core, TRADER, { amount: 60, maxAveragePriceMicro: average - 1 })).rejects.toMatchObject({ code: "price_limit_exceeded" });
    expect(await order(core, TRADER, { amount: 60, maxAveragePriceMicro: average })).toMatchObject({ replayed: false });
  });
});

describe("PlaceOrder: idempotency (REL-03)", () => {
  it("answers a repeat of the key with the stored result (replayed) and buys once", async () => {
    const core = await ready();
    const first = await order(core, TRADER, { amount: 20, key: "repeat-key-1" });
    const before = core.store.snapshot();
    core.clock.advanceMs(60_000);

    const again = await order(core, TRADER, { amount: 20, key: "repeat-key-1" });

    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(again.result.executedAt).toBeInstanceOf(Date);
    expect(core.store.snapshot()).toEqual(before);
    expect(tradeEvents(core)).toHaveLength(1);
  });

  it("still replays after the market moved on, because another trade came between", async () => {
    const core = await ready();
    await grant(core, OTHER, 100);
    const first = await order(core, TRADER, { amount: 20, key: "repeat-key-2" });
    await order(core, OTHER, { amount: 20 });

    const again = await order(core, TRADER, { amount: 20, key: "repeat-key-2" });

    expect(again).toEqual({ result: first.result, replayed: true });
    expect(marketOf(core)?.tradeSequence).toBe(2);
  });

  it("answers a completed key even after ORDER_AMOUNT_MAX was lowered or orders were paused", async () => {
    const core = await ready();
    const first = await order(core, TRADER, { amount: 20, key: "repeat-key-3" });
    core.rules.rules = { ...core.rules.rules, orderAmountMax: 5, ordersEnabled: false };

    const again = await order(core, TRADER, { amount: 20, key: "repeat-key-3" });

    expect(again).toEqual({ result: first.result, replayed: true });
    // A new key meets the rules.
    await expect(order(core, TRADER, { amount: 20, key: "new-key-123" })).rejects.toMatchObject({ code: "orders_paused" });
  });

  it("refuses the same key with another market, side, amount or limit (422), but not another user's key", async () => {
    const core = await ready();
    await grant(core, OTHER, 100);
    await order(core, TRADER, { amount: 20, key: "shared-key-1" });
    const before = core.store.snapshot();

    await expect(order(core, TRADER, { amount: 21, key: "shared-key-1" })).rejects.toMatchObject({ kind: "unprocessable", code: "idempotency_key_reused" });
    await expect(order(core, TRADER, { amount: 20, side: "NO", key: "shared-key-1" })).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(order(core, TRADER, { amount: 20, key: "shared-key-1", maxAveragePriceMicro: 900_000 })).rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(order(core, TRADER, { amount: 20, key: "shared-key-1", marketId: "018f3c1e-7a00-7000-8000-000000000999" })).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(core.store.snapshot()).toEqual(before);

    expect(await order(core, OTHER, { amount: 20, key: "shared-key-1" })).toMatchObject({ replayed: false });
  });

  it("leaves no key behind when the order is refused, so the same key can be used after a deposit", async () => {
    const core = await createCore();
    await openMarket(core);

    await expect(order(core, TRADER, { amount: 30, key: "retry-key-001" })).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(core.store.snapshot().tenantData[TENANT_A]?.idempotency.filter((row) => row.scope.startsWith("order:"))).toEqual([]);
    await grant(core, TRADER, 100);

    expect(await order(core, TRADER, { amount: 30, key: "retry-key-001" })).toMatchObject({ replayed: false, result: { balanceMicro: 70 * CREDIT } });
    expect(core.store.snapshot().tenantData[TENANT_A]?.idempotency.filter((row) => row.scope.startsWith("order:"))).toEqual([
      expect.objectContaining({ scope: `order:${TRADER}`, key: "retry-key-001", result: expect.objectContaining({ costMicro: 30 * CREDIT }) as unknown }),
    ]);
  });

  it("requires a well-formed key", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    for (const key of [undefined, "short", "has a space in it", "k".repeat(129)]) {
      await expect(core.useCases.placeOrder.execute({ actor: trader(), idempotencyKey: key, marketId: MARKET_1, side: "YES", amount: 5 })).rejects.toMatchObject({
        kind: "validation",
        fields: [{ field: "Idempotency-Key" }],
      });
    }

    expect(core.store.snapshot()).toEqual(before);
  });
});

describe("PlaceOrder: runtime rules, roles and the market", () => {
  it("pauses new orders with ORDERS_ENABLED=false (503) and takes them again when it is switched on", async () => {
    const core = await ready();
    core.rules.rules = { ...core.rules.rules, ordersEnabled: false };

    await expect(order(core, TRADER, { amount: 5, key: "paused-key-1" })).rejects.toMatchObject({ kind: "unavailable", code: "orders_paused", retryAfterSeconds: 30 });
    core.rules.rules = { ...core.rules.rules, ordersEnabled: true };

    expect(await order(core, TRADER, { amount: 5, key: "paused-key-1" })).toMatchObject({ replayed: false });
  });

  it("refuses an amount above ORDER_AMOUNT_MAX (400 on field amount) and takes the maximum itself", async () => {
    const core = await ready();
    core.rules.rules = { ...core.rules.rules, orderAmountMax: 10 };
    const before = core.store.snapshot();

    await expect(order(core, TRADER, { amount: 11 })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "amount" }] });
    expect(core.store.snapshot()).toEqual(before);

    expect(await order(core, TRADER, { amount: 10 })).toMatchObject({ replayed: false });
  });

  it("refuses a tenant admin (403), also before any other check", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    await expect(core.useCases.placeOrder.execute({ actor: tenantAdmin(), idempotencyKey: undefined, marketId: "not-a-uuid", side: "?", amount: 0 })).rejects.toMatchObject({ kind: "forbidden" });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("validates the shape of the order", async () => {
    const core = await ready();
    const place = (input: { marketId?: string; side?: string; amount?: number; maxAveragePriceMicro?: number }) =>
      core.useCases.placeOrder.execute({ actor: trader(), idempotencyKey: "shape-key-123", marketId: MARKET_1, side: "YES", amount: 5, ...input });

    await expect(place({ marketId: "x" })).rejects.toMatchObject({ fields: [{ field: "marketId" }] });
    await expect(place({ side: "MAYBE" })).rejects.toMatchObject({ fields: [{ field: "side" }] });
    await expect(place({ amount: 0 })).rejects.toMatchObject({ fields: [{ field: "amount" }] });
    await expect(place({ amount: 1.5 })).rejects.toMatchObject({ fields: [{ field: "amount" }] });
    await expect(place({ amount: 1_000_001 })).rejects.toMatchObject({ fields: [{ field: "amount" }] });
    await expect(place({ maxAveragePriceMicro: 0 })).rejects.toMatchObject({ fields: [{ field: "maxAveragePriceMicro" }] });
    await expect(place({ maxAveragePriceMicro: 1_000_000 })).rejects.toMatchObject({ fields: [{ field: "maxAveragePriceMicro" }] });
    await expect(place({ maxAveragePriceMicro: 400_000.5 })).rejects.toMatchObject({ fields: [{ field: "maxAveragePriceMicro" }] });
  });

  it("answers 404 for an unknown market and for another tenant's market, and 503 for an unregistered tenant", async () => {
    const core = await ready();

    await expect(order(core, TRADER, { amount: 5, marketId: "018f3c1e-7a00-7000-8000-000000000999" })).rejects.toMatchObject({ kind: "not_found" });
    await expect(order(core, TRADER, { amount: 5 }, TENANT_B)).rejects.toMatchObject({ kind: "not_found" });
    await expect(order(core, TRADER, { amount: 5 }, "018f3c1e-7a00-7000-8000-0000000000cc")).rejects.toMatchObject({ kind: "unavailable", code: "tenant_not_ready" });
  });

  it("refuses a market that is funded but not open yet, then trades once MarketOpened arrived", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await grant(core, TRADER, 100);
    await core.useCases.fundMarket.execute(fundInput());
    // The market maker's offers may rest on a funded copy (PUT accepts them), orders wait for "open".
    await putOffers(core, MARKET_1, [{ side: "YES", priceMicro: 500_000, sharesMicro: 100_000_000 }]);

    await expect(order(core, TRADER, { amount: 10 })).rejects.toMatchObject({ kind: "conflict", code: "market_not_open", details: { status: "funded" } });
    await core.useCases.recordMarketEvent.execute(marketOpened(core));

    expect(await order(core, TRADER, { amount: 10 })).toMatchObject({ replayed: false, result: { sharesMicro: 20_000_000 } });
  });

  it("refuses a market that is open but not funded (MarketOpened came first)", async () => {
    const core = await createCore();
    await grant(core, TRADER, 100);
    await core.useCases.recordMarketEvent.execute(marketOpened(core));

    await expect(order(core, TRADER, { amount: 10 })).rejects.toMatchObject({ code: "market_not_open", message: "The market is not funded yet" });
  });

  it("refuses a closed market, a resolved market and a market past its close time", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    core.clock.advanceMs(25 * 3_600_000);
    await expect(order(core, TRADER, { amount: 5 })).rejects.toMatchObject({ code: "market_not_open", message: "The market is past its close time" });
    core.clock.advanceMs(-25 * 3_600_000);
    await core.useCases.recordMarketEvent.execute(marketClosed(core));
    await expect(order(core, TRADER, { amount: 5 })).rejects.toMatchObject({ code: "market_not_open", details: { status: "closed" } });
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));
    await expect(order(core, TRADER, { amount: 5 })).rejects.toMatchObject({ code: "market_not_open", details: { status: "resolved" } });

    expect(tradeEvents(core)).toEqual([]);
    expect(before.tenantData[TENANT_A]?.botOrders).toHaveLength(1);
    // MarketClosed cancelled the offers.
    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders).toEqual([]);
  });

  it("answers insufficient liquidity for a market whose book is empty", async () => {
    const core = await createCore();
    await openMarket(core, { offers: [] });
    await grant(core, TRADER, 100);

    await expect(order(core, TRADER, { amount: 5 })).rejects.toMatchObject({ code: "insufficient_liquidity", details: { maxAmount: 0 } });
  });

  it("fails when the funded market has no bot account (corrupt data) instead of selling", async () => {
    const core = await ready();
    const tenant = await core.store.forTenant(TENANT_A);
    await tenant?.transaction(async (repositories) => {
      await repositories.accounts.clear();
    });

    await expect(order(core, TRADER, { amount: 5 })).rejects.toMatchObject({ code: "market_not_open", message: "The market has no bot account yet" });
  });
});

describe("PlaceOrder: the trade time is read after the row locks", () => {
  /** An order whose locked reads wait: the clock moves while it queues for the market row or the trader's account. */
  const queued = (core: Core, waits: { marketMs?: number; traderMs?: number }) => {
    const store = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      marketStates: {
        ...repositories.marketStates,
        find: (marketId, options) => {
          if (options?.lock === true) core.clock.advanceMs(waits.marketMs ?? 0);
          return repositories.marketStates.find(marketId, options);
        },
      },
      accounts: {
        ...repositories.accounts,
        load: (streamId, options) => {
          if (options?.lock === true && streamId === `account:${TRADER}`) core.clock.advanceMs(waits.traderMs ?? 0);
          return repositories.accounts.load(streamId, options);
        },
      },
    }));
    return new PlaceOrder({ ...core.deps, store, rules: core.rules });
  };
  const input = { actor: trader(), idempotencyKey: "queued-key-123", marketId: MARKET_1, side: "YES", amount: 20 };
  const DAY_MS = 25 * 3_600_000;

  it("stamps the trade, its ledger events and its outbox row with the time at which the locks were held", async () => {
    const core = await ready();
    const started = core.clock.now();

    const placed = await queued(core, { marketMs: 600, traderMs: 100 }).execute(input);

    const at = new Date(started.getTime() + 700);
    expect(placed.result.executedAt).toEqual(at);
    expect(tradeEvents(core).map((row) => row.createdAt)).toEqual([at]);
    expect((core.store.snapshot().tenantData[TENANT_A]?.ledger ?? []).slice(-2).map((event) => event.recordedAt)).toEqual([at, at]);
    expect(marketOf(core)?.updatedAt).toEqual(at);
  });

  it("refuses an order that reached the market row only after the stored close time", async () => {
    const core = await ready();

    await expect(queued(core, { marketMs: DAY_MS }).execute(input)).rejects.toMatchObject({ code: "market_not_open", message: "The market is past its close time" });

    expect(tradeEvents(core)).toEqual([]);
    expect(marketOf(core)?.tradeSequence).toBe(0);
    expect(balanceOf(core, TRADER)).toBe(500 * CREDIT);
  });

  it("refuses an order whose wait for the trader's account ran past the stored close time, and keeps no key", async () => {
    const core = await ready();

    await expect(queued(core, { traderMs: DAY_MS }).execute(input)).rejects.toMatchObject({ code: "market_not_open", message: "The market is past its close time" });

    expect(tradeEvents(core)).toEqual([]);
    expect((core.store.snapshot().tenantData[TENANT_A]?.idempotency ?? []).map((row) => row.key)).not.toContain(input.idempotencyKey);
    expect(balanceOf(core, TRADER)).toBe(500 * CREDIT);
  });
});

describe("PlaceOrder: lost races", () => {
  const conflicting = (core: Core, times: number) => {
    let left = times;
    const store = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      ledger: {
        ...repositories.ledger,
        append: (request) => {
          if (left > 0) {
            left -= 1;
            return Promise.reject(new LedgerConflict("version", request.streamId));
          }
          return repositories.ledger.append(request);
        },
      },
    }));
    return new PlaceOrder({ ...core.deps, store, rules: core.rules });
  };
  const input = { actor: trader(), idempotencyKey: "race-key-123", marketId: MARKET_1, side: "YES", amount: 20 };

  it("decides the whole order again after a lost append and buys exactly once", async () => {
    const core = await ready();

    const placed = await conflicting(core, 1).execute(input);

    expect(placed.replayed).toBe(false);
    expect(marketOf(core)?.tradeSequence).toBe(1);
    expect(tradeEvents(core)).toHaveLength(1);
    expect(balanceOf(core, TRADER)).toBe(480 * CREDIT);
    await expectReplayEqual(core);
  });

  it("answers 503 concurrent_update when the accounts keep changing, with nothing bought", async () => {
    const core = await ready();
    const before = core.store.snapshot();

    await expect(conflicting(core, 99).execute(input)).rejects.toMatchObject({ kind: "unavailable", code: "concurrent_update", retryAfterSeconds: 1 });

    expect(core.store.snapshot()).toEqual(before);
  });
});
