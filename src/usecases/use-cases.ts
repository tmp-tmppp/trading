import type { MarketEventNotice, PaymentEventNotice } from "../domain/consumed.js";
import type { Fill } from "../domain/ledger.js";
import type { MarketStatus } from "../domain/market-state.js";
import type { Offer } from "../domain/order-book.js";
import type { TenantCreatedNotice } from "../domain/tenant.js";
import type { Outcome, Side } from "../domain/units.js";
import type { Actor, ServiceCaller } from "./ports.js";
import type { PageOf } from "./support.js";

// The use cases as the web layer, the consumers and the command-line tools see them. Each one is a class in its own
// file (src/usecases/<name>.ts) that implements the interface below; the composition roots wire the classes, and the
// callers depend on these interfaces only. Errors are those of ./errors.ts. Quantities are micro-units (domain/units.ts)
// except `amount`, which is whole credits.

// --- Public API (port 8080, gateway prefix /v1/trading) ---------------------------------------------------------

export interface QuoteInput {
  actor: Actor;
  marketId: string;
  /** "YES" or "NO"; the domain checks it again. */
  side: string;
  /** Whole credits to spend. */
  amount: number;
}

export interface Quote {
  marketId: string;
  side: Side;
  amount: number;
  sharesMicro: number;
  costMicro: number;
  averagePriceMicro: number;
  worstPriceMicro: number;
  fills: Fill[];
  /** The market's trade sequence the quote was computed on. */
  tradeSequence: number;
  quotedAt: Date;
}

/** Trader and tenant admin. Errors: ValidationFailed, NotFound, MarketNotOpen, InsufficientLiquidity, TenantNotReady. */
export interface GetQuoteUseCase {
  execute(input: QuoteInput): Promise<Quote>;
}

export interface PlaceOrderInput extends QuoteInput {
  /** The Idempotency-Key header (REL-03); the web layer passes it as it came. */
  idempotencyKey: string | undefined;
  /** DM-18: fill only at or below this average price (microcredits per share). */
  maxAveragePriceMicro?: number | undefined;
}

export interface PositionView {
  marketId: string;
  yesMicro: number;
  noMicro: number;
}

export interface OrderResult {
  tradeId: string;
  marketId: string;
  side: Side;
  amount: number;
  sharesMicro: number;
  costMicro: number;
  averagePriceMicro: number;
  worstPriceMicro: number;
  fills: Fill[];
  /** DM-17: the market's trade sequence after this trade, so the chart can wait for it. */
  tradeSequence: number;
  executedAt: Date;
  /** DM-17: read-your-writes from the write model. */
  balanceMicro: number;
  position: PositionView;
}

export interface PlacedOrder {
  result: OrderResult;
  /** True when the Idempotency-Key completed before: the stored result, nothing bought again (HTTP 200, else 201). */
  replayed: boolean;
}

/**
 * Traders only (tenant admins 403). One transaction: idempotency key, market copy (open, before close time), balance,
 * fills from the cheapest offer up (pairs created when the bot lacks shares), ledger appends on both streams with
 * expected versions, projections, remaining offers, trade sequence + 1, TradeExecuted into the outbox.
 * A completed key is answered before the runtime rules (REL-03): a retry of an executed order replays it even after
 * ORDER_AMOUNT_MAX was lowered or ORDERS_ENABLED switched off; the rules apply only to a newly claimed key.
 * Errors: Forbidden, ValidationFailed, NotFound, MarketNotOpen, InsufficientCredits, InsufficientLiquidity,
 * PriceLimitExceeded, IdempotencyKeyReused, OrdersPaused, ConcurrentUpdate, TenantNotReady.
 */
export interface PlaceOrderUseCase {
  execute(input: PlaceOrderInput): Promise<PlacedOrder>;
}

// --- Selling (UC-08): buy the other side from the bot and redeem the pairs, in one transaction ----------------------

export interface SaleQuoteInput {
  actor: Actor;
  marketId: string;
  /** The side to sell, "YES" or "NO"; the domain checks it again. */
  side: string;
  /** Microshares to sell. */
  sharesMicro: number;
}

export interface SaleQuote {
  marketId: string;
  /** The side sold. */
  side: Side;
  sharesMicro: number;
  /** sharesMicro - costMicro: what the sale would add to the balance. */
  proceedsMicro: number;
  /** floor(proceeds x 10^6 / shares): microcredits per share sold. */
  averagePriceMicro: number;
  /** What the same number of shares of the other side cost from the bot's offers. */
  costMicro: number;
  /** The levels of the other side, cheapest first, priced as the bot's offers of that side. */
  fills: Fill[];
  tradeSequence: number;
  quotedAt: Date;
}

