import { DomainError } from "./errors.js";
import { evolveAll } from "./ledger.js";
import type { AccountState, LedgerEvent } from "./ledger.js";
import { creditsToMicro, wholeCredits } from "./units.js";

// The decide side of the ledger for credit movements (DM-07): each function takes the current state of the streams it
// touches and returns the events to append, with the expected version of each stream and the state after them. It
// never writes anything; the use case appends the events and saves the projection in one transaction.

/** Events for one stream: append them with `expectedVersion`, then save `next` as the projection. */
export interface StreamDecision {
  streamId: string;
  expectedVersion: number;
  events: LedgerEvent[];
  next: AccountState;
}

export function decision(state: AccountState, events: LedgerEvent[]): StreamDecision {
  return { streamId: state.streamId, expectedVersion: state.version, events, next: evolveAll(state, events) };
}

function expectUser(state: AccountState): void {
  if (state.kind !== "user") throw new DomainError("invariant_violated", `${state.streamId} is not a user account`);
}

/** Test credits (seed data only). */
export function decideGrant(account: AccountState, input: { grantId: string; credits: number; reason: string }): StreamDecision {
  expectUser(account);
  return decision(account, [{ type: "CreditsGranted", data: { grantId: input.grantId, amountMicro: creditsToMicro(input.credits), reason: input.reason } }]);
}

/** DepositSucceeded: credit the deposit's amount (FL-B step 4). */
export function decideDeposit(account: AccountState, input: { depositId: string; credits: number }): StreamDecision {
  expectUser(account);
  return decision(account, [{ type: "DepositCredited", data: { depositId: input.depositId, amountMicro: creditsToMicro(input.credits) } }]);
}

/** The whole credits a withdrawal may take now (the fraction of a credit stays in the balance). */
export function withdrawableCredits(account: AccountState): number {
  return wholeCredits(account.balanceMicro);
}

/** The debit of a withdrawal (FL-C step 2): whole credits only; too few credits is insufficient_credits. */
export function decideDebit(account: AccountState, input: { withdrawalId: string; credits: number }): StreamDecision {
  expectUser(account);
  const amountMicro = creditsToMicro(input.credits);
  if (account.balanceMicro < amountMicro) {
    throw new DomainError("insufficient_credits", "The balance is lower than the amount", "amount", { withdrawableCredits: withdrawableCredits(account) });
  }
  return decision(account, [{ type: "WithdrawalDebited", data: { withdrawalId: input.withdrawalId, amountMicro } }]);
}

/**
 * The refund of a failed withdrawal (FL-C step 7): exactly what the debit took, whatever the consumed event says, so a
 * refund can never create credits. `debitedMicro` comes from the WithdrawalDebited event of the same withdrawal.
 */
export function decideRefund(account: AccountState, input: { withdrawalId: string; debitedMicro: number }): StreamDecision {
  expectUser(account);
  return decision(account, [{ type: "WithdrawalRefunded", data: { withdrawalId: input.withdrawalId, amountMicro: input.debitedMicro } }]);
}

export interface FundingDecision {
  creator: StreamDecision;
  bot: StreamDecision;
  amountMicro: number;
}

/**
 * Funding a market (FL-A step 2, ADR-013): the creator's credits become pairs in the market's bot account, 1 microcredit
 * per pair (amountMicro YES plus amountMicro NO microshares). Too few credits is insufficient_credits; nothing changes.
 */
export function decideFunding(creator: AccountState, bot: AccountState, input: { marketId: string; creatorId: string; credits: number }): FundingDecision {
  expectUser(creator);
  if (bot.kind !== "bot" || bot.marketId !== input.marketId) throw new DomainError("invariant_violated", `${bot.streamId} is not the bot account of ${input.marketId}`);
  if (bot.version !== 0) throw new DomainError("invariant_violated", `The bot account of ${input.marketId} is funded already`);
  const amountMicro = creditsToMicro(input.credits);
  if (creator.balanceMicro < amountMicro) {
    throw new DomainError("insufficient_credits", "The creator's balance is lower than the funding", "amount", { withdrawableCredits: withdrawableCredits(creator) });
  }
  return {
    creator: decision(creator, [{ type: "MarketFundingPaid", data: { marketId: input.marketId, amountMicro } }]),
    bot: decision(bot, [{ type: "BotFunded", data: { marketId: input.marketId, creatorId: input.creatorId, amountMicro } }]),
    amountMicro,
  };
}
