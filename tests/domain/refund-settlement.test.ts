import { describe, expect, it } from "vitest";
import { decideDeposit, decideFunding, decision } from "../../src/domain/accounts.js";
import type { StreamDecision } from "../../src/domain/accounts.js";
import { DomainError } from "../../src/domain/errors.js";
import { botStreamId, emptyBotAccount, emptyUserAccount, holdingOf, nonEmptyPositions, replayStream, userStreamId } from "../../src/domain/ledger.js";
import type { AccountState, LedgerEvent } from "../../src/domain/ledger.js";
import { decideBuy, liquidityMicro } from "../../src/domain/order-book.js";
import type { Offer } from "../../src/domain/order-book.js";
import { decideRefundSettlement } from "../../src/domain/settlement.js";
import type { MarketPayment, RefundSettlementDecision } from "../../src/domain/settlement.js";
import { MAX_PRICE_MICRO, MIN_PRICE_MICRO, PRICE_STEP_MICRO } from "../../src/domain/units.js";
import type { Side } from "../../src/domain/units.js";
import { CREATOR, MARKET_1, TRADER } from "../support/fakes.js";

const CREDIT = 1_000_000;
const SHARE = 1_000_000;

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
}

/**
 * A small ledger of one market: the state and the events of every stream, and each trader's payments summed from its
 * events exactly as LedgerRepository.marketPayments sums them (SharesBought costs, PairsRedeemed pairs).
 */
class Ledger {
  readonly states = new Map<string, AccountState>();
  readonly events = new Map<string, LedgerEvent[]>();
  deposited = 0;
  funding = 0;
  sales = 0;
  private sequence = 0;
  bot: AccountState = emptyBotAccount(MARKET_1);

  constructor(fundingCredits: number) {
    this.deposit(CREATOR, fundingCredits);
    const funded = decideFunding(this.user(CREATOR), this.bot, { marketId: MARKET_1, creatorId: CREATOR, credits: fundingCredits });
    this.apply(funded.creator);
    this.apply(funded.bot);
    this.funding = funded.amountMicro;
  }

  user(userId: string): AccountState {
    return this.states.get(userStreamId(userId)) ?? emptyUserAccount(userId);
  }

  apply(step: StreamDecision): void {
    this.events.set(step.streamId, [...(this.events.get(step.streamId) ?? []), ...step.events]);
    this.states.set(step.streamId, step.next);
    if (step.streamId === botStreamId(MARKET_1)) this.bot = step.next;
  }

  deposit(userId: string, credits: number): void {
    this.apply(decideDeposit(this.user(userId), { depositId: `d-${String((this.sequence += 1))}`, credits }));
    this.deposited += credits * CREDIT;
  }

  /** A buy through the domain's own decision; false when the book or the balance refuses it. */
  buy(userId: string, side: Side, credits: number, offers: readonly Offer[]): boolean {
    try {
      this.sequence += 1;
      const bought = decideBuy({ trader: this.user(userId), bot: this.bot, marketId: MARKET_1, side, credits, maxAveragePriceMicro: null, offers, tradeId: `t-${String(this.sequence)}`, tradeSequence: this.sequence });
      this.apply(bought.trader);
      this.apply(bought.bot);
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code !== "invariant_violated") return false;
      throw error;
    }
  }

  /** The second half of a sale (UC-08): the trader's pairs back into credits, one microcredit per pair. */
  redeem(userId: string, pairsMicro: number): void {
    if (pairsMicro <= 0) return;
    this.sequence += 1;
    this.apply(decision(this.user(userId), [{ type: "PairsRedeemed", data: { redemptionId: `r-${String(this.sequence)}`, marketId: MARKET_1, pairsMicro } }]));
    this.sales += 1;
  }

  payments(): MarketPayment[] {
    const result: MarketPayment[] = [];
    for (const [streamId, events] of [...this.events].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!streamId.startsWith("account:")) continue;
      let paidMicro = 0;
      let returnedMicro = 0;
      for (const event of events) {
        if (event.type === "SharesBought" && event.data.marketId === MARKET_1) paidMicro += event.data.costMicro;
        if (event.type === "PairsRedeemed" && event.data.marketId === MARKET_1) returnedMicro += event.data.pairsMicro;
      }
      if (paidMicro > 0 || returnedMicro > 0) result.push({ streamId, paidMicro, returnedMicro });
    }
    return result;
  }

  users(): AccountState[] {
    return [...this.states.values()].filter((state) => state.kind === "user");
  }

  settle(): RefundSettlementDecision {
    return decideRefundSettlement({ marketId: MARKET_1, creatorId: CREATOR, fundingMicro: this.funding, bot: this.bot, accounts: this.users(), payments: this.payments() });
  }

  balances(): number {
    let sum = 0;
    for (const state of this.states.values()) sum += state.balanceMicro;
    return sum;
  }
}

