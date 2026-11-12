import { DomainError } from "./errors.js";
import { addMicro, isMicroQuantity, subMicro } from "./units.js";
import type { Side } from "./units.js";

// The ledger as an event store (DM-07, ADR-005, Proposed ADR "ledger event store"). Every movement of credits and
// shares is an event appended to one stream: one stream per user account ("account:<userId>") and one per market's bot
// account ("bot:<marketId>", which belongs to the market's creator). Balances and positions are projections: the fold
// of `evolve` over a stream's events, rebuilt by replay. These event types are internal (DM-08): they never leave
// trading; the use cases write the matching public events (TradeExecuted, ...) into the outbox in the same transaction.
// All quantities are micro-units (src/domain/units.ts).

export type AccountKind = "user" | "bot";

/** A user id is the identity provider's subject: 1 to 255 characters, no control characters, no ":" prefix games. */
const USER_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUserId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && USER_ID_PATTERN.test(value);
}

export function parseUserId(value: unknown, field = "userId"): string {
  if (!isUserId(value)) throw new DomainError("invalid_user_id", `${field} must be 1 to 255 characters without control characters or surrounding spaces`, field);
  return value;
}

export function isMarketId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.toLowerCase());
}

/** A market id is markets' UUID; returned in lower case. */
export function parseMarketId(value: unknown, field = "marketId"): string {
  if (!isMarketId(value)) throw new DomainError("invalid_market_id", `${field} must be a UUID`, field);
  return value.toLowerCase();
}

export const USER_STREAM_PREFIX = "account:";
export const BOT_STREAM_PREFIX = "bot:";

export function userStreamId(userId: string): string {
  return `${USER_STREAM_PREFIX}${parseUserId(userId)}`;
}

export function botStreamId(marketId: string): string {
  return `${BOT_STREAM_PREFIX}${parseMarketId(marketId)}`;
}

/** The kind and owner key of a stream id, or null when it is not one of ours. */
export function parseStreamId(streamId: string): { kind: "user"; userId: string } | { kind: "bot"; marketId: string } | null {
  if (streamId.startsWith(USER_STREAM_PREFIX)) {
    const userId = streamId.slice(USER_STREAM_PREFIX.length);
    return isUserId(userId) ? { kind: "user", userId } : null;
  }
  if (streamId.startsWith(BOT_STREAM_PREFIX)) {
    const marketId = streamId.slice(BOT_STREAM_PREFIX.length);
    return isMarketId(marketId) && marketId === marketId.toLowerCase() ? { kind: "bot", marketId } : null;
  }
  return null;
}

/** One price level of a buy: `sharesMicro` bought at `priceMicro` for `costMicro`. */
export interface Fill {
  priceMicro: number;
  sharesMicro: number;
  costMicro: number;
}

