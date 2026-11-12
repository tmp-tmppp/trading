import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  applyClosed,
  applyOpened,
  applyResolved,
  assertOffersAccepted,
  assertTradable,
  newFundedMarket,
  offerRefusal,
  tradingRefusal,
} from "../../src/domain/market-state.js";
import type { MarketState } from "../../src/domain/market-state.js";
import { CREATOR, MARKET_1 } from "../support/fakes.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const CLOSE = new Date("2026-11-02T10:00:00.000Z");
const opened = { marketId: MARKET_1, version: 1, question: "Will it rain?", closeTime: CLOSE, startingPriceMicro: 500_000, creatorId: CREATOR, openedAt: NOW };

function funded(): MarketState {
  return newFundedMarket(MARKET_1, CREATOR, 1_000_000, NOW);
}

function codeOf(work: () => void): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : "other";
  }
}

describe("orders and offers on the market copy", () => {
  it("lets the bot place offers on a funded copy before MarketOpened, while orders wait for open", () => {
    const state = funded();
    expect(offerRefusal(state, NOW)).toBeNull();
    expect(tradingRefusal(state, NOW)).toBe("The market is not open yet");
    expect(codeOf(() => assertOffersAccepted(state, NOW))).toBeNull();
    expect(codeOf(() => assertTradable(state, NOW))).toBe("market_not_open");
  });

  it("accepts both once the funded market is open and before its close time", () => {
    const open = applyOpened(funded(), opened, NOW).state;
    expect(open.status).toBe("open");
    expect(offerRefusal(open, NOW)).toBeNull();
    expect(tradingRefusal(open, NOW)).toBeNull();
    expect(offerRefusal(open, CLOSE)).toBe("The market is past its close time");
    expect(tradingRefusal(open, CLOSE)).toBe("The market is past its close time");
  });

  it("refuses offers and orders on an open copy that was never funded", () => {
    const open = applyOpened(null, opened, NOW).state;
    expect(offerRefusal(open, NOW)).toBe("The market is not funded yet");
    expect(tradingRefusal(open, NOW)).toBe("The market is not funded yet");
  });

  it("refuses offers and orders once the market is closed or resolved, with the status in the details", () => {
    const open = applyOpened(funded(), opened, NOW).state;
    const closed = applyClosed(open, { marketId: MARKET_1, version: 2, closedAt: NOW }, NOW).state;
    const resolved = applyResolved(closed, { marketId: MARKET_1, version: 3, outcome: "YES", resolvedAt: NOW, creatorId: CREATOR }, NOW).state;
    for (const state of [closed, resolved]) {
      expect(offerRefusal(state, NOW)).toBe(`The market is ${state.status}`);
      expect(codeOf(() => assertOffersAccepted(state, NOW))).toBe("market_not_open");
    }
    try {
      assertOffersAccepted(closed, NOW);
    } catch (error) {
      expect((error as DomainError).details).toEqual({ status: "closed" });
    }
  });
});

describe("the lifecycle fold (DM-04, DM-19)", () => {
  const LATER = new Date("2026-11-03T10:00:00.000Z");
  const resolvedFacts = (outcome: "YES" | "NO" | "INVALID", version: number, resolvedAt = NOW) => ({ marketId: MARKET_1, version, outcome, resolvedAt, creatorId: CREATOR });
  const closedCopy = () => applyClosed(applyOpened(funded(), opened, NOW).state, { marketId: MARKET_1, version: 2, closedAt: NOW }, NOW).state;

  it("keeps a resolved copy final: a later MarketResolved never changes its outcome, version or resolution time", () => {
    const invalid = applyResolved(closedCopy(), resolvedFacts("INVALID", 3), NOW).state;
    for (const outcome of ["YES", "NO", "INVALID"] as const) {
      const later = applyResolved(invalid, resolvedFacts(outcome, 4, LATER), LATER);
      expect(later.kind).toBe("stale");
      expect(later.state).toBe(invalid);
    }
    expect(invalid).toMatchObject({ status: "resolved", outcome: "INVALID", version: 3, resolvedAt: NOW });
  });

  it("never moves a copy back: a later MarketClosed or MarketOpened leaves a resolved copy resolved and a closed one closed", () => {
    const resolved = applyResolved(closedCopy(), resolvedFacts("YES", 3), NOW).state;
    expect(applyClosed(resolved, { marketId: MARKET_1, version: 4, closedAt: LATER }, LATER)).toEqual({ state: resolved, kind: "stale" });
    expect(applyOpened(resolved, { ...opened, version: 5, closeTime: LATER, openedAt: LATER }, LATER)).toEqual({ state: resolved, kind: "stale" });

    const closed = closedCopy();
    const reopened = applyOpened(closed, { ...opened, version: 3, closeTime: LATER }, LATER);
    expect(reopened).toEqual({ state: closed, kind: "stale" });
    expect(tradingRefusal(reopened.state, NOW)).toBe("The market is closed");
  });

  it("still fills the static facts of a copy that MarketResolved created, from a MarketOpened of any version", () => {
    const resolvedFirst = applyResolved(null, resolvedFacts("NO", 3), NOW).state;
    const filled = applyOpened(resolvedFirst, { ...opened, version: 4 }, LATER);
    expect(filled.kind).toBe("filled");
    expect(filled.state).toMatchObject({ status: "resolved", outcome: "NO", version: 3, question: opened.question, startingPriceMicro: 500_000, updatedAt: LATER });
  });

  it("moves a copy forward on a higher version: funded, open, closed, resolved, and an event may skip a stage", () => {
    const open = applyOpened(funded(), opened, NOW);
    expect(open).toMatchObject({ kind: "applied", state: { status: "open", version: 1 } });
    expect(applyResolved(open.state, resolvedFacts("YES", 3), NOW)).toMatchObject({ kind: "applied", state: { status: "resolved", outcome: "YES", version: 3 } });
    expect(applyClosed(funded(), { marketId: MARKET_1, version: 2, closedAt: NOW }, NOW)).toMatchObject({ kind: "applied", state: { status: "closed", version: 2 } });
  });
});