const nets = (payments: readonly MarketPayment[]) => new Map(payments.map((payment) => [payment.streamId, payment.paidMicro - payment.returnedMicro]));

describe("decideRefundSettlement (UC-16, INVALID)", () => {
  it("refunds what every trader paid, gives the creator the funding back to the microcredit and voids every share", () => {
    const ledger = new Ledger(30);
    ledger.deposit(TRADER, 100);
    ledger.deposit("trader-2", 100);
    const offers: Offer[] = [
      { side: "YES", priceMicro: 550_000, sharesMicro: 30 * SHARE },
      { side: "NO", priceMicro: 480_000, sharesMicro: 30 * SHARE },
    ];
    expect(ledger.buy(TRADER, "YES", 13, offers)).toBe(true);
    expect(ledger.buy("trader-2", "NO", 9, offers)).toBe(true);

    const settlement = ledger.settle();
    for (const step of settlement.decisions) ledger.apply(step);

    expect(ledger.user(TRADER).balanceMicro).toBe(100 * CREDIT);
    expect(ledger.user("trader-2").balanceMicro).toBe(100 * CREDIT);
    expect(ledger.user(CREATOR).balanceMicro).toBe(30 * CREDIT);
    expect(ledger.bot.balanceMicro).toBe(0);
    for (const state of ledger.states.values()) expect(nonEmptyPositions(state)).toEqual({});
    expect(ledger.balances()).toBe(ledger.deposited);
    expect(settlement.summary).toMatchObject({ payoutTotalMicro: 22 * CREDIT, payoutCount: 2, botPayoutMicro: 0, returnedToCreatorMicro: 30 * CREDIT, enteredMicro: 52 * CREDIT, prorated: false });
    expect(settlement.decisions.map((step) => [step.streamId, step.events.map((event) => event.type)])).toEqual([
      [botStreamId(MARKET_1), ["BotVoided", "BotHoldingsReturned"]],
      [userStreamId(CREATOR), ["HoldingsReturned"]],
      [userStreamId(TRADER), ["PositionRefunded"]],
      [userStreamId("trader-2"), ["PositionRefunded"]],
    ]);
  });

  it("refunds a trader who sold everything at a loss, and gives nothing back to one who sold at a profit", () => {
    const ledger = new Ledger(50);
    ledger.deposit(TRADER, 100);
    ledger.deposit("trader-2", 100);
    // TRADER buys 20 YES at 0.30 (6 credits) and later sells them: 20 NO at 0.50 (10 credits), 20 pairs redeemed (+20).
    // Net payment 6 + 10 - 20 = -4: a profit of 4 credits, kept, no refund.
    expect(ledger.buy(TRADER, "YES", 6, [{ side: "YES", priceMicro: 300_000, sharesMicro: 20 * SHARE }])).toBe(true);
    expect(ledger.buy(TRADER, "NO", 10, [{ side: "NO", priceMicro: 500_000, sharesMicro: 40 * SHARE }])).toBe(true);
    ledger.redeem(TRADER, 20 * SHARE);
    // trader-2 buys 10 NO at 0.80 (8 credits) and sells them: 10 YES at 0.40 (4 credits), 10 pairs (+10). Net 2: refunded.
    expect(ledger.buy("trader-2", "NO", 8, [{ side: "NO", priceMicro: 800_000, sharesMicro: 10 * SHARE }])).toBe(true);
    expect(ledger.buy("trader-2", "YES", 4, [{ side: "YES", priceMicro: 400_000, sharesMicro: 10 * SHARE }])).toBe(true);
    ledger.redeem("trader-2", 10 * SHARE);
    expect(nonEmptyPositions(ledger.user(TRADER))).toEqual({});
    expect(nonEmptyPositions(ledger.user("trader-2"))).toEqual({});

    const settlement = ledger.settle();
    for (const step of settlement.decisions) ledger.apply(step);

    expect(settlement.refunds).toEqual(new Map([[userStreamId(TRADER), 0], [userStreamId("trader-2"), 2 * CREDIT]]));
    expect(ledger.user(TRADER).balanceMicro).toBe(104 * CREDIT);
    expect(ledger.user("trader-2").balanceMicro).toBe(100 * CREDIT);
    // The funding minus the seller's profit: 50 - 4.
    expect(ledger.user(CREATOR).balanceMicro).toBe(46 * CREDIT);
    expect(ledger.balances()).toBe(ledger.deposited);
    expect(settlement.summary).toMatchObject({ payoutTotalMicro: 2 * CREDIT, payoutCount: 1, returnedToCreatorMicro: 46 * CREDIT, prorated: false });
  });

  it("cuts the refunds pro rata when sellers took out more than the funding, and still pays out exactly what the market holds", () => {
    const ledger = new Ledger(1);
    ledger.deposit(TRADER, 100);
    ledger.deposit("trader-2", 100);
    // A bot that prices badly: trader-2 buys YES at 0.99 for 9 credits; TRADER buys most of the bot's NO at 0.01;
    // trader-2 sells its YES at a loss (NO at 0.99, then the pairs redeemed); TRADER buys most YES at 0.01 and redeems
    // its pairs. TRADER's profit (about 7.9 credits) is far more than the 1 credit of funding, so trader-2's claim
    // (about 8.9 credits) is larger than what the market holds (about 2 credits).
    const redeemAll = (userId: string) => {
      const held = holdingOf(ledger.user(userId), MARKET_1);
      ledger.redeem(userId, Math.min(held.yesMicro, held.noMicro));
    };
    expect(ledger.buy("trader-2", "YES", 9, [{ side: "YES", priceMicro: MAX_PRICE_MICRO, sharesMicro: 100 * SHARE }])).toBe(true);
    expect(ledger.buy(TRADER, "NO", 1, [{ side: "NO", priceMicro: MIN_PRICE_MICRO, sharesMicro: 10 * SHARE }, { side: "NO", priceMicro: MAX_PRICE_MICRO, sharesMicro: 10 * SHARE }])).toBe(true);
    expect(ledger.buy("trader-2", "NO", 9, [{ side: "NO", priceMicro: MAX_PRICE_MICRO, sharesMicro: 100 * SHARE }])).toBe(true);
    redeemAll("trader-2");
    expect(ledger.buy(TRADER, "YES", 1, [{ side: "YES", priceMicro: MIN_PRICE_MICRO, sharesMicro: 9 * SHARE }, { side: "YES", priceMicro: MAX_PRICE_MICRO, sharesMicro: 10 * SHARE }])).toBe(true);
    redeemAll(TRADER);
    expect(nonEmptyPositions(ledger.user("trader-2"))).toEqual({});
    const payments = ledger.payments();

    const settlement = ledger.settle();
    for (const step of settlement.decisions) ledger.apply(step);

    const net = nets(payments);
    const claim = Math.max(0, net.get(userStreamId("trader-2")) ?? 0);
    expect(settlement.summary.prorated).toBe(true);
    expect(settlement.summary.claimedMicro).toBe(claim);
    expect(settlement.summary.payoutTotalMicro + settlement.summary.returnedToCreatorMicro).toBe(settlement.summary.enteredMicro);
    expect(settlement.summary.enteredMicro).toBe(ledger.funding + [...net.values()].reduce((a, b) => a + b, 0));
    expect(settlement.refunds.get(userStreamId("trader-2"))).toBeLessThan(claim);
    // One claimant: its refund is everything the market holds, the creator gets nothing.
    expect(settlement.refunds.get(userStreamId("trader-2"))).toBe(settlement.summary.enteredMicro);
    expect(settlement.summary.returnedToCreatorMicro).toBe(0);
    expect(settlement.refunds.get(userStreamId(TRADER))).toBe(0);
    expect(ledger.balances()).toBe(ledger.deposited);
    for (const state of ledger.states.values()) expect(nonEmptyPositions(state)).toEqual({});
  });

  it("settles a market trading never funded with nothing to do", () => {
    const settlement = decideRefundSettlement({ marketId: MARKET_1, creatorId: CREATOR, fundingMicro: null, bot: null, accounts: [emptyUserAccount(CREATOR)], payments: [] });
    expect(settlement.decisions).toEqual([]);
    expect(settlement.summary).toMatchObject({ payoutTotalMicro: 0, payoutCount: 0, returnedToCreatorMicro: 0, enteredMicro: 0, releasedMicro: 0 });
  });

  it("refuses a decision that would create or destroy credits: a missing holder, a missing account, a wrong funding", () => {
    const ledger = new Ledger(20);
    ledger.deposit(TRADER, 50);
    expect(ledger.buy(TRADER, "YES", 5, [{ side: "YES", priceMicro: 500_000, sharesMicro: 20 * SHARE }])).toBe(true);
    const base = { marketId: MARKET_1, creatorId: CREATOR, fundingMicro: ledger.funding, bot: ledger.bot, accounts: ledger.users(), payments: ledger.payments() };
    expect(errorCode(() => decideRefundSettlement(base))).toBeUndefined();
    // The holder is not passed: YES and NO no longer add up.
    expect(errorCode(() => decideRefundSettlement({ ...base, accounts: [ledger.user(CREATOR)], payments: [] }))).toBe("invariant_violated");
    // A payment of a stream whose account is not passed.
    expect(errorCode(() => decideRefundSettlement({ ...base, accounts: [ledger.user(CREATOR)] }))).toBe("invariant_violated");
    // A funding that does not match what the market holds.
    expect(errorCode(() => decideRefundSettlement({ ...base, fundingMicro: ledger.funding + 1 }))).toBe("invariant_violated");
    // The creator is not passed but gets the rest.
    expect(errorCode(() => decideRefundSettlement({ ...base, accounts: [ledger.user(TRADER)] }))).toBe("invariant_violated");
    // Twice the same account, twice the same payment, a bot account as a user, another market's bot account.
    expect(errorCode(() => decideRefundSettlement({ ...base, accounts: [...base.accounts, ledger.user(TRADER)] }))).toBe("invariant_violated");
    expect(errorCode(() => decideRefundSettlement({ ...base, payments: [...base.payments, ...base.payments] }))).toBe("invariant_violated");
    expect(errorCode(() => decideRefundSettlement({ ...base, accounts: [...base.accounts, ledger.bot] }))).toBe("invariant_violated");
    expect(errorCode(() => decideRefundSettlement({ ...base, bot: emptyBotAccount("018f3c1e-7a00-7000-8000-0000000000aa") }))).toBe("invariant_violated");
    expect(errorCode(() => decideRefundSettlement({ ...base, payments: [{ streamId: userStreamId(TRADER), paidMicro: -1, returnedMicro: 0 }] }))).toBe("invariant_violated");
    // Shares or payments without a bot account.
    expect(errorCode(() => decideRefundSettlement({ ...base, bot: null, fundingMicro: null, accounts: [ledger.user(CREATOR)], payments: [{ streamId: userStreamId(CREATOR), paidMicro: 0, returnedMicro: 0 }] }))).toBeUndefined();
    expect(errorCode(() => decideRefundSettlement({ ...base, bot: null, fundingMicro: 5 * CREDIT, accounts: [ledger.user(CREATOR)], payments: [] }))).toBe("invariant_violated");
  });
});