// The event types. "User" types go only to user streams, "bot" types only to bot streams. A sale (UC-08) is SharesSold on
// the trader's stream and BotSharesSold (of the other side) on the bot's: one event per stream, as a buy. PairsRedeemed
// stays reserved for a redemption without a trade and is never decided yet. PositionRefunded and BotVoided are the
// INVALID resolution (UC-16); its return to the creator reuses BotHoldingsReturned and HoldingsReturned.
export type LedgerEvent =
  /** Test credits: seed data only (plan 6.2), never a starting bonus. Key: grantId. */
  | { type: "CreditsGranted"; data: { grantId: string; amountMicro: number; reason: string } }
  /** DepositSucceeded of payments, credited once per deposit (FL-B). Key: depositId. */
  | { type: "DepositCredited"; data: { depositId: string; amountMicro: number } }
  /** The debit of a withdrawal (FL-C step 2), whole credits only. Key: withdrawalId. */
  | { type: "WithdrawalDebited"; data: { withdrawalId: string; amountMicro: number } }
  /** The compensation of a failed payout (FL-C step 7). Key: withdrawalId. */
  | { type: "WithdrawalRefunded"; data: { withdrawalId: string; amountMicro: number } }
  /** The creator's credits that fund a market (FL-A step 2). Key: marketId. */
  | { type: "MarketFundingPaid"; data: { marketId: string; amountMicro: number } }
  /** A trader's buy from the bot's offers. Key: tradeId. */
  | { type: "SharesBought"; data: { tradeId: string; marketId: string; side: Side; sharesMicro: number; costMicro: number; tradeSequence: number; fills: Fill[] } }
  /**
   * A trader's sale (UC-08, plan 6.2): `sharesMicro` of `side` leave the position. The trade buys as many shares of the
   * other side from the bot's offers for `costMicro` (`fills`, priced as the bot's offers of that side) and redeems the
   * pairs for 1 microcredit each, so the balance grows by `proceedsMicro` = sharesMicro - costMicro (never below zero).
   * One event, not SharesBought followed by PairsRedeemed: the buy alone would take a balance lower than its cost below
   * zero, and every recorded state stays non-negative (as BotSharesSold's pairs). Key: tradeId.
   */
  | {
      type: "SharesSold";
      data: { tradeId: string; marketId: string; side: Side; sharesMicro: number; costMicro: number; proceedsMicro: number; tradeSequence: number; fills: Fill[] };
    }
  /** Resolution of a user's position: winning microshares pay 1 microcredit each, losing ones vanish. Key: marketId. */
  | { type: "PositionSettled"; data: { marketId: string; outcome: Side; yesMicro: number; noMicro: number; payoutMicro: number } }
  /** What the bot account still held after its own payout, returned to the creator's account. Key: marketId. */
  | { type: "HoldingsReturned"; data: { marketId: string; amountMicro: number } }
  /** The funding became pairs in the bot account: amountMicro YES and amountMicro NO microshares. Key: marketId. */
  | { type: "BotFunded"; data: { marketId: string; creatorId: string; amountMicro: number } }
  /**
   * The bot's side of a trade. When the bot holds fewer shares of `side` than it sells, it first turns credits into
   * `pairsCreatedMicro` new pairs (the trader's payment of this trade included); one event keeps every recorded state
   * non-negative. Key: tradeId.
   */
  | { type: "BotSharesSold"; data: { tradeId: string; side: Side; sharesMicro: number; costMicro: number; pairsCreatedMicro: number; tradeSequence: number } }
  /** The bot account's own winning shares paid out at resolution. Key: marketId. */
  | { type: "BotSettled"; data: { marketId: string; outcome: Side; yesMicro: number; noMicro: number; payoutMicro: number } }
  /** The bot account's credits leave for the creator (the other half of HoldingsReturned). Key: marketId. */
  | { type: "BotHoldingsReturned"; data: { marketId: string; creatorId: string; amountMicro: number } }
  /** Reserved for selling (UC-08): pairs turned back into credits, 1 microcredit per pair. Key: `<redemptionId>/<streamId>`. */
  | { type: "PairsRedeemed"; data: { redemptionId: string; marketId: string; pairsMicro: number } }
  /**
   * INVALID resolution (UC-16) of a user account: its shares of the market are voided (they must equal the position)
   * and it is refunded `refundMicro`, its net payment into the market (`paidMicro`, what its buys cost, minus
   * `returnedMicro`, what its sales returned; never below zero; cut pro rata only when the market holds less). Key:
   * `<marketId>/<streamId>`.
   */
  | { type: "PositionRefunded"; data: { marketId: string; yesMicro: number; noMicro: number; paidMicro: number; returnedMicro: number; refundMicro: number } }
  /**
   * INVALID resolution (UC-16) of the bot account: its own shares are voided, the credits behind every pair of the
   * market come in (`releasedMicro`: the market's YES shares, equal to its NO shares, all holders and the bot together),
   * and the traders' refunds go out (`refundedMicro`). What is left goes to the creator with BotHoldingsReturned. Key:
   * marketId.
   */
  | { type: "BotVoided"; data: { marketId: string; yesMicro: number; noMicro: number; releasedMicro: number; refundedMicro: number } };

export type LedgerEventType = LedgerEvent["type"];

