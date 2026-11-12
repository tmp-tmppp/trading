import { describe, expect, it } from "vitest";
import { ListOpenMarkets } from "../../src/usecases/list-open-markets.js";
import type { Store } from "../../src/usecases/ports.js";
import { ReplaceBotOrders } from "../../src/usecases/replace-bot-orders.js";
import { decodeMarketCursor, encodeMarketCursor } from "../../src/usecases/support.js";
import { serviceCaller } from "../support/fakes.js";
import { CREATOR, CREDIT, DEFAULT_OFFERS, MARKET_1, MARKET_2, TENANT_A, TENANT_B, TRADER, createCore, fundInput, grant, marketClosed, marketOpened, marketResolved, openMarket, order, putOffers, wrapRepositories } from "./core.js";

const MARKET_3 = "018f3c1e-7a00-7000-8000-000000000103";
const caller = serviceCaller("market-maker");
const bookOf = (core: Awaited<ReturnType<typeof createCore>>, marketId = MARKET_1) => core.useCases.getBotBook.execute({ caller, marketId });
const replace = (core: Awaited<ReturnType<typeof createCore>>, basedOnSequence: number, offers: unknown, marketId = MARKET_1) =>
  core.useCases.replaceBotOrders.execute({ caller, marketId, basedOnSequence, offers });

