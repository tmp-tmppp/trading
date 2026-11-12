import { DomainError } from "./errors.js";
import type { SettlementSummary } from "./settlement.js";
import type { Outcome } from "./units.js";

// trading's local copy of a market (EP-2, DM-12): status and close time to accept or refuse orders without calling
// markets, the question for the portfolio, the starting price and funding for the market maker, and the market's trade
// sequence. It is written by the funding call and by markets' lifecycle events, guarded by markets' version (DM-04): an
// event changes the status only when its version is higher than the stored one, so a late or repeated event never rolls
// the market back. Both orders of arrival work: funding first ("funded", version 0), or MarketOpened first.
// markets' lifecycle only moves forward and ends at resolved (DM-19), so the copy does too: an event never moves it to an
// earlier status whatever its version, and a resolved copy is final, its outcome the one the ledger settled. An event
// that breaks this (a markets defect or a manual republish) is stale; RecordMarketEvent logs a contradicting outcome.

export const MARKET_STATUSES = ["funded", "open", "closed", "resolved"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

/** The order of the statuses (MARKET_STATUSES lists them in it). */
const STAGE: Record<MarketStatus, number> = { funded: 0, open: 1, closed: 2, resolved: 3 };

export interface MarketState {
  marketId: string;
  /** markets' version of the last lifecycle event applied; 0 while only the funding call is known. */
  version: number;
  /** "funded": the funding call arrived, MarketOpened not yet. */
  status: MarketStatus;
  /** From MarketOpened; null until it arrives. */
  question: string | null;
  closeTime: Date | null;
  startingPriceMicro: number | null;
  /** From the funding call, MarketOpened or MarketResolved; null only for a market trading first saw as closed. */
  creatorId: string | null;
  /** Null until the funding call. */
  fundingMicro: number | null;
  /** YES, NO or INVALID (UC-16); set exactly when the market is resolved. */
  outcome: Outcome | null;
  /** +1 for every trade; the bot replaces its offers based on it (ADR-041) and market-data orders prices by it. */
  tradeSequence: number;
  fundedAt: Date | null;
  openedAt: Date | null;
  closedAt: Date | null;
  resolvedAt: Date | null;
  settledAt: Date | null;
  payoutTotalMicro: number | null;
  returnedMicro: number | null;
  updatedAt: Date;
}

export interface OpenedFacts {
  marketId: string;
  version: number;
  question: string;
  closeTime: Date;
  startingPriceMicro: number;
  creatorId: string;
  openedAt: Date;
}

export interface ClosedFacts {
  marketId: string;
  version: number;
  closedAt: Date;
}

export interface ResolvedFacts {
  marketId: string;
  version: number;
  outcome: Outcome;
  resolvedAt: Date;
  creatorId: string;
}

/** "applied": status and version moved; "filled": only missing static fields of a late event; "stale": nothing. */
export type ApplyKind = "applied" | "filled" | "stale";

export interface Applied {
  state: MarketState;
  kind: ApplyKind;
}

function blank(marketId: string, now: Date): MarketState {
  return {
    marketId,
    version: 0,
    status: "funded",
    question: null,
    closeTime: null,
    startingPriceMicro: null,
    creatorId: null,
    fundingMicro: null,
    outcome: null,
    tradeSequence: 0,
    fundedAt: null,
    openedAt: null,
    closedAt: null,
    resolvedAt: null,
    settledAt: null,
    payoutTotalMicro: null,
    returnedMicro: null,
    updatedAt: now,
  };
}

/** The copy the funding call creates when no lifecycle event has arrived yet. */
export function newFundedMarket(marketId: string, creatorId: string, fundingMicro: number, now: Date): MarketState {
  return { ...blank(marketId, now), creatorId, fundingMicro, fundedAt: now };
}

/**
 * The funding call on a copy that exists already (MarketOpened came first). A closed or resolved market cannot be
 * funded any more (market_closed); a funded one is a programming error (repeats are answered from the idempotency key).
 */
export function recordFunding(state: MarketState, creatorId: string, fundingMicro: number, now: Date): MarketState {
  if (state.status === "closed" || state.status === "resolved") throw new DomainError("market_closed", `The market is ${state.status}`, "marketId");
  if (state.fundingMicro !== null) throw new DomainError("invariant_violated", `The market ${state.marketId} is funded already`);
  return { ...state, creatorId: state.creatorId ?? creatorId, fundingMicro, fundedAt: now, updatedAt: now };
}

/** Static fields a late MarketOpened may still fill in; it never changes the status or the version. */
function fillStatic(state: MarketState, facts: OpenedFacts, now: Date): Applied {
  const filled: MarketState = {
    ...state,
    question: state.question ?? facts.question,
    closeTime: state.closeTime ?? facts.closeTime,
    startingPriceMicro: state.startingPriceMicro ?? facts.startingPriceMicro,
    creatorId: state.creatorId ?? facts.creatorId,
    openedAt: state.openedAt ?? facts.openedAt,
  };
  const changed =
    filled.question !== state.question ||
    filled.closeTime !== state.closeTime ||
    filled.startingPriceMicro !== state.startingPriceMicro ||
    filled.creatorId !== state.creatorId ||
    filled.openedAt !== state.openedAt;
  return changed ? { state: { ...filled, updatedAt: now }, kind: "filled" } : { state, kind: "stale" };
}

/**
 * Whether an event that leads to `to` with markets' `version` moves the stored copy: only with a higher version, never
 * to an earlier status, and never once the copy is resolved (a later MarketResolved would change the settled outcome).
 */
function moves(state: MarketState, version: number, to: MarketStatus): boolean {
  return version > state.version && state.status !== "resolved" && STAGE[to] >= STAGE[state.status];
}

export function applyOpened(state: MarketState | null, facts: OpenedFacts, now: Date): Applied {
  if (state !== null && !moves(state, facts.version, "open")) return fillStatic(state, facts, now);
  const current = state ?? blank(facts.marketId, now);
  return {
    kind: "applied",
    state: {
      ...current,
      version: facts.version,
      status: "open",
      question: facts.question,
      closeTime: facts.closeTime,
      startingPriceMicro: facts.startingPriceMicro,
      creatorId: current.creatorId ?? facts.creatorId,
      openedAt: facts.openedAt,
      updatedAt: now,
    },
  };
}

export function applyClosed(state: MarketState | null, facts: ClosedFacts, now: Date): Applied {
  if (state !== null && !moves(state, facts.version, "closed")) return { state, kind: "stale" };
  const current = state ?? blank(facts.marketId, now);
  return { kind: "applied", state: { ...current, version: facts.version, status: "closed", closedAt: facts.closedAt, updatedAt: now } };
}

export function applyResolved(state: MarketState | null, facts: ResolvedFacts, now: Date): Applied {
  if (state !== null && !moves(state, facts.version, "resolved")) return { state, kind: "stale" };
  const current = state ?? blank(facts.marketId, now);
  return {
    kind: "applied",
    state: {
      ...current,
      version: facts.version,
      status: "resolved",
      outcome: facts.outcome,
      creatorId: current.creatorId ?? facts.creatorId,
      resolvedAt: facts.resolvedAt,
      updatedAt: now,
    },
  };
}

/**
 * Why the market takes no orders and no new offers now, or null when it does: it must be open (MarketOpened processed,
 * MarketClosed not yet), funded, and before its stored close time (plan 6.2, consistency window).
 */
export function tradingRefusal(state: MarketState, now: Date): string | null {
  if (state.status !== "open") return `The market is ${state.status === "funded" ? "not open yet" : state.status}`;
  if (state.fundingMicro === null) return "The market is not funded yet";
  if (state.closeTime !== null && now.getTime() >= state.closeTime.getTime()) return "The market is past its close time";
  return null;
}

export function assertTradable(state: MarketState, now: Date): void {
  const reason = tradingRefusal(state, now);
  if (reason !== null) throw new DomainError("market_not_open", reason, "marketId", { status: state.status });
}

/**
 * Why the bot may not place offers now, or null when it may (PUT bot-orders, ADR-041). Wider than tradingRefusal: a
 * "funded" copy takes offers too. markets funds a market before it publishes MarketOpened (DM-19), so the market maker,
 * reacting to its own copy of MarketOpened, may arrive before trading's consumer has opened the market; its offers then
 * rest until the market opens, and orders still wait for "open" (plan section 7: trading accepts orders once the bot's
 * offers exist). Never on a closed or resolved market, an unfunded one, or after the stored close time.
 */
export function offerRefusal(state: MarketState, now: Date): string | null {
  if (state.status === "closed" || state.status === "resolved") return `The market is ${state.status}`;
  if (state.fundingMicro === null) return "The market is not funded yet";
  if (state.closeTime !== null && now.getTime() >= state.closeTime.getTime()) return "The market is past its close time";
  return null;
}

export function assertOffersAccepted(state: MarketState, now: Date): void {
  const reason = offerRefusal(state, now);
  if (reason !== null) throw new DomainError("market_not_open", reason, "marketId", { status: state.status });
}

/** The copy after one more trade. */
export function withTrade(state: MarketState, now: Date): MarketState {
  return { ...state, tradeSequence: state.tradeSequence + 1, updatedAt: now };
}

/** A resolved market that has not been settled yet. */
export function needsSettlement(state: MarketState): boolean {
  return state.status === "resolved" && state.settledAt === null;
}

export function markSettled(state: MarketState, summary: SettlementSummary, now: Date): MarketState {
  if (!needsSettlement(state)) throw new DomainError("invariant_violated", `The market ${state.marketId} is not waiting for settlement`);
  return { ...state, settledAt: now, payoutTotalMicro: summary.payoutTotalMicro, returnedMicro: summary.returnedToCreatorMicro, updatedAt: now };
}
