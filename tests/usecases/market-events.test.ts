import { describe, expect, it } from "vitest";
import { LedgerConflict } from "../../src/usecases/errors.js";
import { RecordMarketEvent } from "../../src/usecases/record-market-event.js";
import { decision } from "../../src/domain/accounts.js";
import { CREATOR, CREDIT, MARKET_1, MARKET_2, TENANT_A, TENANT_B, TRADER, accountsOf, balanceOf, createCore, expectReplayEqual, fundInput, grant, marketClosed, marketOpened, marketResolved, openMarket, order, systemValue, tenantAdmin, trader, wrapRepositories } from "./core.js";
import type { Core } from "./core.js";

const OTHER = "trader-2";

const stateOf = (core: Core, marketId = MARKET_1, tenantId = TENANT_A) => core.store.snapshot().tenantData[tenantId]?.marketStates.find((market) => market.marketId === marketId);
const ledgerOf = (core: Core) => core.store.snapshot().tenantData[TENANT_A]?.ledger ?? [];
const settledEvents = (core: Core) => core.store.snapshot().outbox.filter((row) => row.type === "si.chance.trading.MarketSettled.v1");
const noPositions = (core: Core) => accountsOf(core).every((account) => Object.keys(account.positions).length === 0);

/** A funded, open market (creator 1000 credits) in which TRADER bought 100 YES shares and OTHER 50 NO shares. */
async function tradedMarket(): Promise<Core> {
  const core = await createCore();
  await openMarket(core);
  await grant(core, TRADER, 200);
  await grant(core, OTHER, 100);
  await order(core, TRADER, { amount: 40 });
  await order(core, OTHER, { side: "NO", amount: 30 });
  return core;
}

