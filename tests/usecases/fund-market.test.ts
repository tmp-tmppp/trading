import { describe, expect, it } from "vitest";
import { FundMarket } from "../../src/usecases/fund-market.js";
import { serviceCaller } from "../support/fakes.js";
import { CREATOR, CREDIT, MARKET_1, MARKET_2, TENANT_A, TENANT_B, accountsOf, balanceOf, createCore, expectReplayEqual, fundInput, grant, marketClosed, marketOpened, marketResolved, systemValue, wrapRepositories } from "./core.js";

describe("FundMarket", () => {
  it("turns the creator's credits into pairs of the market's bot account and publishes MarketFunded", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1500);
    const valueBefore = systemValue(core);

    const result = await core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000));

    expect(result).toEqual({ funding: { marketId: MARKET_1, amount: 1000, fundedAt: core.clock.now() }, created: true });
    const accounts = accountsOf(core);
    expect(accounts.find((account) => account.streamId === `account:${CREATOR}`)).toMatchObject({ balanceMicro: 500 * CREDIT, version: 2 });
    expect(accounts.find((account) => account.streamId === `bot:${MARKET_1}`)).toMatchObject({
      kind: "bot",
      ownerId: CREATOR,
      balanceMicro: 0,
      positions: { [MARKET_1]: { yesMicro: 1000 * CREDIT, noMicro: 1000 * CREDIT } },
      version: 1,
    });
    expect(systemValue(core)).toBe(valueBefore);
    const state = core.store.snapshot();
    expect(state.directory).toEqual({ [MARKET_1]: TENANT_A });
    expect(state.tenantData[TENANT_A]?.marketStates).toEqual([
      expect.objectContaining({ marketId: MARKET_1, status: "funded", version: 0, creatorId: CREATOR, fundingMicro: 1000 * CREDIT, tradeSequence: 0, question: null }),
    ]);
    // The bot account is appended first (lock order), then the creator's.
    expect(state.tenantData[TENANT_A]?.ledger.filter((event) => event.type === "MarketFundingPaid" || event.type === "BotFunded")).toEqual([
      expect.objectContaining({ streamId: `bot:${MARKET_1}`, type: "BotFunded", businessKey: MARKET_1 }),
      expect.objectContaining({ streamId: `account:${CREATOR}`, type: "MarketFundingPaid", businessKey: MARKET_1, meta: { correlationId: "corr-markets", causationId: "req-markets", actor: "client:markets" } }),
    ]);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({
      subject: `chance.trading.MarketFunded.${TENANT_A}`,
      type: "si.chance.trading.MarketFunded.v1",
      aggregateId: MARKET_1,
      payload: { subject: `market/${MARKET_1}`, tenantid: TENANT_A, data: { marketId: MARKET_1, creatorId: CREATOR, amount: 1000, fundedAt: core.clock.now().toISOString() } },
    });
    await expectReplayEqual(core);
  });

  it("answers a repeat of the same key from the stored result and changes nothing (200)", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    const first = await core.useCases.fundMarket.execute(fundInput());
    const before = core.store.snapshot();
    core.clock.advanceMs(5000);

    const again = await core.useCases.fundMarket.execute(fundInput());

    expect(again).toEqual({ funding: first.funding, created: false });
    expect(core.store.snapshot()).toEqual(before);
  });

  it("refuses the same key with another request (422), another creator and another tenant", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 2000);
    await grant(core, CREATOR, 2000, TENANT_B);
    await core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000));
    const before = core.store.snapshot();

    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_1, 900))).rejects.toMatchObject({ kind: "unprocessable", code: "idempotency_key_reused" });
    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000, { tenantId: TENANT_B }))).rejects.toMatchObject({ kind: "unprocessable", code: "idempotency_key_reused", message: "The market belongs to another tenant" });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("refuses to fund a market that MarketOpened attributed to another creator", async () => {
    const core = await createCore();
    await grant(core, "admin-2", 1000);
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    const before = core.store.snapshot();

    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000, { creatorId: "admin-2" }))).rejects.toMatchObject({ code: "idempotency_key_reused", message: "The market was opened by another creator" });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("answers insufficient credits (409), stores nothing under the key, and funds when the same call is made with credits", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 400);
    const before = core.store.snapshot();

    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000))).rejects.toMatchObject({ kind: "conflict", code: "insufficient_credits", details: { withdrawableCredits: 400 } });
    expect(core.store.snapshot()).toEqual(before);
    expect(core.store.snapshot().tenantData[TENANT_A]?.marketStates).toEqual([]);
    expect(core.store.snapshot().directory).toEqual({});

    await grant(core, CREATOR, 700);
    expect(await core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000))).toMatchObject({ created: true });
    expect(balanceOf(core, CREATOR)).toBe(100 * CREDIT);
  });

  it("treats a creator without an account as a balance of zero", async () => {
    const core = await createCore();

    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_1, 100, { creatorId: "nobody" }))).rejects.toMatchObject({ code: "insufficient_credits" });
  });

  it("works in both orders of arrival: funding first, MarketOpened second", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);

    await core.useCases.fundMarket.execute(fundInput());
    expect(await core.useCases.recordMarketEvent.execute(marketOpened(core))).toBe("applied");

    expect(core.store.snapshot().tenantData[TENANT_A]?.marketStates[0]).toMatchObject({ status: "open", version: 1, fundingMicro: 1000 * CREDIT, creatorId: CREATOR, question: "Will the bridge open before 2027?" });
  });

  it("works in both orders of arrival: MarketOpened first, funding second (the status stays open)", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    expect(core.store.snapshot().tenantData[TENANT_A]?.marketStates[0]).toMatchObject({ status: "open", fundingMicro: null });

    const result = await core.useCases.fundMarket.execute(fundInput());

    expect(result.created).toBe(true);
    expect(core.store.snapshot().tenantData[TENANT_A]?.marketStates[0]).toMatchObject({ status: "open", version: 1, fundingMicro: 1000 * CREDIT, fundedAt: core.clock.now() });
    expect(systemValue(core)).toBe(1000 * CREDIT);
  });

  it("decides again on the locked row when a concurrent MarketOpened created the copy after the read (insert answers false)", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    let hidden = true;
    const racing = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      marketStates: {
        ...repositories.marketStates,
        // The first read does not see the row that exists, as if it had been inserted a moment later.
        find: async (marketId, options) => {
          if (hidden) {
            hidden = false;
            return null;
          }
          return repositories.marketStates.find(marketId, options);
        },
      },
    }));

    const result = await new FundMarket({ ...core.deps, store: racing }).execute(fundInput());

    expect(result.created).toBe(true);
    expect(core.store.snapshot().tenantData[TENANT_A]?.marketStates[0]).toMatchObject({ status: "open", version: 1, fundingMicro: 1000 * CREDIT });
  });

  it("fails loudly when the row that made the insert answer false cannot be read again", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    const racing = wrapRepositories(core.store, (repositories) => ({ ...repositories, marketStates: { ...repositories.marketStates, find: () => Promise.resolve(null) } }));

    await expect(new FundMarket({ ...core.deps, store: racing }).execute(fundInput())).rejects.toThrow("vanished");
  });

  it("refuses a market that is closed or resolved (409 market_closed) and leaves nothing behind", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 2000);
    await core.useCases.recordMarketEvent.execute(marketClosed(core));
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES", { marketId: MARKET_2 }));
    const before = core.store.snapshot();

    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_1, 1000))).rejects.toMatchObject({ kind: "conflict", code: "market_closed" });
    await expect(core.useCases.fundMarket.execute(fundInput(MARKET_2, 1000))).rejects.toMatchObject({ kind: "conflict", code: "market_closed" });

    expect(core.store.snapshot()).toEqual(before);
    expect(balanceOf(core, CREATOR)).toBe(2000 * CREDIT);
  });

  it("provisions a tenant whose TenantCreated never arrived (the funding call comes from a trusted service)", async () => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.fundMarket.execute(fundInput())).rejects.toMatchObject({ code: "insufficient_credits" });

    expect(core.store.snapshot().tenants).toEqual([TENANT_A]);
    await grant(core, CREATOR, 1000);
    expect(await core.useCases.fundMarket.execute(fundInput())).toMatchObject({ created: true });
  });

  it("validates the key and the body before it touches any data", async () => {
    const core = await createCore();
    const before = core.store.snapshot();
    const fund = (input: ReturnType<typeof fundInput>) => core.useCases.fundMarket.execute(input);

    await expect(fund(fundInput(MARKET_1, 1000, { idempotencyKey: undefined }))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "Idempotency-Key" }] });
    await expect(fund(fundInput(MARKET_1, 1000, { idempotencyKey: "another-key-123" }))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "Idempotency-Key" }] });
    await expect(fund({ ...fundInput(), marketId: "nope", idempotencyKey: "nope" })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "marketId" }] });
    await expect(fund(fundInput(MARKET_1, 1000, { tenantId: "tenant" }))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "tenantId" }] });
    await expect(fund(fundInput(MARKET_1, 1000, { creatorId: "" }))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "creatorId" }] });
    await expect(fund(fundInput(MARKET_1, 0))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "amount" }] });
    await expect(fund(fundInput(MARKET_1, 1_000_001))).rejects.toMatchObject({ kind: "validation", fields: [{ field: "amount" }] });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("accepts the market id in upper case as the key and answers with the normalised id", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 100);

    const result = await core.useCases.fundMarket.execute({ ...fundInput(MARKET_1, 100), marketId: MARKET_1.toUpperCase(), idempotencyKey: MARKET_1.toUpperCase(), caller: serviceCaller("markets") });

    expect(result.funding.marketId).toBe(MARKET_1);
  });
});
