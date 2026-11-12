import { decision } from "./accounts.js";
import type { StreamDecision } from "./accounts.js";
import { DomainError } from "./errors.js";
import { holdingOf } from "./ledger.js";
import type { AccountState, LedgerEvent } from "./ledger.js";
import { addMicro, isMicroQuantity, mulDivFloor, subMicro } from "./units.js";
import type { Side } from "./units.js";

// Settlement of a resolved market (FL-A step 10, choreography on MarketResolved): every winning microshare pays one
// microcredit (the bot account's included), losing shares vanish, and then everything the bot account holds goes to the
// market's creator (ADR-013). One transaction for the whole market, exactly once: the ledger's business keys
// (PositionSettled per market and owner, BotSettled per market) refuse a second settlement (DM-10).

export interface SettlementInput {
  marketId: string;
  outcome: Side;
  /** From MarketResolved (or the market's copy): who gets the bot account's holdings back. */
  creatorId: string;
  /** The market's bot account with its holding loaded; null when the market was never funded in trading. */
  bot: AccountState | null;
  /**
   * Every user account involved, each once, with this market's position loaded: all holders of a non-empty position,
   * and the creator's account (empty, version 0, when the creator has none yet) whenever the bot account holds anything.
   */
  accounts: readonly AccountState[];
}

export interface SettlementSummary {
  /** Microcredits paid to users for winning shares (the bot account's payout is not in it). */
  payoutTotalMicro: number;
  /** Users who received a payout above zero. */
  payoutCount: number;
  /** The bot account's own winning shares, paid to it before the return. */
  botPayoutMicro: number;
  /** What went from the bot account to the creator. */
  returnedToCreatorMicro: number;
}

export interface SettlementDecision {
  /** The bot account first, then the user accounts by stream id (the lock order of the use case). */
  decisions: StreamDecision[];
  summary: SettlementSummary;
}

function winning(outcome: Side, yesMicro: number, noMicro: number): number {
  return outcome === "YES" ? yesMicro : noMicro;
}

export function decideSettlement(input: SettlementInput): SettlementDecision {
  const { marketId, outcome, creatorId } = input;
  const decisions: StreamDecision[] = [];
  let botPayoutMicro = 0;
  let returnedToCreatorMicro = 0;

  if (input.bot !== null) {
    const bot = input.bot;
    if (bot.kind !== "bot" || bot.marketId !== marketId) throw new DomainError("invariant_violated", `${bot.streamId} is not the bot account of ${marketId}`);
    const holding = holdingOf(bot, marketId);
    botPayoutMicro = winning(outcome, holding.yesMicro, holding.noMicro);
    returnedToCreatorMicro = addMicro(bot.balanceMicro, botPayoutMicro);
    const events: LedgerEvent[] = [{ type: "BotSettled", data: { marketId, outcome, yesMicro: holding.yesMicro, noMicro: holding.noMicro, payoutMicro: botPayoutMicro } }];
    if (returnedToCreatorMicro > 0) events.push({ type: "BotHoldingsReturned", data: { marketId, creatorId, amountMicro: returnedToCreatorMicro } });
    decisions.push(decision(bot, events));
  }

  let payoutTotalMicro = 0;
  let payoutCount = 0;
  let creatorSeen = false;
  const seen = new Set<string>();
  const users = [...input.accounts].sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0));
  for (const account of users) {
    if (account.kind !== "user") throw new DomainError("invariant_violated", `${account.streamId} is not a user account`);
    if (seen.has(account.streamId)) throw new DomainError("invariant_violated", `${account.streamId} is listed twice`);
    seen.add(account.streamId);
    const events: LedgerEvent[] = [];
    const holding = holdingOf(account, marketId);
    if (holding.yesMicro > 0 || holding.noMicro > 0) {
      const payoutMicro = winning(outcome, holding.yesMicro, holding.noMicro);
      events.push({ type: "PositionSettled", data: { marketId, outcome, yesMicro: holding.yesMicro, noMicro: holding.noMicro, payoutMicro } });
      payoutTotalMicro = addMicro(payoutTotalMicro, payoutMicro);
      if (payoutMicro > 0) payoutCount += 1;
    }
    if (account.ownerId === creatorId) {
      creatorSeen = true;
      if (returnedToCreatorMicro > 0) events.push({ type: "HoldingsReturned", data: { marketId, amountMicro: returnedToCreatorMicro } });
    }
    if (events.length > 0) decisions.push(decision(account, events));
  }
  if (returnedToCreatorMicro > 0 && !creatorSeen) {
    throw new DomainError("invariant_violated", `The creator's account of ${marketId} must be passed to receive the bot account's holdings`);
  }
  return { decisions, summary: { payoutTotalMicro, payoutCount, botPayoutMicro, returnedToCreatorMicro } };
}