describe("RecordMarketEvent: the market copy", () => {
  it("opens the copy, registers the market's tenant and answers duplicate for the same event", async () => {
    const core = await createCore();
    const opened = marketOpened(core);

    expect(await core.useCases.recordMarketEvent.execute(opened)).toBe("applied");
    expect(await core.useCases.recordMarketEvent.execute(opened)).toBe("duplicate");

    expect(stateOf(core)).toMatchObject({
      status: "open",
      version: 1,
      question: "Will the bridge open before 2027?",
      startingPriceMicro: 400_000,
      creatorId: CREATOR,
      fundingMicro: null,
      tradeSequence: 0,
    });
    expect(core.store.snapshot().directory).toEqual({ [MARKET_1]: TENANT_A });
    expect(core.store.snapshot().inbox).toHaveLength(1);
  });

  it("changes the status only for a higher version: a repeat with another event id is stale", async () => {
    const core = await createCore();
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    await core.useCases.recordMarketEvent.execute(marketClosed(core));

    expect(await core.useCases.recordMarketEvent.execute(marketClosed(core))).toBe("stale");
    expect(await core.useCases.recordMarketEvent.execute(marketOpened(core))).toBe("stale");

    expect(stateOf(core)).toMatchObject({ status: "closed", version: 2 });
  });

  it("folds MarketClosed before MarketOpened: the late event only fills the missing facts", async () => {
    const core = await createCore();

    expect(await core.useCases.recordMarketEvent.execute(marketClosed(core))).toBe("applied");
    expect(stateOf(core)).toMatchObject({ status: "closed", version: 2, question: null });
    expect(await core.useCases.recordMarketEvent.execute(marketOpened(core))).toBe("filled");

    expect(stateOf(core)).toMatchObject({ status: "closed", version: 2, question: "Will the bridge open before 2027?", creatorId: CREATOR, startingPriceMicro: 400_000 });
    expect(core.store.snapshot().directory).toEqual({ [MARKET_1]: TENANT_A });
  });

  it("folds MarketResolved before MarketClosed and MarketOpened", async () => {
    const core = await createCore();

    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "NO"))).toBe("settled");
    expect(await core.useCases.recordMarketEvent.execute(marketClosed(core))).toBe("stale");
    expect(await core.useCases.recordMarketEvent.execute(marketOpened(core))).toBe("filled");

    expect(stateOf(core)).toMatchObject({ status: "resolved", outcome: "NO", version: 3, question: "Will the bridge open before 2027?" });
  });

  it("cancels the bot's offers on MarketClosed and keeps the market's holdings", async () => {
    const core = await tradedMarket();
    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders).toHaveLength(1);

    expect(await core.useCases.recordMarketEvent.execute(marketClosed(core))).toBe("applied");

    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders).toEqual([]);
    expect(stateOf(core)).toMatchObject({ status: "closed", settledAt: null });
    expect(balanceOf(core, TRADER)).toBe(160 * CREDIT);
  });

  it("provisions a tenant whose TenantCreated never arrived (the events come from a trusted service)", async () => {
    const core = await createCore({ provision: false });

    expect(await core.useCases.recordMarketEvent.execute(marketOpened(core))).toBe("applied");

    expect(core.store.snapshot().tenants).toEqual([TENANT_A]);
    expect(stateOf(core)).toMatchObject({ status: "open" });
  });

  it("refuses an event for a market that belongs to another tenant, and records nothing", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.fundMarket.execute(fundInput());
    const before = core.store.snapshot();

    await expect(core.useCases.recordMarketEvent.execute(marketOpened(core, { tenantId: TENANT_B }))).rejects.toThrow("registered for another tenant");

    expect(core.store.snapshot()).toEqual(before);
  });

  it("decides again on the locked row when the copy appeared after the read (insert answers false)", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.fundMarket.execute(fundInput());
    let hidden = true;
    const racing = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      marketStates: {
        ...repositories.marketStates,
        find: async (marketId, options) => {
          if (hidden) {
            hidden = false;
            return null;
          }
          return repositories.marketStates.find(marketId, options);
        },
      },
    }));

    expect(await new RecordMarketEvent({ ...core.deps, store: racing }).execute(marketOpened(core))).toBe("applied");

    expect(stateOf(core)).toMatchObject({ status: "open", version: 1, fundingMicro: 1000 * CREDIT });
  });

  it("changes nothing when the concurrent writer already applied the same or a later version", async () => {
    const core = await createCore();
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    const before = stateOf(core);
    let hidden = true;
    const racing = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      marketStates: {
        ...repositories.marketStates,
        find: async (marketId, options) => {
          if (hidden) {
            hidden = false;
            return null;
          }
          return repositories.marketStates.find(marketId, options);
        },
      },
    }));

    expect(await new RecordMarketEvent({ ...core.deps, store: racing }).execute(marketOpened(core))).toBe("stale");

    expect(stateOf(core)).toEqual(before);
  });

  it("fails loudly when the row that made the insert answer false cannot be read again", async () => {
    const core = await createCore();
    await core.useCases.recordMarketEvent.execute(marketOpened(core));
    const racing = wrapRepositories(core.store, (repositories) => ({ ...repositories, marketStates: { ...repositories.marketStates, find: () => Promise.resolve(null) } }));

    await expect(new RecordMarketEvent({ ...core.deps, store: racing }).execute(marketOpened(core, { version: 2 }))).rejects.toThrow("vanished");
  });
});