export const USER_EVENT_TYPES = [
  "CreditsGranted",
  "DepositCredited",
  "WithdrawalDebited",
  "WithdrawalRefunded",
  "MarketFundingPaid",
  "SharesBought",
  "SharesSold",
  "PositionSettled",
  "HoldingsReturned",
  "PositionRefunded",
  "PairsRedeemed",
] as const satisfies readonly LedgerEventType[];

export const BOT_EVENT_TYPES = ["BotFunded", "BotSharesSold", "BotSettled", "BotVoided", "BotHoldingsReturned", "PairsRedeemed"] as const satisfies readonly LedgerEventType[];

export const LEDGER_EVENT_TYPES: readonly LedgerEventType[] = [...new Set<LedgerEventType>([...USER_EVENT_TYPES, ...BOT_EVENT_TYPES])];

/** Who and what caused an event (DM-07 meta); ids only (DM-14). */
export interface LedgerMeta {
  correlationId: string;
  causationId: string;
  /** The user subject, a service client ("client:payments") or "system" for a consumed event. */
  actor: string;
}

/**
 * The business key of an event: the ledger table holds UNIQUE (type, business_key), the last guard against crediting a
 * deposit, debiting or refunding a withdrawal, funding or settling a market twice (DM-10). PositionSettled is unique
 * per market and owner, so its key carries the stream.
 */
export function businessKeyOf(streamId: string, event: LedgerEvent): string {
  switch (event.type) {
    case "CreditsGranted":
      return event.data.grantId;
    case "DepositCredited":
      return event.data.depositId;
    case "WithdrawalDebited":
    case "WithdrawalRefunded":
      return event.data.withdrawalId;
    case "SharesBought":
    case "SharesSold":
    case "BotSharesSold":
      return event.data.tradeId;
    case "PositionSettled":
    case "PositionRefunded":
      return `${event.data.marketId}/${streamId}`;
    case "MarketFundingPaid":
    case "HoldingsReturned":
    case "BotFunded":
    case "BotSettled":
    case "BotVoided":
    case "BotHoldingsReturned":
      return event.data.marketId;
    case "PairsRedeemed":
      // One redemption may write this event on the user's and the bot's stream in one transaction (UC-08), so the key
      // names the stream as PositionSettled's does; a redemption id alone would collide on UNIQUE (type, business_key).
      return `${event.data.redemptionId}/${streamId}`;
  }
}

export interface Holding {
  yesMicro: number;
  noMicro: number;
}

export const EMPTY_HOLDING: Holding = Object.freeze({ yesMicro: 0, noMicro: 0 });

/**
 * The state of one account: the projection of its stream. `positions` holds only the markets that were loaded or that
 * the events touched; a use case loads every market its decision touches, because the projection is saved with the
 * absolute values of exactly these positions.
 */
export interface AccountState {
  streamId: string;
  kind: AccountKind;
  /** The user subject; for a bot account the market's creator, who gets its holdings back. Null only before BotFunded. */
  ownerId: string | null;
  /** The market of a bot account; null for a user account. */
  marketId: string | null;
  balanceMicro: number;
  positions: Readonly<Record<string, Holding>>;
  /** The version of the last event folded in; 0 before the first event (the expected version of the next append). */
  version: number;
}

export function emptyUserAccount(userId: string): AccountState {
  return { streamId: userStreamId(userId), kind: "user", ownerId: userId, marketId: null, balanceMicro: 0, positions: {}, version: 0 };
}

/** A bot account before its BotFunded event; `creatorId` is known from the funding call or the market's copy. */
export function emptyBotAccount(marketId: string, creatorId: string | null = null): AccountState {
  const id = parseMarketId(marketId);
  return { streamId: botStreamId(id), kind: "bot", ownerId: creatorId, marketId: id, balanceMicro: 0, positions: {}, version: 0 };
}

/** The empty state a stream starts from, from its id alone (replay). */
export function initialStateOf(streamId: string): AccountState {
  const parsed = parseStreamId(streamId);
  if (parsed === null) throw new DomainError("invariant_violated", `Unknown stream id ${streamId}`);
  return parsed.kind === "user" ? emptyUserAccount(parsed.userId) : emptyBotAccount(parsed.marketId);
}