// INVALID resolution (UC-16): the market is cancelled economically. Every share of the market is voided; the credits
// behind its pairs (one microcredit per pair) and the bot account's credits are what the market holds, and that is
// exactly what entered it: the creator's funding plus the traders' net payments (the conservation the decision checks).
// Each trader gets back what it paid net, from the ledger: what its buys cost minus what its sales returned, never below
// zero. The rest goes to the creator through the bot account, as at a YES or NO settlement.
//
// Selling (UC-08) is a buy of the opposite side and the redemption of the pairs, recorded as one SharesSold event on the
// user's stream: its costMicro (the other side's shares) counts in `paidMicro`, its sharesMicro (the pairs redeemed, one
// microcredit each) in `returnedMicro`; a PairsRedeemed event would count in `returnedMicro` the same way. A trader who
// sold at a loss holds nothing and is refunded the loss; a trader who sold at a profit gets no refund and
// keeps the profit (credits may have been withdrawn, so nothing is clawed back), which the bot account paid and which
// therefore lowers the creator's part. When those profits are larger than the funding, the market holds less than the
// refunds: then every refund is cut pro rata (floor), the creator gets only the rounding remainder, and the market still
// pays out exactly what it holds. Without selling every net payment is the sum of the trader's buys, the refunds always
// fit, and the creator gets the funding back to the microcredit.

/** One user stream's payments into a market, summed from its ledger events (LedgerRepository.marketPayments). */
export interface MarketPayment {
  streamId: string;
  /** Sum of SharesBought.costMicro and SharesSold.costMicro of this market on the stream: every buy, a sale's opposite-side buy included. */
  paidMicro: number;
  /** Sum of SharesSold.sharesMicro and PairsRedeemed.pairsMicro of this market on the stream: the credits its sales returned. */
  returnedMicro: number;
}

export interface RefundSettlementInput {
  marketId: string;
  /** Who gets the rest back (the bot account's owner, else markets' creatorId). */
  creatorId: string;
  /** The creator's funding as trading recorded it; null when the market was never funded here. */
  fundingMicro: number | null;
  /** The market's bot account with its holding loaded; null when the market was never funded in trading. */
  bot: AccountState | null;
  /**
   * Every user account involved, each once, with this market's position loaded: all holders of a non-empty position,
   * every stream in `payments` (a trader who sold everything still has a payment), and the creator's account (empty,
   * version 0, when it has none yet).
   */
  accounts: readonly AccountState[];
  /** The user streams that paid into or got credits back from this market (user streams only, each once). */
  payments: readonly MarketPayment[];
}

export interface RefundSummary extends SettlementSummary {
  /** The funding plus the traders' net payments: what entered the market and what it holds. */
  enteredMicro: number;
  /** The credits behind the market's pairs, released when its shares are voided. */
  releasedMicro: number;
  /** The traders' claims (net payments above zero) before any cut. */
  claimedMicro: number;
  /** True when the market held less than the claims and every refund was cut pro rata. */
  prorated: boolean;
}

export interface RefundSettlementDecision {
  /** The bot account first, then the user accounts by stream id (the lock order of the use case). */
  decisions: StreamDecision[];
  /** payoutTotalMicro and payoutCount are the refunds; botPayoutMicro is 0 (nothing wins). */
  summary: RefundSummary;
  /** The refund of every user stream that got a PositionRefunded, by stream id. */
  refunds: ReadonlyMap<string, number>;
}

function violated(message: string): never {
  throw new DomainError("invariant_violated", message);
}

function sortedUserAccounts(accounts: readonly AccountState[]): AccountState[] {
  const users = [...accounts].sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0));
  const seen = new Set<string>();
  for (const account of users) {
    if (account.kind !== "user") violated(`${account.streamId} is not a user account`);
    if (seen.has(account.streamId)) violated(`${account.streamId} is listed twice`);
    seen.add(account.streamId);
  }
  return users;
}