describe("RecordMarketEvent: settlement (FL-A step 10)", () => {
  it("pays the winners, returns the bot's holdings to the creator and conserves every credit", async () => {
    const core = await tradedMarket();
    const valueBefore = systemValue(core);
    expect(valueBefore).toBe(1300 * CREDIT);
    // The bot account has a positions row like any holder; it is never settled as a user (decideSettlement would refuse it).
    expect(accountsOf(core).find((account) => account.streamId === `bot:${MARKET_1}`)?.positions[MARKET_1]).toEqual({ yesMicro: 900_000_000, noMicro: 950_000_000 });

    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"))).toBe("settled");

    // TRADER's 100 YES shares pay 100 credits, OTHER's NO shares pay nothing; the bot account held 900 YES shares and
    // 70 credits, so the creator gets 970 back.
    expect(balanceOf(core, TRADER)).toBe(260 * CREDIT);
    expect(balanceOf(core, OTHER)).toBe(70 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(970 * CREDIT);
    expect(accountsOf(core).find((account) => account.streamId === `bot:${MARKET_1}`)).toMatchObject({ balanceMicro: 0, positions: {} });
    expect(noPositions(core)).toBe(true);
    expect(systemValue(core)).toBe(valueBefore);
    expect(stateOf(core)).toMatchObject({ status: "resolved", outcome: "YES", settledAt: core.clock.now(), payoutTotalMicro: 100 * CREDIT, returnedMicro: 970 * CREDIT });
    expect(settledEvents(core)).toHaveLength(1);
    expect(settledEvents(core)[0]).toMatchObject({
      subject: `chance.trading.MarketSettled.${TENANT_A}`,
      aggregateId: MARKET_1,
      payload: {
        subject: `market/${MARKET_1}`,
        data: { marketId: MARKET_1, outcome: "YES", creatorId: CREATOR, payoutTotalMicro: 100 * CREDIT, payoutCount: 1, returnedToCreatorMicro: 970 * CREDIT, settledAt: core.clock.now().toISOString() },
      },
    });
    await expectReplayEqual(core);
  });

  it("settles a NO outcome the same way", async () => {
    const core = await tradedMarket();
    const valueBefore = systemValue(core);

    await core.useCases.recordMarketEvent.execute(marketResolved(core, "NO"));

    // OTHER's 50 NO shares pay 50; the bot account held 950 NO shares and 70 credits: 1020 back to the creator.
    expect(balanceOf(core, TRADER)).toBe(160 * CREDIT);
    expect(balanceOf(core, OTHER)).toBe(120 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(1020 * CREDIT);
    expect(systemValue(core)).toBe(valueBefore);
    expect(settledEvents(core)[0]?.payload.data).toMatchObject({ outcome: "NO", payoutTotalMicro: 50 * CREDIT, payoutCount: 1, returnedToCreatorMicro: 1020 * CREDIT });
  });

  it("writes the ledger events on the right streams with the event's meta and the per-market business keys", async () => {
    const core = await tradedMarket();
    const resolved = marketResolved(core, "YES");

    await core.useCases.recordMarketEvent.execute(resolved);

    const settlement = ledgerOf(core).filter((event) => ["BotSettled", "BotHoldingsReturned", "PositionSettled", "HoldingsReturned"].includes(event.type));
    expect(settlement.map((event) => [event.streamId, event.type, event.businessKey])).toEqual([
      [`bot:${MARKET_1}`, "BotSettled", MARKET_1],
      [`bot:${MARKET_1}`, "BotHoldingsReturned", MARKET_1],
      [`account:${CREATOR}`, "HoldingsReturned", MARKET_1],
      [`account:${TRADER}`, "PositionSettled", `${MARKET_1}/account:${TRADER}`],
      [`account:${OTHER}`, "PositionSettled", `${MARKET_1}/account:${OTHER}`],
    ]);
    expect(settlement[0]?.meta).toEqual({ correlationId: "corr-markets", causationId: resolved.eventId, actor: "system" });
  });

  it("settles exactly once: a redelivered event, a repeated version and a later version change no balance", async () => {
    const core = await tradedMarket();
    const resolved = marketResolved(core, "YES");
    await core.useCases.recordMarketEvent.execute(resolved);
    const ledger = ledgerOf(core);
    const accounts = accountsOf(core);

    expect(await core.useCases.recordMarketEvent.execute(resolved)).toBe("duplicate");
    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"))).toBe("stale");
    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES", { version: 4 }))).toBe("stale");

    expect(ledgerOf(core)).toEqual(ledger);
    expect(accountsOf(core)).toEqual(accounts);
    expect(settledEvents(core)).toHaveLength(1);
    expect(stateOf(core)).toMatchObject({ status: "resolved", outcome: "YES", version: 3, settledAt: core.clock.now() });
    expect(core.logger.messages("error")).toEqual([]);
  });

  it("is refused by the ledger's own keys even if the copy forgot that it settled (DM-10)", async () => {
    const core = await tradedMarket();
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));
    const tenant = await core.store.forTenant(TENANT_A);
    const settled = stateOf(core);
    if (!settled || !tenant) throw new Error("a settled market");
    await tenant.transaction((repositories) => repositories.marketStates.update({ ...settled, settledAt: null, payoutTotalMicro: null, returnedMicro: null }));
    const ledger = ledgerOf(core);
    const accounts = accountsOf(core);

    await expect(core.useCases.recordMarketEvent.execute(marketResolved(core, "YES", { version: 4 }))).rejects.toMatchObject({ code: "concurrent_update" });

    expect(ledgerOf(core)).toEqual(ledger);
    expect(accountsOf(core)).toEqual(accounts);
    expect(settledEvents(core)).toHaveLength(1);
  });

  it("returns the whole funding when nobody traded, and publishes zero payouts", async () => {
    const core = await createCore();
    await grant(core, CREATOR, 1000);
    await core.useCases.fundMarket.execute(fundInput());

    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "NO"))).toBe("settled");

    expect(balanceOf(core, CREATOR)).toBe(1000 * CREDIT);
    expect(noPositions(core)).toBe(true);
    expect(settledEvents(core)[0]?.payload.data).toMatchObject({ payoutTotalMicro: 0, payoutCount: 0, returnedToCreatorMicro: 1000 * CREDIT });
    expect(stateOf(core)).toMatchObject({ status: "resolved", settledAt: core.clock.now(), fundingMicro: 1000 * CREDIT });
    await expectReplayEqual(core);
  });

  it("settles a market that trading never saw funded: no ledger event, MarketSettled with zeros", async () => {
    const core = await createCore();

    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES", { marketId: MARKET_2 }))).toBe("settled");

    expect(ledgerOf(core)).toEqual([]);
    expect(stateOf(core, MARKET_2)).toMatchObject({ status: "resolved", settledAt: core.clock.now(), payoutTotalMicro: 0, returnedMicro: 0 });
    expect(settledEvents(core)[0]?.payload.data).toMatchObject({ marketId: MARKET_2, creatorId: CREATOR, payoutTotalMicro: 0, payoutCount: 0, returnedToCreatorMicro: 0 });
  });

  it("settles a creator who also holds a position once: the payout and the return in one decision", async () => {
    const core = await createCore();
    await openMarket(core);
    await grant(core, CREATOR, 100);
    await order(core, CREATOR, { amount: 30 });
    const versionBefore = accountsOf(core).find((account) => account.streamId === `account:${CREATOR}`)?.version ?? 0;
    const valueBefore = systemValue(core);

    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));

    // 75 YES shares pay 75 credits; the bot account held 925 YES shares and 30 credits: 955 come back.
    expect(balanceOf(core, CREATOR)).toBe((100 - 30 + 75 + 955) * CREDIT);
    expect(accountsOf(core).find((account) => account.streamId === `account:${CREATOR}`)?.version).toBe(versionBefore + 2);
    expect(ledgerOf(core).filter((event) => event.streamId === `account:${CREATOR}`).slice(-2).map((event) => event.type)).toEqual(["PositionSettled", "HoldingsReturned"]);
    expect(systemValue(core)).toBe(valueBefore);
    expect(settledEvents(core)[0]?.payload.data).toMatchObject({ payoutTotalMicro: 75 * CREDIT, payoutCount: 1, returnedToCreatorMicro: 955 * CREDIT });
    await expectReplayEqual(core);
  });

  it("pays out in the lock order market copy, bot account, then the holders and the creator by stream id", async () => {
    const core = await tradedMarket();
    const calls: string[] = [];
    const spy = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      marketStates: {
        ...repositories.marketStates,
        find: (marketId, options) => {
          calls.push(`market_state lock=${String(options?.lock)}`);
          return repositories.marketStates.find(marketId, options);
        },
      },
      accounts: {
        ...repositories.accounts,
        load: (streamId, options) => {
          calls.push(`load ${streamId} lock=${String(options?.lock)}`);
          return repositories.accounts.load(streamId, options);
        },
        holdersOf: (marketId, options) => {
          calls.push(`holders lock=${String(options?.lock)} also=${(options?.alsoStreamIds ?? []).join(",")}`);
          return repositories.accounts.holdersOf(marketId, options);
        },
      },
    }));

    await new RecordMarketEvent({ ...core.deps, store: spy }).execute(marketResolved(core, "YES"));

    expect(calls).toEqual(["market_state lock=true", `load bot:${MARKET_1} lock=true`, `holders lock=true also=account:${CREATOR}`]);
  });

  it("settles all or nothing: a failure part-way rolls everything back, and the redelivery settles", async () => {
    const core = await tradedMarket();
    const accounts = accountsOf(core);
    const ledger = ledgerOf(core);
    let appends = 0;
    const failing = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      ledger: {
        ...repositories.ledger,
        append: (request) => {
          appends += 1;
          return appends === 3 ? Promise.reject(new Error("the database went away")) : repositories.ledger.append(request);
        },
      },
    }));
    const resolved = marketResolved(core, "YES");

    await expect(new RecordMarketEvent({ ...core.deps, store: failing }).execute(resolved)).rejects.toThrow("went away");

    expect(accountsOf(core)).toEqual(accounts);
    expect(ledgerOf(core)).toEqual(ledger);
    expect(stateOf(core)).toMatchObject({ status: "open", settledAt: null });
    expect(core.store.snapshot().inbox.some((entry) => entry.eventId === resolved.eventId)).toBe(false);
    expect(core.store.snapshot().tenantData[TENANT_A]?.botOrders).toHaveLength(1);

    expect(await core.useCases.recordMarketEvent.execute(resolved)).toBe("settled");
    expect(balanceOf(core, CREATOR)).toBe(970 * CREDIT);
  });

  it("decides the settlement again after a lost append", async () => {
    const core = await tradedMarket();
    let lost = 1;
    const racing = wrapRepositories(core.store, (repositories) => ({
      ...repositories,
      ledger: {
        ...repositories.ledger,
        append: (request) => {
          if (lost > 0) {
            lost -= 1;
            return Promise.reject(new LedgerConflict("version", request.streamId));
          }
          return repositories.ledger.append(request);
        },
      },
    }));

    expect(await new RecordMarketEvent({ ...core.deps, store: racing }).execute(marketResolved(core, "YES"))).toBe("settled");

    expect(balanceOf(core, CREATOR)).toBe(970 * CREDIT);
    expect(settledEvents(core)).toHaveLength(1);
  });

  it("refuses to trade after the resolution and leaves the paid balances alone", async () => {
    const core = await tradedMarket();
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES"));

    await expect(order(core, TRADER, { amount: 5 })).rejects.toMatchObject({ code: "market_not_open", details: { status: "resolved" } });

    expect(balanceOf(core, TRADER)).toBe(260 * CREDIT);
  });
});