/** Trader and tenant admin. Errors: ValidationFailed, NotFound, MarketNotOpen, InsufficientLiquidity, TenantNotReady. */
export interface GetSaleQuoteUseCase {
  execute(input: SaleQuoteInput): Promise<SaleQuote>;
}

export interface SellSharesInput extends SaleQuoteInput {
  /** The Idempotency-Key header (REL-03), bound to the body. */
  idempotencyKey: string | undefined;
  /** DM-18's counterpart: sell only if the proceeds are at least this (microcredits). */
  minProceedsMicro?: number | undefined;
}

export interface SaleResult {
  tradeId: string;
  marketId: string;
  side: Side;
  sharesMicro: number;
  proceedsMicro: number;
  averagePriceMicro: number;
  costMicro: number;
  fills: Fill[];
  /** DM-17: the market's trade sequence after this trade. */
  tradeSequence: number;
  executedAt: Date;
  /** DM-17: read-your-writes from the write model. */
  balanceMicro: number;
  position: PositionView;
}

export interface PlacedSale {
  result: SaleResult;
  /** True when the Idempotency-Key completed before with the same body: the stored result, nothing sold again. */
  replayed: boolean;
}

/**
 * Traders only (tenant admins 403). One transaction, as an order: idempotency key (the user's order scope: one key names
 * one trading request), the runtime pause, market copy (open, before close time), the position, the other side bought
 * from the cheapest offer up (pairs created when the bot lacks shares), the pairs redeemed, ledger appends on both
 * streams with expected versions, projections, remaining offers, trade sequence + 1, TradeExecuted (kind "sale").
 * Errors: Forbidden, ValidationFailed, NotFound, MarketNotOpen, InsufficientShares, InsufficientLiquidity,
 * ProceedsBelowMinimum, IdempotencyKeyReused, OrdersPaused, ConcurrentUpdate, TenantNotReady.
 */
export interface SellSharesUseCase {
  execute(input: SellSharesInput): Promise<PlacedSale>;
}

export interface PortfolioInput {
  actor: Actor;
  /** Entries of recentTrades and payouts, newest first (default 20, at most 100). */
  limit?: number | undefined;
}

export interface PortfolioPosition extends PositionView {
  /** From the market copy (DM-12); null until MarketOpened arrived. */
  question: string | null;
  status: MarketStatus | null;
  closeTime: Date | null;
}

export interface TradeEntry {
  tradeId: string;
  marketId: string;
  /** "buy": shares of `side` bought; "sale" (UC-08): shares of `side` sold. */
  kind: "buy" | "sale";
  side: Side;
  sharesMicro: number;
  /** A buy: what the shares cost. A sale: what the shares of the other side cost (the proceeds are shares - cost). */
  costMicro: number;
  /** A sale: what it added to the balance; null for a buy. */
  proceedsMicro: number | null;
  /** A buy: ceil(cost x 10^6 / shares) paid per share. A sale: floor(proceeds x 10^6 / shares) received per share. */
  averagePriceMicro: number;
  tradeSequence: number;
  executedAt: Date;
}

export interface PayoutEntry {
  marketId: string;
  /**
   * "winnings": winning shares paid; "refund": the net payment into a market resolved INVALID given back (UC-16);
   * "returned": what the bot account of a market the user funded held at resolution (for INVALID: the rest).
   */
  kind: "winnings" | "refund" | "returned";
  amountMicro: number;
  /** For winnings: the shares settled (losing shares pay 0); INVALID for a refund; null for a return. */
  outcome: Outcome | null;
  paidAt: Date;
}

export interface FundedMarket {
  marketId: string;
  question: string | null;
  status: MarketStatus | null;
  fundingMicro: number | null;
  /** What came back at resolution; null until the market is settled. */
  returnedMicro: number | null;
  settledAt: Date | null;
}

export interface Portfolio {
  balanceMicro: number;
  /** Whole credits a withdrawal may take now. */
  withdrawableCredits: number;
  /** Non-empty positions only. */
  positions: PortfolioPosition[];
  recentTrades: TradeEntry[];
  payouts: PayoutEntry[];
  /** Tenant admins only (UC-06): the markets they funded; null for traders. */
  fundedMarkets: FundedMarket[] | null;
}