export function decideRefundSettlement(input: RefundSettlementInput): RefundSettlementDecision {
  const { marketId, creatorId, bot } = input;
  if (bot !== null && (bot.kind !== "bot" || bot.marketId !== marketId)) violated(`${bot.streamId} is not the bot account of ${marketId}`);
  const users = sortedUserAccounts(input.accounts);
  const listed = new Set(users.map((account) => account.streamId));

  const payments = new Map<string, MarketPayment>();
  let netTotal = 0;
  for (const payment of input.payments) {
    if (payments.has(payment.streamId)) violated(`The payments of ${payment.streamId} are listed twice`);
    if (!listed.has(payment.streamId)) violated(`${payment.streamId} paid into ${marketId} but its account was not passed`);
    if (!isMicroQuantity(payment.paidMicro) || !isMicroQuantity(payment.returnedMicro)) violated(`The payments of ${payment.streamId} must be zero or more`);
    payments.set(payment.streamId, payment);
    netTotal = addMicro(netTotal, subMicro(payment.paidMicro, payment.returnedMicro));
  }

  // Every pair has one YES and one NO share somewhere: in the bot account or with a holder. Unequal totals mean a holder
  // was not passed, and a refund decided on them would create or destroy credits.
  const botHolding = bot === null ? { yesMicro: 0, noMicro: 0 } : holdingOf(bot, marketId);
  let yesTotal = botHolding.yesMicro;
  let noTotal = botHolding.noMicro;
  for (const account of users) {
    const holding = holdingOf(account, marketId);
    yesTotal = addMicro(yesTotal, holding.yesMicro);
    noTotal = addMicro(noTotal, holding.noMicro);
  }
  if (yesTotal !== noTotal) violated(`The market ${marketId} has ${yesTotal} YES and ${noTotal} NO microshares: a holder is missing`);
  const releasedMicro = yesTotal;
  const availableMicro = addMicro(bot?.balanceMicro ?? 0, releasedMicro);
  const enteredMicro = addMicro(input.fundingMicro ?? 0, netTotal);
  if (enteredMicro !== availableMicro) {
    violated(`The market ${marketId} holds ${availableMicro} microcredits, but ${enteredMicro} entered it (funding plus net payments)`);
  }

  let claimedMicro = 0;
  for (const payment of payments.values()) claimedMicro = addMicro(claimedMicro, Math.max(0, subMicro(payment.paidMicro, payment.returnedMicro)));
  const prorated = claimedMicro > availableMicro;
  const refunds = new Map<string, number>();
  let refundedMicro = 0;
  for (const account of users) {
    const payment = payments.get(account.streamId);
    const holding = holdingOf(account, marketId);
    if (payment === undefined && holding.yesMicro === 0 && holding.noMicro === 0) continue;
    const claim = payment === undefined ? 0 : Math.max(0, subMicro(payment.paidMicro, payment.returnedMicro));
    const refund = prorated ? mulDivFloor(claim, availableMicro, claimedMicro) : claim;
    refunds.set(account.streamId, refund);
    refundedMicro = addMicro(refundedMicro, refund);
  }
  const returnedToCreatorMicro = subMicro(availableMicro, refundedMicro);
  if (returnedToCreatorMicro < 0) violated(`The refunds of ${marketId} exceed what the market holds`);

  const decisions: StreamDecision[] = [];
  if (bot !== null) {
    const events: LedgerEvent[] = [
      { type: "BotVoided", data: { marketId, yesMicro: botHolding.yesMicro, noMicro: botHolding.noMicro, releasedMicro, refundedMicro } },
    ];
    if (returnedToCreatorMicro > 0) events.push({ type: "BotHoldingsReturned", data: { marketId, creatorId, amountMicro: returnedToCreatorMicro } });
    decisions.push(decision(bot, events));
  } else if (availableMicro !== 0) {
    violated(`The market ${marketId} has shares or payments but no bot account`);
  }

  let payoutCount = 0;
  let creatorSeen = false;
  for (const account of users) {
    const events: LedgerEvent[] = [];
    const refund = refunds.get(account.streamId);
    if (refund !== undefined) {
      const holding = holdingOf(account, marketId);
      const payment = payments.get(account.streamId);
      events.push({
        type: "PositionRefunded",
        data: { marketId, yesMicro: holding.yesMicro, noMicro: holding.noMicro, paidMicro: payment?.paidMicro ?? 0, returnedMicro: payment?.returnedMicro ?? 0, refundMicro: refund },
      });
      if (refund > 0) payoutCount += 1;
    }
    if (account.ownerId === creatorId) {
      creatorSeen = true;
      if (returnedToCreatorMicro > 0) events.push({ type: "HoldingsReturned", data: { marketId, amountMicro: returnedToCreatorMicro } });
    }
    if (events.length > 0) decisions.push(decision(account, events));
  }
  if (returnedToCreatorMicro > 0 && !creatorSeen) violated(`The creator's account of ${marketId} must be passed to receive the rest`);

  return {
    decisions,
    refunds,
    summary: { payoutTotalMicro: refundedMicro, payoutCount, botPayoutMicro: 0, returnedToCreatorMicro, enteredMicro, releasedMicro, claimedMicro, prorated },
  };
}