export function holdingOf(state: AccountState, marketId: string): Holding {
  return state.positions[marketId] ?? EMPTY_HOLDING;
}

/** The balance and holding a test or projection compares; positions with zero shares are left out. */
export function nonEmptyPositions(state: AccountState): Record<string, Holding> {
  const result: Record<string, Holding> = {};
  for (const [marketId, holding] of Object.entries(state.positions)) {
    if (holding.yesMicro !== 0 || holding.noMicro !== 0) result[marketId] = { ...holding };
  }
  return result;
}

function invariant(condition: boolean, message: string): void {
  if (!condition) throw new DomainError("invariant_violated", message);
}

function nonNegative(value: number, what: string, state: AccountState): number {
  invariant(isMicroQuantity(value), `${what} of ${state.streamId} would be ${value}: balances and holdings never go below zero`);
  return value;
}

function withBalance(state: AccountState, delta: number): AccountState {
  return { ...state, balanceMicro: nonNegative(addMicro(state.balanceMicro, delta), "The balance", state) };
}

function withHolding(state: AccountState, marketId: string, yesDelta: number, noDelta: number): AccountState {
  const current = holdingOf(state, marketId);
  const next: Holding = {
    yesMicro: nonNegative(addMicro(current.yesMicro, yesDelta), "The YES holding", state),
    noMicro: nonNegative(addMicro(current.noMicro, noDelta), "The NO holding", state),
  };
  return { ...state, positions: { ...state.positions, [marketId]: next } };
}

function sideDelta(side: Side, amount: number): [number, number] {
  return side === "YES" ? [amount, 0] : [0, amount];
}

function expectKind(state: AccountState, kind: AccountKind, type: LedgerEventType): void {
  invariant(state.kind === kind, `${type} belongs to a ${kind} stream, not to ${state.streamId}`);
}

function expectOwnMarket(state: AccountState, marketId: string, type: LedgerEventType): void {
  invariant(state.marketId === marketId, `${type} of market ${marketId} cannot be applied to ${state.streamId}`);
}

/**
 * Applies one event to the state of its stream (pure). Throws DomainError invariant_violated when the event does not
 * belong to the stream or would take a balance or a holding below zero; `version` grows by one.
 */
