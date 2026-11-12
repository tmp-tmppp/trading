import { MICROS_PER_UNIT, subMicro } from "./units.js";
import type { Outcome, Side } from "./units.js";

// Public integration events of trading as CloudEvents 1.0 (structured JSON), as markets and tenants publish theirs
// (ADR-053, DM-15). The shape is the contract in contracts/asyncapi.yaml. The ledger's own event types never leave
// trading (DM-08); these are written into the outbox in the same transaction as the ledger events (REL-01).
// Events carry ids and numbers, never names or e-mails (DM-14). Money and shares are micro-units (units.ts), except
// `amount` fields, which are whole credits exactly as payments and markets carry them.
export const EVENT_SOURCE = "/chance/trading";
export const SUBJECT_PREFIX = "chance.trading";

export type EventName = "TradeExecuted" | "MarketFunded" | "MarketSettled" | "WithdrawalRefunded";
export const EVENT_NAMES: readonly EventName[] = ["TradeExecuted", "MarketFunded", "MarketSettled", "WithdrawalRefunded"];

export interface CloudEvent<TData> {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  tenantid: string;
  correlationid: string;
  causationid: string;
  data: TData;
}

/** What the use case knows about the event it is writing. */
export interface EventContext {
  eventId: string;
  tenantId: string;
  now: Date;
  correlationId: string;
  causationId: string;
}

/** "buy": a trader bought `side`; "sale" (UC-08): a trader sold the other side, so `side` is what the bot sold to it. */
export type TradeKind = "buy" | "sale";

/**
 * A trade against the bot's offers (FL-A step 6, UC-08). market-data adds a price point; the bot re-prices (EP-1). A sale
 * of S shares of one side buys S shares of the other side from the bot and redeems the pairs, so its event describes
 * that buy (side, shares, cost and prices of the side bought) and adds `kind: "sale"`: the bot's book and the price move
 * exactly as for a buy of that side, and every reader that ignores `kind` stays right.
 */
export interface TradeExecutedData {
  tradeId: string;
  marketId: string;
  /** The trader's subject id (the buyer, or for a sale the seller). */
  userId: string;
  /** The side bought from the bot's offers (for a sale: the side other than the one sold). */
  side: Side;
  /** Microshares of `side` bought (the trade's share volume; for a sale also the shares sold). */
  sharesMicro: number;
  /**
   * Microcredits paid for them (the trade's credit volume). For a sale the seller received sharesMicro - costMicro: the
   * pairs pay sharesMicro, the shares of the other side cost costMicro.
   */
  costMicro: number;
  /** Of the side bought. */
  averagePriceMicro: number;
  /** The price of the most expensive level the trade used, of the side bought. */
  lastPriceMicro: number;
  /**
   * lastPriceMicro as the price of YES (market-data's price_yes, plan 6.3): equal for a YES buy, 1 000 000 minus it for
   * a NO buy, because a YES share and a NO share together are worth exactly one credit.
   */
  yesPriceMicro: number;
  /** The market's trade sequence after this trade (1, 2, ...); the bot sends it back as basedOnSequence. */
  tradeSequence: number;
  executedAt: string;
  /** Optional in the contract (added with UC-08; a reader that does not know it treats the trade as a buy of `side`). */
  kind: TradeKind;
}

/** What the use case supplies; tradeExecutedEvent derives yesPriceMicro so no caller can get the conversion wrong. */
export type TradeExecutedInput = Omit<TradeExecutedData, "yesPriceMicro">;

/** A price of `side` expressed as the price of YES. */
export function yesPriceOf(side: Side, priceMicro: number): number {
  return side === "YES" ? priceMicro : subMicro(MICROS_PER_UNIT, priceMicro);
}

/** The creator's funding became pairs in the market's bot account (FL-A step 2). */
export interface MarketFundedData {
  marketId: string;
  creatorId: string;
  /** Whole credits, as in the funding call and markets' fundingAmount. */
  amount: number;
  fundedAt: string;
}

/**
 * Every winning share of the market is paid and the creator got back what the bot account held (FL-A step 10). For
 * INVALID (UC-16) nothing wins: payoutTotalMicro and payoutCount are the traders' refunds of their net payments, and
 * returnedToCreatorMicro the rest of what the market held.
 */
export interface MarketSettledData {
  marketId: string;
  outcome: Outcome;
  creatorId: string;
  /** Paid to users for winning shares. */
  payoutTotalMicro: number;
  payoutCount: number;
  returnedToCreatorMicro: number;
  settledAt: string;
}

/** The credits of a failed withdrawal are back in the balance (FL-C step 7; payments' proposal, its asyncapi.yaml). */
export interface WithdrawalRefundedData {
  withdrawalId: string;
  userId: string;
  /** Whole credits, the amount the debit took. */
  amount: number;
  refundedAt: string;
}

export function eventType(name: EventName): string {
  return `si.chance.trading.${name}.v1`;
}

/** NATS subject of an event: chance.trading.<Event>.<tenantId> (stream TRADING). */
export function natsSubject(name: EventName, tenantId: string): string {
  return `${SUBJECT_PREFIX}.${name}.${tenantId}`;
}

export function marketSubject(marketId: string): string {
  return `market/${marketId}`;
}

export function withdrawalSubject(withdrawalId: string): string {
  return `withdrawal/${withdrawalId}`;
}

function envelope<TData>(name: EventName, subject: string, ctx: EventContext, data: TData): CloudEvent<TData> {
  return {
    specversion: "1.0",
    id: ctx.eventId,
    source: EVENT_SOURCE,
    type: eventType(name),
    subject,
    time: ctx.now.toISOString(),
    datacontenttype: "application/json",
    tenantid: ctx.tenantId,
    correlationid: ctx.correlationId,
    causationid: ctx.causationId,
    data,
  };
}

export function tradeExecutedEvent(input: TradeExecutedInput, ctx: EventContext): CloudEvent<TradeExecutedData> {
  const data: TradeExecutedData = { ...input, yesPriceMicro: yesPriceOf(input.side, input.lastPriceMicro) };
  return envelope("TradeExecuted", marketSubject(data.marketId), ctx, data);
}

export function marketFundedEvent(data: MarketFundedData, ctx: EventContext): CloudEvent<MarketFundedData> {
  return envelope("MarketFunded", marketSubject(data.marketId), ctx, data);
}

export function marketSettledEvent(data: MarketSettledData, ctx: EventContext): CloudEvent<MarketSettledData> {
  return envelope("MarketSettled", marketSubject(data.marketId), ctx, data);
}

export function withdrawalRefundedEvent(data: WithdrawalRefundedData, ctx: EventContext): CloudEvent<WithdrawalRefundedData> {
  return envelope("WithdrawalRefunded", withdrawalSubject(data.withdrawalId), ctx, data);
}
