import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  FundedMarket,
  OrderResult,
  PayoutEntry,
  Portfolio,
  PortfolioPosition,
  Quote,
  SaleQuote,
  SaleResult,
  TradeEntry,
  TradingUseCases,
} from "../../usecases/use-cases.js";
import { memberHook, traderHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { actorOf } from "../context.js";
import { schemas } from "../schemas.js";

const fillBody = (fill: { priceMicro: number; sharesMicro: number; costMicro: number }) => ({
  priceMicro: fill.priceMicro,
  sharesMicro: fill.sharesMicro,
  costMicro: fill.costMicro,
});

/** A quote as `components/schemas/Quote` of contracts/openapi.yaml: dates as ISO 8601 text. */
export const quoteBody = (quote: Quote) => ({
  marketId: quote.marketId,
  side: quote.side,
  amount: quote.amount,
  sharesMicro: quote.sharesMicro,
  costMicro: quote.costMicro,
  averagePriceMicro: quote.averagePriceMicro,
  worstPriceMicro: quote.worstPriceMicro,
  fills: quote.fills.map(fillBody),
  tradeSequence: quote.tradeSequence,
  quotedAt: quote.quotedAt.toISOString(),
});

/** An executed order as `components/schemas/Order`. */
export const orderBody = (order: OrderResult) => ({
  tradeId: order.tradeId,
  marketId: order.marketId,
  side: order.side,
  amount: order.amount,
  sharesMicro: order.sharesMicro,
  costMicro: order.costMicro,
  averagePriceMicro: order.averagePriceMicro,
  worstPriceMicro: order.worstPriceMicro,
  fills: order.fills.map(fillBody),
  tradeSequence: order.tradeSequence,
  executedAt: order.executedAt.toISOString(),
  balanceMicro: order.balanceMicro,
  position: { marketId: order.position.marketId, yesMicro: order.position.yesMicro, noMicro: order.position.noMicro },
});

/** A sale quote as `components/schemas/SaleQuote` (UC-08). */
export const saleQuoteBody = (quote: SaleQuote) => ({
  marketId: quote.marketId,
  side: quote.side,
  sharesMicro: quote.sharesMicro,
  proceedsMicro: quote.proceedsMicro,
  averagePriceMicro: quote.averagePriceMicro,
  costMicro: quote.costMicro,
  fills: quote.fills.map(fillBody),
  tradeSequence: quote.tradeSequence,
  quotedAt: quote.quotedAt.toISOString(),
});

/** An executed sale as `components/schemas/Sale` (UC-08, DM-17). */
export const saleBody = (sale: SaleResult) => ({
  tradeId: sale.tradeId,
  marketId: sale.marketId,
  side: sale.side,
  sharesMicro: sale.sharesMicro,
  proceedsMicro: sale.proceedsMicro,
  averagePriceMicro: sale.averagePriceMicro,
  costMicro: sale.costMicro,
  fills: sale.fills.map(fillBody),
  tradeSequence: sale.tradeSequence,
  executedAt: sale.executedAt.toISOString(),
  balanceMicro: sale.balanceMicro,
  position: { marketId: sale.position.marketId, yesMicro: sale.position.yesMicro, noMicro: sale.position.noMicro },
});

const positionBody = (position: PortfolioPosition) => ({
  marketId: position.marketId,
  yesMicro: position.yesMicro,
  noMicro: position.noMicro,
  question: position.question,
  status: position.status,
  closeTime: position.closeTime?.toISOString() ?? null,
});

const tradeBody = (trade: TradeEntry) => ({
  tradeId: trade.tradeId,
  marketId: trade.marketId,
  kind: trade.kind,
  side: trade.side,
  sharesMicro: trade.sharesMicro,
  costMicro: trade.costMicro,
  proceedsMicro: trade.proceedsMicro,
  averagePriceMicro: trade.averagePriceMicro,
  tradeSequence: trade.tradeSequence,
  executedAt: trade.executedAt.toISOString(),
});

const payoutBody = (payout: PayoutEntry) => ({
  marketId: payout.marketId,
  kind: payout.kind,
  amountMicro: payout.amountMicro,
  outcome: payout.outcome,
  paidAt: payout.paidAt.toISOString(),
});

const fundedMarketBody = (market: FundedMarket) => ({
  marketId: market.marketId,
  question: market.question,
  status: market.status,
  fundingMicro: market.fundingMicro,
  returnedMicro: market.returnedMicro,
  settledAt: market.settledAt?.toISOString() ?? null,
});

/** The portfolio as `components/schemas/Portfolio`; `fundedMarkets` stays null for a trader. */
export const portfolioBody = (portfolio: Portfolio) => ({
  balanceMicro: portfolio.balanceMicro,
  withdrawableCredits: portfolio.withdrawableCredits,
  positions: portfolio.positions.map(positionBody),
  recentTrades: portfolio.recentTrades.map(tradeBody),
  payouts: portfolio.payouts.map(payoutBody),
  fundedMarkets: portfolio.fundedMarkets === null ? null : portfolio.fundedMarkets.map(fundedMarketBody),
});

/** The Idempotency-Key as the client sent it; the use case checks its form (8 to 128 visible ASCII characters). */
function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Routes of the caller's trading data. Authentication is an onRequest hook (401 first); the role checks run in
 * preValidation, before the query or the body is validated, so a caller without rights learns nothing from validation.
 * The tenant is never read from the request: the use cases get it from the token (actorOf). Orders are for traders only.
 */
export function registerTradingRoutes(app: FastifyInstance, useCases: TradingUseCases, authenticate: RequestHook): void {
  app.get<{ Querystring: { marketId: string; side: string; amount: number } }>(
    "/v1/trading/quote",
    { schema: schemas.getQuote, onRequest: authenticate, preValidation: memberHook },
    async (request) =>
      quoteBody(
        await useCases.getQuote.execute({
          actor: actorOf(request),
          marketId: request.query.marketId.toLowerCase(),
          side: request.query.side,
          amount: request.query.amount,
        }),
      ),
  );

  // 201: bought now. 200: the Idempotency-Key completed before with the same body; nothing was bought again (REL-03).
  app.post<{ Body: { marketId: string; side: string; amount: number; maxAveragePriceMicro?: number } }>(
    "/v1/trading/orders",
    { schema: schemas.placeOrder, onRequest: authenticate, preValidation: traderHook },
    async (request, reply) => {
      const { result, replayed } = await useCases.placeOrder.execute({
        actor: actorOf(request),
        idempotencyKey: idempotencyKeyOf(request),
        marketId: request.body.marketId.toLowerCase(),
        side: request.body.side,
        amount: request.body.amount,
        maxAveragePriceMicro: request.body.maxAveragePriceMicro,
      });
      return reply.code(replayed ? 200 : 201).send(orderBody(result));
    },
  );

  // UC-08: what a sale of `sharesMicro` would return now; the buy quote above stays as it is.
  app.get<{ Querystring: { marketId: string; side: string; sharesMicro: number } }>(
    "/v1/trading/sale-quote",
    { schema: schemas.getSaleQuote, onRequest: authenticate, preValidation: memberHook },
    async (request) =>
      saleQuoteBody(
        await useCases.getSaleQuote.execute({
          actor: actorOf(request),
          marketId: request.query.marketId.toLowerCase(),
          side: request.query.side,
          sharesMicro: request.query.sharesMicro,
        }),
      ),
  );

  // UC-08. 201: sold now. 200: the Idempotency-Key completed before with the same body; nothing was sold again (REL-03).
  app.post<{ Body: { marketId: string; side: string; sharesMicro: number; minProceedsMicro?: number } }>(
    "/v1/trading/sales",
    { schema: schemas.sellShares, onRequest: authenticate, preValidation: traderHook },
    async (request, reply) => {
      const { result, replayed } = await useCases.sellShares.execute({
        actor: actorOf(request),
        idempotencyKey: idempotencyKeyOf(request),
        marketId: request.body.marketId.toLowerCase(),
        side: request.body.side,
        sharesMicro: request.body.sharesMicro,
        minProceedsMicro: request.body.minProceedsMicro,
      });
      return reply.code(replayed ? 200 : 201).send(saleBody(result));
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    "/v1/trading/portfolio",
    { schema: schemas.getPortfolio, onRequest: authenticate, preValidation: memberHook },
    async (request) => portfolioBody(await useCases.getPortfolio.execute({ actor: actorOf(request), limit: request.query.limit })),
  );
}