/** Trader and tenant admin; a user without an account sees zeros. Errors: ValidationFailed, TenantNotReady. */
export interface GetPortfolioUseCase {
  execute(input: PortfolioInput): Promise<Portfolio>;
}

// --- Internal API (port 8081, not routed by the gateway) ---------------------------------------------------------

export interface FundMarketInput {
  caller: ServiceCaller;
  /** The Idempotency-Key header; must equal marketId. */
  idempotencyKey: string | undefined;
  marketId: string;
  tenantId: string;
  creatorId: string;
  /** Whole credits. */
  amount: number;
}

export interface MarketFunding {
  marketId: string;
  amount: number;
  fundedAt: Date;
}

export interface FundMarketResult {
  funding: MarketFunding;
  /** True for the first funding (201), false for a repeat of a funded key (200). */
  created: boolean;
}

/**
 * markets' opening saga (contracts/internal.openapi.yaml, markets' outgoing contract): only a completed funding is
 * stored under the key. Creates the market copy ("funded") or funds the one MarketOpened created, registers the market
 * in the directory, appends MarketFundingPaid and BotFunded, MarketFunded into the outbox.
 * The tenant comes from markets (trusted): `store.ensureTenant` provisions it when its TenantCreated was never seen.
 * Errors: ValidationFailed, InsufficientCredits (not stored), Conflict market_closed, IdempotencyKeyReused.
 */
export interface FundMarketUseCase {
  execute(input: FundMarketInput): Promise<FundMarketResult>;
}

export interface DebitInput {
  caller: ServiceCaller;
  /** The optional Idempotency-Key header; when present it must equal withdrawalId. */
  idempotencyKey: string | undefined;
  withdrawalId: string;
  tenantId: string;
  userId: string;
  amount: number;
}

/** Both answers are definitive and stored under the withdrawal id (payments' proposal): a repeat answers the same. */
export type DebitResult = { kind: "debited"; withdrawalId: string } | { kind: "insufficient_credits"; withdrawalId: string };

/**
 * payments' withdrawal saga (FL-C step 2). `store.ensureTenant` (payments is trusted); `withdrawalDirectory.register`
 * returns another tenant -> IdempotencyKeyReused (the per-tenant key cannot see the first call).
 * Errors: ValidationFailed, IdempotencyKeyReused.
 */
export interface DebitWithdrawalUseCase {
  execute(input: DebitInput): Promise<DebitResult>;
}

export interface BotMarket {
  marketId: string;
  tenantId: string;
  status: MarketStatus;
  version: number;
  closeTime: Date | null;
  startingPriceMicro: number | null;
  fundingMicro: number | null;
  tradeSequence: number;
}