/** The second half of a sale (UC-08, not built yet), as it will be recorded: the trader's pairs redeemed for credits. */
async function redeemPairs(core: Core, userId: string, pairsMicro: number, redemptionId: string): Promise<void> {
  const tenant = await core.store.forTenant(TENANT_A);
  if (!tenant) throw new Error("tenant A is provisioned");
  await tenant.transaction(async (repositories) => {
    const account = await repositories.accounts.load(`account:${userId}`, { lock: true, marketIds: [MARKET_1] });
    if (!account) throw new Error(`${userId} has an account`);
    const step = decision(account, [{ type: "PairsRedeemed", data: { redemptionId, marketId: MARKET_1, pairsMicro } }]);
    await repositories.ledger.append({ streamId: step.streamId, expectedVersion: step.expectedVersion, events: step.events, meta: { correlationId: "c", causationId: "c", actor: userId }, recordedAt: core.clock.now() });
    await repositories.accounts.save(step.next, core.clock.now());
  });
}

describe("RecordMarketEvent: INVALID resolution (UC-16)", () => {
  it("refunds what every trader paid, returns the whole funding to the creator, voids every share and conserves every credit", async () => {
    const core = await tradedMarket();
    const valueBefore = systemValue(core);

    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID"))).toBe("settled");

    // TRADER paid 40 for its YES shares, OTHER 30 for its NO shares: both back where they started; the creator gets the
    // 1000 credits of funding back, although the bot account held 70 credits and shares of both sides.
    expect(balanceOf(core, TRADER)).toBe(200 * CREDIT);
    expect(balanceOf(core, OTHER)).toBe(100 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(1000 * CREDIT);
    expect(accountsOf(core).find((account) => account.streamId === `bot:${MARKET_1}`)).toMatchObject({ balanceMicro: 0, positions: {} });
    expect(noPositions(core)).toBe(true);
    expect(systemValue(core)).toBe(valueBefore);
    expect(stateOf(core)).toMatchObject({ status: "resolved", outcome: "INVALID", settledAt: core.clock.now(), payoutTotalMicro: 70 * CREDIT, returnedMicro: 1000 * CREDIT });
    expect(settledEvents(core)).toHaveLength(1);
    expect(settledEvents(core)[0]?.payload.data).toEqual({
      marketId: MARKET_1,
      outcome: "INVALID",
      creatorId: CREATOR,
      payoutTotalMicro: 70 * CREDIT,
      payoutCount: 2,
      returnedToCreatorMicro: 1000 * CREDIT,
      settledAt: core.clock.now().toISOString(),
    });
    const settlement = ledgerOf(core).filter((event) => ["BotVoided", "BotHoldingsReturned", "PositionRefunded", "HoldingsReturned"].includes(event.type));
    expect(settlement.map((event) => [event.streamId, event.type, event.businessKey])).toEqual([
      [`bot:${MARKET_1}`, "BotVoided", MARKET_1],
      [`bot:${MARKET_1}`, "BotHoldingsReturned", MARKET_1],
      [`account:${CREATOR}`, "HoldingsReturned", MARKET_1],
      [`account:${TRADER}`, "PositionRefunded", `${MARKET_1}/account:${TRADER}`],
      [`account:${OTHER}`, "PositionRefunded", `${MARKET_1}/account:${OTHER}`],
    ]);
    expect(settlement[0]?.data).toEqual({ marketId: MARKET_1, yesMicro: 900_000_000, noMicro: 950_000_000, releasedMicro: 1000 * CREDIT, refundedMicro: 70 * CREDIT });
    await expectReplayEqual(core);
  });

  it("refunds a trader who sold net of what the sale returned, finds it in the ledger although it holds nothing, and shows the refund", async () => {
    const core = await createCore();
    await openMarket(core);
    await grant(core, TRADER, 200);
    await grant(core, OTHER, 200);
    // OTHER buys 100 NO at 0.60, TRADER 100 YES at 0.40, OTHER 100 YES at 0.45, and OTHER redeems its 100 pairs: it sold
    // at a loss, paid 105 and got 100 back, and holds nothing.
    await order(core, OTHER, { side: "NO", amount: 60 });
    await order(core, TRADER, { amount: 40 });
    await order(core, OTHER, { amount: 45 });
    await redeemPairs(core, OTHER, 100 * CREDIT, "redemption-1");
    expect(accountsOf(core).find((account) => account.streamId === `account:${OTHER}`)?.positions).toEqual({});
    const valueBefore = systemValue(core);
    await core.useCases.recordMarketEvent.execute(marketClosed(core));

    await core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID"));

    expect(balanceOf(core, OTHER)).toBe(200 * CREDIT);
    expect(balanceOf(core, TRADER)).toBe(200 * CREDIT);
    expect(balanceOf(core, CREATOR)).toBe(1000 * CREDIT);
    expect(systemValue(core)).toBe(valueBefore);
    expect(noPositions(core)).toBe(true);
    expect(ledgerOf(core).find((event) => event.type === "PositionRefunded" && event.streamId === `account:${OTHER}`)?.data).toEqual({
      marketId: MARKET_1,
      yesMicro: 0,
      noMicro: 0,
      paidMicro: 105 * CREDIT,
      returnedMicro: 100 * CREDIT,
      refundMicro: 5 * CREDIT,
    });
    expect(settledEvents(core)[0]?.payload.data).toMatchObject({ outcome: "INVALID", payoutTotalMicro: 45 * CREDIT, payoutCount: 2, returnedToCreatorMicro: 1000 * CREDIT });
    await expectReplayEqual(core);

    const portfolio = await core.useCases.getPortfolio.execute({ actor: trader(OTHER) });
    expect(portfolio.positions).toEqual([]);
    expect(portfolio.payouts).toEqual([{ marketId: MARKET_1, kind: "refund", amountMicro: 5 * CREDIT, outcome: "INVALID", paidAt: core.clock.now() }]);
    const creator = await core.useCases.getPortfolio.execute({ actor: tenantAdmin(CREATOR) });
    expect(creator.payouts).toEqual([{ marketId: MARKET_1, kind: "returned", amountMicro: 1000 * CREDIT, outcome: null, paidAt: core.clock.now() }]);
    expect(creator.fundedMarkets).toEqual([expect.objectContaining({ marketId: MARKET_1, fundingMicro: 1000 * CREDIT, returnedMicro: 1000 * CREDIT })]);
  });

  it("settles INVALID exactly once: a redelivery, a repeat, a later version or a forgotten settledAt change nothing", async () => {
    const core = await tradedMarket();
    const resolved = marketResolved(core, "INVALID");
    await core.useCases.recordMarketEvent.execute(resolved);
    const ledger = ledgerOf(core);
    const accounts = accountsOf(core);

    expect(await core.useCases.recordMarketEvent.execute(resolved)).toBe("duplicate");
    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID"))).toBe("stale");
    // markets resolves a market once (DM-19): a later MarketResolved with another outcome is a contract violation. The
    // copy keeps the outcome the ledger settled, and the contradiction is logged as an error.
    const settledAt = stateOf(core)?.settledAt;
    core.clock.advanceMs(60_000);
    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "YES", { version: 4 }))).toBe("stale");
    expect(stateOf(core)).toMatchObject({ status: "resolved", outcome: "INVALID", version: 3, settledAt });
    expect(core.logger.lines.filter((line) => line.level === "error")).toEqual([
      expect.objectContaining({
        message: "A MarketResolved contradicts the market's outcome; ignored",
        fields: expect.objectContaining({ marketId: MARKET_1, storedOutcome: "INVALID", eventOutcome: "YES", eventVersion: 4, storedVersion: 3 }),
      }),
    ]);
    expect(ledgerOf(core)).toEqual(ledger);
    expect(accountsOf(core)).toEqual(accounts);

    // Even with settledAt cleared, a second refund is refused: the decision sees that the market no longer holds what
    // entered it (the conservation check), and the ledger's keys (BotVoided per market, PositionRefunded per market and
    // owner) would refuse its events anyway (DM-10).
    const tenant = await core.store.forTenant(TENANT_A);
    const settled = stateOf(core);
    if (!settled || !tenant) throw new Error("a settled market");
    await tenant.transaction((repositories) => repositories.marketStates.update({ ...settled, settledAt: null, payoutTotalMicro: null, returnedMicro: null }));
    await expect(core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID", { version: 5 }))).rejects.toThrow(/invariant_violated/);
    const again = tenant.transaction((repositories) =>
      repositories.ledger.append({
        streamId: `bot:${MARKET_1}`,
        expectedVersion: ledger.filter((event) => event.streamId === `bot:${MARKET_1}`).length,
        events: [{ type: "BotVoided", data: { marketId: MARKET_1, yesMicro: 0, noMicro: 0, releasedMicro: 0, refundedMicro: 0 } }],
        meta: { correlationId: "c", causationId: "c", actor: "system" },
        recordedAt: core.clock.now(),
      }),
    );
    await expect(again).rejects.toBeInstanceOf(LedgerConflict);
    expect(ledgerOf(core)).toEqual(ledger);
    expect(accountsOf(core)).toEqual(accounts);
    expect(settledEvents(core)).toHaveLength(1);
  });

  it("returns the whole funding when nobody traded, and settles a market trading never funded with zeros", async () => {
    const core = await createCore();
    await openMarket(core);
    await core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID"));
    expect(balanceOf(core, CREATOR)).toBe(1000 * CREDIT);
    expect(settledEvents(core)[0]?.payload.data).toMatchObject({ outcome: "INVALID", payoutTotalMicro: 0, payoutCount: 0, returnedToCreatorMicro: 1000 * CREDIT });

    expect(await core.useCases.recordMarketEvent.execute(marketResolved(core, "INVALID", { marketId: MARKET_2 }))).toBe("settled");
    expect(ledgerOf(core).filter((event) => (event.data as { marketId?: string }).marketId === MARKET_2)).toEqual([]);
    expect(settledEvents(core)[1]?.payload.data).toMatchObject({ marketId: MARKET_2, outcome: "INVALID", payoutTotalMicro: 0, payoutCount: 0, returnedToCreatorMicro: 0 });
    await expectReplayEqual(core);
  });
});