// Property style: many random trade sequences, each a deterministic seed. Every sequence funds a market, lets a few
// traders buy from random backed and uncrossed books, sometimes sells (an opposite buy plus a redemption, as UC-08 will),
// then resolves the market INVALID through the domain's own decisions.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBook(random: () => number, bot: AccountState): Offer[] {
  const steps = (MAX_PRICE_MICRO - MIN_PRICE_MICRO) / PRICE_STEP_MICRO;
  // Half the books are extreme (0.01 or 0.99, a badly pricing bot): large losses and large profits for the traders.
  const extreme = random() < 0.5;
  const yesPrice = extreme ? (random() < 0.5 ? MIN_PRICE_MICRO : MAX_PRICE_MICRO) : MIN_PRICE_MICRO + Math.floor(random() * (steps + 1)) * PRICE_STEP_MICRO;
  // Not crossed: the cheapest NO is at least 1 credit minus the cheapest YES.
  const noFloor = Math.max(MIN_PRICE_MICRO, 1_000_000 - yesPrice);
  const noPrice = extreme ? noFloor : noFloor + Math.floor(random() * ((MAX_PRICE_MICRO - noFloor) / PRICE_STEP_MICRO + 1)) * PRICE_STEP_MICRO;
  const holding = holdingOf(bot, MARKET_1);
  // Backed: never more than the holding of the side plus the credits the bot account can turn into pairs.
  const yesShares = Math.floor((holding.yesMicro + bot.balanceMicro) * random());
  const noShares = Math.floor((holding.noMicro + bot.balanceMicro) * random());
  const offers: Offer[] = [];
  if (yesShares > 0) offers.push({ side: "YES", priceMicro: yesPrice, sharesMicro: yesShares });
  if (noShares > 0) offers.push({ side: "NO", priceMicro: noPrice, sharesMicro: noShares });
  return offers;
}