export interface ListOpenMarketsInput {
  caller: ServiceCaller;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** The market maker's periodic check (ADR-041): open markets of every tenant, by tenant id and market id. */
export interface ListOpenMarketsUseCase {
  execute(input: ListOpenMarketsInput): Promise<PageOf<BotMarket>>;
}

export interface BotBookInput {
  caller: ServiceCaller;
  marketId: string;
}

export interface BotBook {
  market: BotMarket;
  /** The bot account of the market: credits and both holdings. */
  holdings: { balanceMicro: number; yesMicro: number; noMicro: number };
  offers: Offer[];
  /** The market's current trade sequence (= market.tradeSequence): the `basedOnSequence` a PUT bot-orders must send. */
  tradeSequence: number;
  /**
   * The trade sequence the current offers were priced on; null when there are none. Information only: a fill keeps it,
   * so after a trade it is lower than `tradeSequence` and a PUT that sent it would get 409 stale_sequence.
   */
  offersPricedOnSequence: number | null;
  /**
   * The runtime MAX_OFFERS_PER_SIDE in force when the book was read: a PUT bot-orders with more offers on one side is
   * refused, so the bot never posts more levels than this.
   */
  maxOffersPerSide: number;
}

/** GET bot-book; the tenant comes from the market directory. Errors: NotFound. */
export interface GetBotBookUseCase {
  execute(input: BotBookInput): Promise<BotBook>;
}

export interface ReplaceBotOrdersInput extends BotBookInput {
  /** Must equal the market's current trade sequence (BotBook.tradeSequence), else StaleSequence. */
  basedOnSequence: number;
  /** Checked by the domain (parseOffers); the web layer has checked the JSON shape. */
  offers: unknown;
}

/**
 * PUT bot-orders (ADR-041): replaces all offers of the market in one transaction, only on that market's bot account.
 * Accepted while the copy is "funded" or "open" (`assertOffersAccepted`): markets funds before it publishes
 * MarketOpened, so the bot's offers may rest before trading's own consumer has opened the market; orders wait for "open".
 * Errors: ValidationFailed (incl. crossed_offers), NotFound, StaleSequence, MarketNotOpen, Conflict insufficient_holdings.
 */
export interface ReplaceBotOrdersUseCase {
  execute(input: ReplaceBotOrdersInput): Promise<BotBook>;
}

// --- Consumers --------------------------------------------------------------------------------------------------

export type ProvisionTenantResult = "provisioned" | "duplicate";

/** TenantCreated, exactly as markets: inbox, schema, registry in one transaction. */
export interface ProvisionTenantUseCase {
  execute(notice: TenantCreatedNotice): Promise<ProvisionTenantResult>;
}

/** "settled" is "applied" for MarketResolved together with the settlement. */
export type MarketEventResult = "applied" | "filled" | "stale" | "settled" | "duplicate";

/**
 * MarketOpened, MarketClosed (also cancels the bot's offers) and MarketResolved (cancels the offers, settles once and
 * writes MarketSettled), each in one transaction with the inbox entry. The tenant comes from markets (trusted):
 * `store.ensureTenant`, so TenantNotReady never happens here. Any error: the consumer naks, and parks the event after
 * PARK_AFTER_DELIVERIES deliveries, so one failing event never holds back the events of other markets and tenants.
 */
export interface RecordMarketEventUseCase {
  execute(notice: MarketEventNotice): Promise<MarketEventResult>;
}

/** "no_debit": WithdrawalFailed for a withdrawal trading never debited: logged, nothing refunded, nothing published. */
export type PaymentEventResult = "credited" | "refunded" | "duplicate" | "no_debit";

/** DepositSucceeded (credit once per deposit) and WithdrawalFailed (refund once, WithdrawalRefunded). `store.ensureTenant`. */
export interface RecordPaymentEventUseCase {
  execute(notice: PaymentEventNotice): Promise<PaymentEventResult>;
}

// --- Operations (command-line tools, local seed) ----------------------------------------------------------------

export interface GrantCreditsInput {
  tenantId: string;
  userId: string;
  /** Whole credits. */
  amount: number;
  /** The business key: the same grant id never credits twice. */
  grantId: string;
  reason: string;
}

/** Test credits: seed data only (plan 6.2). Errors: ValidationFailed, TenantNotReady. */
export interface GrantCreditsUseCase {
  execute(input: GrantCreditsInput): Promise<"granted" | "duplicate">;
}

export interface ProjectionDifference {
  streamId: string;
  /** "unfoldable": the stream's events break an invariant, so there is no replayed state; `expected` is the message. */
  what: "missing" | "extra" | "balance" | "version" | "position" | "unfoldable";
  marketId?: string | undefined;
  expected: unknown;
  actual: unknown;
}

export interface ReplayReport {
  tenantId: string;
  events: number;
  streams: number;
  /** Empty when the stored projections equal the replay (the proof of DM-07). */
  differences: ProjectionDifference[];
  /** True when the projections were rewritten from the replay; false when no rebuild was asked for or one was refused (an unfoldable stream). */
  rebuilt: boolean;
}

/** Replays the tenant's whole ledger with evolve and compares (or, with rebuild, replaces) accounts and positions. */
export interface ReplayLedgerUseCase {
  execute(input: { tenantId: string; rebuild: boolean }): Promise<ReplayReport>;
}

/** What the public web app needs. */
export interface TradingUseCases {
  getQuote: GetQuoteUseCase;
  placeOrder: PlaceOrderUseCase;
  getSaleQuote: GetSaleQuoteUseCase;
  sellShares: SellSharesUseCase;
  getPortfolio: GetPortfolioUseCase;
}

/** What the internal web app needs. */
export interface InternalUseCases {
  fundMarket: FundMarketUseCase;
  debitWithdrawal: DebitWithdrawalUseCase;
  listOpenMarkets: ListOpenMarketsUseCase;
  getBotBook: GetBotBookUseCase;
  replaceBotOrders: ReplaceBotOrdersUseCase;
}