export function evolve(state: AccountState, event: LedgerEvent): AccountState {
  let next: AccountState;
  switch (event.type) {
    case "CreditsGranted":
    case "DepositCredited":
    case "WithdrawalRefunded":
      expectKind(state, "user", event.type);
      next = withBalance(state, event.data.amountMicro);
      break;
    case "WithdrawalDebited":
    case "MarketFundingPaid":
      expectKind(state, "user", event.type);
      next = withBalance(state, -event.data.amountMicro);
      break;
    case "SharesBought": {
      expectKind(state, "user", event.type);
      const [yes, no] = sideDelta(event.data.side, event.data.sharesMicro);
      next = withHolding(withBalance(state, -event.data.costMicro), event.data.marketId, yes, no);
      break;
    }
    case "SharesSold": {
      expectKind(state, "user", event.type);
      const { sharesMicro, costMicro, proceedsMicro } = event.data;
      invariant(
        isMicroQuantity(sharesMicro) && isMicroQuantity(costMicro) && isMicroQuantity(proceedsMicro) && subMicro(sharesMicro, costMicro) === proceedsMicro,
        `SharesSold of ${state.streamId} needs proceeds equal to the shares sold minus the cost of the other side`,
      );
      // Bought the other side and redeemed the pairs in one step: the other side's holding is unchanged.
      const [yes, no] = sideDelta(event.data.side, -sharesMicro);
      next = withHolding(withBalance(state, proceedsMicro), event.data.marketId, yes, no);
      break;
    }
    case "PositionSettled": {
      expectKind(state, "user", event.type);
      const holding = holdingOf(state, event.data.marketId);
      invariant(
        holding.yesMicro === event.data.yesMicro && holding.noMicro === event.data.noMicro,
        `PositionSettled of ${event.data.marketId} does not match the position of ${state.streamId}`,
      );
      next = withHolding(withBalance(state, event.data.payoutMicro), event.data.marketId, -event.data.yesMicro, -event.data.noMicro);
      break;
    }
    case "PositionRefunded": {
      expectKind(state, "user", event.type);
      const holding = holdingOf(state, event.data.marketId);
      invariant(
        holding.yesMicro === event.data.yesMicro && holding.noMicro === event.data.noMicro,
        `PositionRefunded of ${event.data.marketId} does not match the position of ${state.streamId}`,
      );
      invariant(isMicroQuantity(event.data.refundMicro), `PositionRefunded of ${state.streamId} needs a refund of zero or more`);
      next = withHolding(withBalance(state, event.data.refundMicro), event.data.marketId, -event.data.yesMicro, -event.data.noMicro);
      break;
    }
    case "HoldingsReturned":
      expectKind(state, "user", event.type);
      next = withBalance(state, event.data.amountMicro);
      break;
    case "BotFunded":
      expectKind(state, "bot", event.type);
      expectOwnMarket(state, event.data.marketId, event.type);
      next = withHolding({ ...state, ownerId: event.data.creatorId }, event.data.marketId, event.data.amountMicro, event.data.amountMicro);
      break;
    case "BotSharesSold": {
      expectKind(state, "bot", event.type);
      const marketId = state.marketId ?? "";
      const pairs = event.data.pairsCreatedMicro;
      const [yes, no] = sideDelta(event.data.side, event.data.sharesMicro);
      // Credits in (the trader's payment) and pairs created first, then the shares leave: one atomic step.
      next = withHolding(withBalance(state, subMicro(event.data.costMicro, pairs)), marketId, pairs - yes, pairs - no);
      break;
    }
    case "BotSettled": {
      expectKind(state, "bot", event.type);
      expectOwnMarket(state, event.data.marketId, event.type);
      const holding = holdingOf(state, event.data.marketId);
      invariant(
        holding.yesMicro === event.data.yesMicro && holding.noMicro === event.data.noMicro,
        `BotSettled of ${event.data.marketId} does not match the holdings of ${state.streamId}`,
      );
      next = withHolding(withBalance(state, event.data.payoutMicro), event.data.marketId, -event.data.yesMicro, -event.data.noMicro);
      break;
    }
    case "BotVoided": {
      expectKind(state, "bot", event.type);
      expectOwnMarket(state, event.data.marketId, event.type);
      const holding = holdingOf(state, event.data.marketId);
      invariant(
        holding.yesMicro === event.data.yesMicro && holding.noMicro === event.data.noMicro,
        `BotVoided of ${event.data.marketId} does not match the holdings of ${state.streamId}`,
      );
      invariant(
        isMicroQuantity(event.data.releasedMicro) && isMicroQuantity(event.data.refundedMicro),
        `BotVoided of ${state.streamId} needs released and refunded amounts of zero or more`,
      );
      // The released credits come in before the refunds go out: one atomic step, the balance checked once after it.
      const delta = subMicro(event.data.releasedMicro, event.data.refundedMicro);
      next = withHolding(withBalance(state, delta), event.data.marketId, -event.data.yesMicro, -event.data.noMicro);
      break;
    }
    case "BotHoldingsReturned":
      expectKind(state, "bot", event.type);
      expectOwnMarket(state, event.data.marketId, event.type);
      next = withBalance(state, -event.data.amountMicro);
      break;
    case "PairsRedeemed":
      if (state.kind === "bot") expectOwnMarket(state, event.data.marketId, event.type);
      next = withHolding(withBalance(state, event.data.pairsMicro), event.data.marketId, -event.data.pairsMicro, -event.data.pairsMicro);
      break;
  }
  return { ...next, version: state.version + 1 };
}

/** Folds events into a state, in order. */
export function evolveAll(state: AccountState, events: readonly LedgerEvent[]): AccountState {
  return events.reduce(evolve, state);
}

/** The projection of a whole stream from its first event (replay, DM-07). */
export function replayStream(streamId: string, events: readonly LedgerEvent[]): AccountState {
  return evolveAll(initialStateOf(streamId), events);
}