/** Whole credits to spend, at most what the book offers on that side (else the buy is refused for liquidity). */
function budget(random: () => number, book: readonly Offer[], side: Side): number {
  const available = Math.floor(liquidityMicro(book, side) / CREDIT);
  return 1 + Math.floor(random() * Math.max(1, Math.min(40, available)));
}

describe("decideRefundSettlement: credit conservation over random trade sequences", () => {
  it("pays out exactly the credits that entered the market, refunds every net payment, and replays to the same state", () => {
    const RUNS = 400;
    let withSales = 0;
    let prorated = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const random = generator(seed);
      // Half the markets are thinly funded, so sellers' profits can outgrow the funding (the pro rata branch).
      const ledger = new Ledger(random() < 0.5 ? 1 + Math.floor(random() * 5) : 1 + Math.floor(random() * 200));
      const traders = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index) => `trader-${String(index + 1)}`);
      for (const trader of traders) ledger.deposit(trader, 20 + Math.floor(random() * 300));
      const steps = Math.floor(random() * 40);
      for (let step = 0; step < steps; step += 1) {
        const trader = traders[Math.floor(random() * traders.length)] ?? TRADER;
        const side: Side = random() < 0.5 ? "YES" : "NO";
        const offers = randomBook(random, ledger.bot);
        ledger.buy(trader, side, budget(random, offers, side), offers);
        if (random() < 0.4) {
          // A sale: the opposite side bought, then every pair the trader holds redeemed.
          const opposite: Side = side === "YES" ? "NO" : "YES";
          const book = randomBook(random, ledger.bot);
          ledger.buy(trader, opposite, budget(random, book, opposite), book);
          const held = holdingOf(ledger.user(trader), MARKET_1);
          ledger.redeem(trader, Math.min(held.yesMicro, held.noMicro));
        }
      }
      const payments = ledger.payments();
      const net = nets(payments);
      const enteredMicro = ledger.funding + [...net.values()].reduce((a, b) => a + b, 0);

      const settlement = ledger.settle();
      for (const step of settlement.decisions) ledger.apply(step);
      const { summary, refunds } = settlement;

      // Conservation: what the settlement paid (refunds plus the creator's rest) is what entered the market.
      expect(summary.enteredMicro, `seed ${String(seed)}`).toBe(enteredMicro);
      expect(summary.payoutTotalMicro + summary.returnedToCreatorMicro, `seed ${String(seed)}`).toBe(enteredMicro);
      expect(ledger.balances(), `seed ${String(seed)}`).toBe(ledger.deposited);
      expect(ledger.bot.balanceMicro).toBe(0);
      for (const state of ledger.states.values()) expect(nonEmptyPositions(state), `seed ${String(seed)}`).toEqual({});
      // Each trader: its net payment back (never below zero), or a pro rata part of it when the market holds less.
      for (const [streamId, value] of net) {
        const refund = refunds.get(streamId);
        const claim = Math.max(0, value);
        if (summary.prorated) {
          expect(refund).toBeLessThanOrEqual(claim);
          expect(refund).toBe(Number((BigInt(claim) * BigInt(enteredMicro)) / BigInt(summary.claimedMicro)));
        } else {
          expect(refund, `seed ${String(seed)} ${streamId}`).toBe(claim);
        }
      }
      if (summary.prorated) {
        prorated += 1;
        expect(summary.returnedToCreatorMicro).toBeLessThan(net.size);
      }
      if (ledger.sales === 0) expect(summary.returnedToCreatorMicro, `seed ${String(seed)}`).toBe(ledger.funding);
      else withSales += 1;
      // Replay equality: every stream folded from its first event is the state the decisions reached.
      for (const [streamId, events] of ledger.events) {
        const replayed = replayStream(streamId, events);
        const current = ledger.states.get(streamId);
        expect({ balance: replayed.balanceMicro, version: replayed.version, positions: nonEmptyPositions(replayed) }).toEqual({
          balance: current?.balanceMicro,
          version: current?.version,
          positions: current ? nonEmptyPositions(current) : undefined,
        });
      }
    }
    // The generator reaches both branches: sequences with sales, and some where sellers took out more than the funding.
    expect(withSales).toBeGreaterThan(RUNS / 4);
    expect(prorated).toBeGreaterThan(0);
  });
});