describe("GetBotBook", () => {
  it("shows the bot account's holdings, the offers and both sequences", async () => {
    const core = await createCore();
    await openMarket(core);
    await grant(core, TRADER, 100);

    expect(await bookOf(core)).toEqual({
      market: {
        marketId: MARKET_1,
        tenantId: TENANT_A,
        status: "open",
        version: 1,
        closeTime: new Date(core.clock.now().getTime() + 24 * 3_600_000),
        startingPriceMicro: 400_000,
        fundingMicro: 1000 * CREDIT,
        tradeSequence: 0,
      },
      holdings: { balanceMicro: 0, yesMicro: 1000 * CREDIT, noMicro: 1000 * CREDIT },
      offers: DEFAULT_OFFERS,
      tradeSequence: 0,
      offersPricedOnSequence: 0,
      maxOffersPerSide: 10,
    });

    await order(core, TRADER, { amount: 20 });
    // A fill keeps the sequence the offers were priced on; the PUT must send the market's own sequence.
    expect(await bookOf(core)).toMatchObject({ tradeSequence: 1, offersPricedOnSequence: 0, holdings: { balanceMicro: 20 * CREDIT, yesMicro: 950_000_000, noMicro: 1000 * CREDIT } });
  });

  it("reports the runtime MAX_OFFERS_PER_SIDE in force on every read, and the PUT answer carries the limit it applied", async () => {
    const core = await createCore();
    await openMarket(core);

    expect(await bookOf(core)).toMatchObject({ maxOffersPerSide: 10 });
    core.rules.rules = { ...core.rules.rules, maxOffersPerSide: 3 };
    expect(await bookOf(core)).toMatchObject({ maxOffersPerSide: 3 });
    expect(await replace(core, 0, DEFAULT_OFFERS)).toMatchObject({ maxOffersPerSide: 3 });
    core.rules.rules = { ...core.rules.rules, maxOffersPerSide: 50 };
    expect(await bookOf(core)).toMatchObject({ maxOffersPerSide: 50 });
  });

  it("reports no offers and no priced sequence for a market with an empty book, and zero holdings before funding", async () => {
    const core = await createCore();
    await core.useCases.recordMarketEvent.execute(marketOpened(core));

    expect(await bookOf(core)).toMatchObject({ holdings: { balanceMicro: 0, yesMicro: 0, noMicro: 0 }, offers: [], offersPricedOnSequence: null, market: { fundingMicro: null } });
  });

  it("answers 404 for an unknown market and rejects a malformed id", async () => {
    const core = await createCore();

    await expect(bookOf(core, MARKET_2)).rejects.toMatchObject({ kind: "not_found" });
    await expect(bookOf(core, "x")).rejects.toMatchObject({ kind: "validation", fields: [{ field: "marketId" }] });
  });

  it("answers 404 when the directory names the market but the tenant holds no copy of it", async () => {
    const core = await createCore();
    await core.store.repositories.marketDirectory.register(MARKET_3, TENANT_A, core.clock.now());

    await expect(bookOf(core, MARKET_3)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("ReplaceBotOrders", () => {
  it("replaces the whole book, sorted, priced on the market's sequence, without touching the ledger", async () => {
    const core = await createCore();
    await openMarket(core);
    const ledgerBefore = core.store.snapshot().tenantData[TENANT_A]?.ledger;

    const book = await replace(core, 0, [
      { side: "NO", priceMicro: 700_000, sharesMicro: 10_000_000 },
      { side: "YES", priceMicro: 350_000, sharesMicro: 20_000_000 },
      { side: "YES", priceMicro: 300_000, sharesMicro: 30_000_000 },
    ]);

    expect(book.offers).toEqual([
      { side: "YES", priceMicro: 300_000, sharesMicro: 30_000_000 },
      { side: "YES", priceMicro: 350_000, sharesMicro: 20_000_000 },
      { side: "NO", priceMicro: 700_000, sharesMicro: 10_000_000 },
    ]);
    expect(book).toMatchObject({ tradeSequence: 0, offersPricedOnSequence: 0, holdings: { yesMicro: 1000 * CREDIT } });
    expect(core.store.snapshot().tenantData[TENANT_A]?.ledger).toEqual(ledgerBefore);
  });

  it("answers an empty list by cancelling every offer", async () => {
    const core = await createCore();
    await openMarket(core);

    const book = await replace(core, 0, []);

    expect(book).toMatchObject({ offers: [], offersPricedOnSequence: null });
    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders).toEqual([]);
  });

  it("refuses a stale sequence (409) and takes the market's own sequence after a trade, not the one the offers were priced on", async () => {
    const core = await createCore();
    await openMarket(core);
    await grant(core, TRADER, 100);
    await order(core, TRADER, { amount: 20 });
    const current = await bookOf(core);

    await expect(replace(core, current.offersPricedOnSequence ?? -1, DEFAULT_OFFERS)).rejects.toMatchObject({ kind: "conflict", code: "stale_sequence", details: { tradeSequence: 1 } });
    await expect(replace(core, 2, DEFAULT_OFFERS)).rejects.toMatchObject({ code: "stale_sequence", details: { tradeSequence: 1 } });

    expect(await replace(core, current.tradeSequence, DEFAULT_OFFERS)).toMatchObject({ offersPricedOnSequence: 1 });
  });

  it("checks the close time with a reading taken after the market row was granted", async () => {
    const core = await createCore();
    await openMarket(core, { closeTime: new Date(core.clock.now().getTime() + 3_600_000) });
    const store = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      marketStates: {
        ...repositories.marketStates,
        find: (id, options) => {
          // The queue for the row (orders, a settlement) outlasts the close time.
          if (options?.lock === true) core.clock.advanceMs(2 * 3_600_000);
          return repositories.marketStates.find(id, options);
        },
      },
    }));
    const slow = new ReplaceBotOrders({ ...core.deps, store, rules: core.rules });

    await expect(slow.execute({ caller, marketId: MARKET_1, basedOnSequence: 0, offers: DEFAULT_OFFERS })).rejects.toMatchObject({ code: "market_not_open", message: "The market is past its close time" });
  });

  it("is accepted on a funded copy (before MarketOpened), while an order there is refused", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await grant(core, TRADER, 50);
    await core.useCases.fundMarket.execute(fundInput());

    expect(await putOffers(core, MARKET_1, DEFAULT_OFFERS)).toMatchObject({ market: { status: "funded" }, offersPricedOnSequence: 0 });
    await expect(order(core, TRADER, { amount: 10 })).rejects.toMatchObject({ code: "market_not_open" });
  });

  it("refuses an unfunded copy, a closed one, a resolved one and one past its close time (409 market_not_open)", async () => {
    const core = await createCore();
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    await expect(replace(core, 0, [])).rejects.toMatchObject({ kind: "conflict", code: "market_not_open", message: "The market is not funded yet" });

    const funded = await createCore();
    await openMarket(funded, { closeTime: new Date(funded.clock.now().getTime() + 3_600_000) });
    funded.clock.advanceMs(3_600_000);
    await expect(replace(funded, 0, [])).rejects.toMatchObject({ code: "market_not_open", message: "The market is past its close time" });
    funded.clock.advanceMs(-3_600_000);
    await funded.useCases.recordMarketEvent.execute(marketClosed(funded));
    await expect(replace(funded, 0, DEFAULT_OFFERS)).rejects.toMatchObject({ code: "market_not_open", details: { status: "closed" } });
    await funded.useCases.recordMarketEvent.execute(marketResolved(funded, "NO"));
    await expect(replace(funded, 0, DEFAULT_OFFERS)).rejects.toMatchObject({ code: "market_not_open", details: { status: "resolved" } });
  });

  it("refuses offers the bot account cannot back (409 insufficient_holdings) and backs them with its credits", async () => {
    const core = await createCore();
    await openMarket(core, { credits: 100, offers: [{ side: "YES", priceMicro: 500_000, sharesMicro: 100 * CREDIT }, { side: "NO", priceMicro: 500_000, sharesMicro: 100 * CREDIT }] });
    await grant(core, TRADER, 100);
    await expect(replace(core, 0, [{ side: "YES", priceMicro: 500_000, sharesMicro: 100 * CREDIT + 1 }])).rejects.toMatchObject({
      kind: "conflict",
      code: "insufficient_holdings",
      details: { side: "YES", offeredMicro: 100 * CREDIT + 1, availableMicro: 100 * CREDIT },
    });
    await order(core, TRADER, { amount: 50 });

    // 50 credits of the bot account can become 50 more pairs: YES it no longer holds is backed by them.
    expect(await replace(core, 1, [{ side: "YES", priceMicro: 500_000, sharesMicro: 50 * CREDIT }])).toMatchObject({ offers: [{ side: "YES" }] });
    await expect(replace(core, 1, [{ side: "YES", priceMicro: 500_000, sharesMicro: 50 * CREDIT + 1 }])).rejects.toMatchObject({ code: "insufficient_holdings" });
  });

  it("refuses crossed offers, offers off the grid, repeated prices and too many offers per side (400)", async () => {
    const core = await createCore();
    await openMarket(core);
    core.rules.rules = { ...core.rules.rules, maxOffersPerSide: 2 };
    const yes = (priceMicro: number) => ({ side: "YES", priceMicro, sharesMicro: 1_000_000 });

    await expect(replace(core, 0, [yes(400_000), { side: "NO", priceMicro: 590_000, sharesMicro: 1_000_000 }])).rejects.toMatchObject({ kind: "validation", code: "crossed_offers" });
    await expect(replace(core, 0, [yes(405_000)])).rejects.toMatchObject({ kind: "validation", fields: [{ field: "offers[0].priceMicro" }] });
    await expect(replace(core, 0, [yes(400_000), yes(400_000)])).rejects.toMatchObject({ kind: "validation", fields: [{ field: "offers[1]" }] });
    await expect(replace(core, 0, [yes(300_000), yes(310_000), yes(320_000)])).rejects.toMatchObject({ kind: "validation", fields: [{ field: "offers" }] });
    await expect(replace(core, 0, "nope")).rejects.toMatchObject({ kind: "validation", fields: [{ field: "offers" }] });
    expect(await replace(core, 0, [yes(300_000), yes(310_000)])).toMatchObject({ offers: [{ priceMicro: 300_000 }, { priceMicro: 310_000 }] });
  });

  it("validates the sequence and the market", async () => {
    const core = await createCore();
    await openMarket(core);

    await expect(replace(core, -1, [])).rejects.toMatchObject({ kind: "validation", fields: [{ field: "basedOnSequence" }] });
    await expect(replace(core, 1.5, [])).rejects.toMatchObject({ kind: "validation", fields: [{ field: "basedOnSequence" }] });
    await expect(replace(core, 0, [], "x")).rejects.toMatchObject({ kind: "validation", fields: [{ field: "marketId" }] });
    await expect(replace(core, 0, [], MARKET_2)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("fails when the funded copy has no bot account (corrupt data)", async () => {
    const core = await createCore();
    await openMarket(core);
    const tenant = await core.store.forTenant(TENANT_A);
    await tenant?.transaction(async (repositories) => {
      await repositories.accounts.clear();
    });

    await expect(replace(core, 0, [])).rejects.toMatchObject({ code: "market_not_open", message: "The market has no bot account yet" });
  });

  it("fails with not found when the directory names a market whose copy is gone", async () => {
    const core = await createCore();
    await core.store.repositories.marketDirectory.register(MARKET_3, TENANT_A, core.clock.now());

    await expect(replace(core, 0, [], MARKET_3)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("ListOpenMarkets", () => {
  const list = (core: Awaited<ReturnType<typeof createCore>>, input: { limit?: number; cursor?: string } = {}) => core.useCases.listOpenMarkets.execute({ caller, ...input });

  async function threeMarkets() {
    const core = await createCore();
    await openMarket(core, { marketId: MARKET_1, offers: [] });
    await openMarket(core, { marketId: MARKET_2, offers: [], creatorId: "admin-2" });
    await openMarket(core, { marketId: MARKET_3, offers: [], tenantId: TENANT_B });
    return core;
  }

  it("lists the open markets of every tenant by tenant id and market id", async () => {
    const core = await threeMarkets();

    const page = await list(core);

    expect(page.items.map((item) => [item.tenantId, item.marketId])).toEqual([[TENANT_A, MARKET_1], [TENANT_A, MARKET_2], [TENANT_B, MARKET_3]]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      marketId: MARKET_1,
      tenantId: TENANT_A,
      status: "open",
      version: 1,
      closeTime: new Date(core.clock.now().getTime() + 24 * 3_600_000),
      startingPriceMicro: 400_000,
      fundingMicro: 1000 * CREDIT,
      tradeSequence: 0,
    });
  });

  it("leaves out markets that are funded only, closed or resolved", async () => {
    const core = await threeMarkets();
    await grant(core, "admin-3", 100);
    await core.useCases.fundMarket.execute(fundInput("018f3c1e-7a00-7000-8000-000000000104", 100, { creatorId: "admin-3" }));
    await core.useCases.recordMarketEvent.execute(marketClosed(core, { marketId: MARKET_1 }));
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES", { marketId: MARKET_2 }));

    expect((await list(core)).items.map((item) => item.marketId)).toEqual([MARKET_3]);
  });

  it("pages with an opaque cursor that continues after the last item, across tenants", async () => {
    const core = await threeMarkets();

    const first = await list(core, { limit: 2 });
    expect(first.items.map((item) => item.marketId)).toEqual([MARKET_1, MARKET_2]);
    expect(first.nextCursor).toBe(encodeMarketCursor({ tenantId: TENANT_A, marketId: MARKET_2 }));
    const second = await list(core, { limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
    expect(second.items.map((item) => item.marketId)).toEqual([MARKET_3]);
    expect(second.nextCursor).toBeNull();

    const single = await list(core, { limit: 1 });
    expect(single.items.map((item) => item.marketId)).toEqual([MARKET_1]);
    const next = await list(core, { limit: 1, ...(single.nextCursor ? { cursor: single.nextCursor } : {}) });
    expect(next.items.map((item) => item.marketId)).toEqual([MARKET_2]);
    const exact = await list(core, { limit: 3 });
    expect(exact.nextCursor).toBeNull();
  });

  it("is empty without markets and refuses a bad limit or cursor (400)", async () => {
    const core = await createCore();

    expect(await list(core)).toEqual({ items: [], nextCursor: null });
    await expect(list(core, { limit: 0 })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "limit" }] });
    await expect(list(core, { limit: 501 })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "limit" }] });
    await expect(list(core, { cursor: "not-a-cursor" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "cursor" }] });
    expect(decodeMarketCursor(encodeMarketCursor({ tenantId: TENANT_A, marketId: MARKET_1 }))).toEqual({ tenantId: TENANT_A, marketId: MARKET_1 });
  });

  it("skips a tenant of the registry that has no store", async () => {
    const core = await threeMarkets();
    const stub = { repositories: core.store.repositories, forTenant: (tenantId: string) => (tenantId === TENANT_B ? Promise.resolve(null) : core.store.forTenant(tenantId)) } as unknown as Store;

    const page = await new ListOpenMarkets(stub).execute({ caller });

    expect(page.items.map((item) => item.marketId)).toEqual([MARKET_1, MARKET_2]);
  });
});
