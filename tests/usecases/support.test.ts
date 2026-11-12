import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { tradeExecutedEvent } from "../../src/domain/events.js";
import {
  ConcurrentUpdate,
  Conflict,
  Forbidden,
  IdempotencyKeyReused,
  InsufficientLiquidity,
  LedgerConflict,
  PriceLimitExceeded,
  UseCaseError,
  ValidationFailed,
  fromDomainError,
  guardDomain,
} from "../../src/usecases/errors.js";
import {
  decodeMarketCursor,
  encodeMarketCursor,
  eventMeta,
  lockOrder,
  orderScope,
  outboxMessage,
  pageSize,
  parseIdempotencyKey,
  requestHash,
  requireTrader,
  serviceMeta,
  stableStringify,
  userMeta,
  withConflictRetry,
} from "../../src/usecases/support.js";
import { MARKET_1, TENANT_A, actor, serviceCaller } from "../support/fakes.js";

describe("idempotency helpers", () => {
  it("hashes equal requests equally whatever their key order, and different ones differently", () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(requestHash({ marketId: MARKET_1, side: "YES", amount: 5 })).toBe(requestHash({ amount: 5, side: "YES", marketId: MARKET_1 }));
    expect(requestHash({ amount: 5 })).not.toBe(requestHash({ amount: 6 }));
    expect(orderScope("trader-1")).toBe("order:trader-1");
  });

  it("requires an Idempotency-Key of 8 to 128 visible characters", () => {
    expect(parseIdempotencyKey("018f3c1e-7a00-7000-8000-000000000101")).toBe("018f3c1e-7a00-7000-8000-000000000101");
    for (const bad of [undefined, "short", "has space inside", "x".repeat(129)]) expect(() => parseIdempotencyKey(bad)).toThrow(ValidationFailed);
  });
});

describe("events and meta", () => {
  it("builds the outbox row of an event and the ledger meta of each kind of caller", () => {
    const ctx = { eventId: "e-1", tenantId: TENANT_A, now: new Date(0), correlationId: "c", causationId: "r" };
    const event = tradeExecutedEvent(
      { tradeId: "t", marketId: MARKET_1, userId: "u", side: "NO", sharesMicro: 1, costMicro: 1, averagePriceMicro: 1, lastPriceMicro: 1, tradeSequence: 1, executedAt: "x", kind: "buy" },
      ctx,
    );
    expect(outboxMessage("TradeExecuted", event, MARKET_1, new Date(0))).toMatchObject({ id: "e-1", aggregateId: MARKET_1, subject: `chance.trading.TradeExecuted.${TENANT_A}` });
    expect(userMeta(actor("trader-1"))).toEqual({ correlationId: "corr-trader-1", causationId: "req-trader-1", actor: "trader-1" });
    expect(serviceMeta(serviceCaller("payments")).actor).toBe("client:payments");
    expect(eventMeta({ eventId: "ev", correlationId: null })).toEqual({ correlationId: "ev", causationId: "ev", actor: "system" });
  });
});

describe("rules and paging", () => {
  it("lets traders order and refuses tenant admins (question 9)", () => {
    expect(() => requireTrader("trader")).not.toThrow();
    expect(() => requireTrader("tenant-admin")).toThrow(Forbidden);
  });

  it("locks bot accounts first, then user accounts, each once", () => {
    expect(lockOrder(["account:b", `bot:${MARKET_1}`, "account:a", "account:b"])).toEqual([`bot:${MARKET_1}`, "account:a", "account:b"]);
  });

  it("round-trips market cursors and refuses crafted ones", () => {
    const cursor = encodeMarketCursor({ tenantId: TENANT_A, marketId: MARKET_1 });
    expect(decodeMarketCursor(cursor)).toEqual({ tenantId: TENANT_A, marketId: MARKET_1 });
    expect(decodeMarketCursor(undefined)).toBeNull();
    expect(() => decodeMarketCursor("not-json")).toThrow(ValidationFailed);
    expect(() => decodeMarketCursor(Buffer.from('{"t":"x","m":"y"}').toString("base64url"))).toThrow(ValidationFailed);
    expect(pageSize(undefined, 20, 100)).toBe(20);
    expect(() => pageSize(0, 20, 100)).toThrow(ValidationFailed);
    expect(() => pageSize(101, 20, 100)).toThrow(ValidationFailed);
  });

  it("decides again after a lost append and gives up with ConcurrentUpdate", async () => {
    let calls = 0;
    await expect(
      withConflictRetry(() => {
        calls += 1;
        return calls < 3 ? Promise.reject(new LedgerConflict("version", "account:a")) : Promise.resolve("done");
      }),
    ).resolves.toBe("done");
    await expect(withConflictRetry(() => Promise.reject(new LedgerConflict("business_key", "account:a")), 2)).rejects.toBeInstanceOf(ConcurrentUpdate);
    await expect(withConflictRetry(() => Promise.reject(new Error("other")))).rejects.toThrow("other");
  });
});

describe("domain errors as use-case errors", () => {
  it("maps rule violations to the answer a caller can act on", () => {
    expect(fromDomainError(new DomainError("invalid_amount", "bad", "amount"))).toBeInstanceOf(ValidationFailed);
    const crossed = fromDomainError(new DomainError("crossed_offers", "crossed", "offers")) as UseCaseError;
    expect([crossed.kind, crossed.code]).toEqual(["validation", "crossed_offers"]);
    const liquidity = fromDomainError(new DomainError("insufficient_liquidity", "x", "amount", { maxAmount: 12 }));
    expect(liquidity).toBeInstanceOf(InsufficientLiquidity);
    expect((liquidity as UseCaseError).details).toEqual({ maxAmount: 12 });
    expect(fromDomainError(new DomainError("price_limit_exceeded", "x", "m", { averagePriceMicro: 5 }))).toBeInstanceOf(PriceLimitExceeded);
    for (const code of ["insufficient_credits", "insufficient_holdings", "market_not_open", "market_closed"] as const) {
      const error = fromDomainError(new DomainError(code, "x")) as UseCaseError;
      expect(error).toBeInstanceOf(Conflict);
      expect(error.code).toBe(code);
    }
    const bug = fromDomainError(new DomainError("invariant_violated", "negative"));
    expect(bug).not.toBeInstanceOf(UseCaseError);
    expect(bug.message).toBe("invariant_violated: negative");
    expect(new IdempotencyKeyReused().kind).toBe("unprocessable");
  });

  it("guards domain code and lets other errors through", () => {
    expect(guardDomain(() => 7)).toBe(7);
    expect(() =>
      guardDomain(() => {
        throw new DomainError("invalid_side", "side", "side");
      }),
    ).toThrow(ValidationFailed);
    expect(() =>
      guardDomain(() => {
        throw new TypeError("boom");
      }),
    ).toThrow(TypeError);
  });
});
