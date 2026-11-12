import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServiceClient } from "../../usecases/ports.js";
import { InsufficientCredits } from "../../usecases/errors.js";
import type { BotBook, BotMarket, InternalUseCases } from "../../usecases/use-cases.js";
import type { RequestHook } from "../auth.js";
import { schemas } from "../schemas.js";
import { serviceCallerOf } from "../service-auth.js";

const botMarketBody = (market: BotMarket) => ({
  marketId: market.marketId,
  tenantId: market.tenantId,
  status: market.status,
  version: market.version,
  closeTime: market.closeTime?.toISOString() ?? null,
  startingPriceMicro: market.startingPriceMicro,
  fundingMicro: market.fundingMicro,
  tradeSequence: market.tradeSequence,
});

/** The bot's book as `components/schemas/BotBook` of contracts/internal.openapi.yaml. */
export const botBookBody = (book: BotBook) => ({
  market: botMarketBody(book.market),
  holdings: { balanceMicro: book.holdings.balanceMicro, yesMicro: book.holdings.yesMicro, noMicro: book.holdings.noMicro },
  offers: book.offers.map((offer) => ({ side: offer.side, priceMicro: offer.priceMicro, sharesMicro: offer.sharesMicro })),
  tradeSequence: book.tradeSequence,
  offersPricedOnSequence: book.offersPricedOnSequence,
  maxOffersPerSide: book.maxOffersPerSide,
});

/** The header as the caller sent it; the use cases check what it must equal. */
function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" ? value : undefined;
}

interface MarketParams {
  marketId: string;
}

/**
 * The internal port: market funding (markets), debits (payments), the market maker's endpoints. Authentication is an
 * onRequest hook (401 first); each endpoint admits exactly one client, checked in preValidation (403 before the
 * validation of the body, the query or the path). The tenant is never read from the token: the funding and the debit
 * name it in the body, the bot endpoints take it from the market (plan section 9).
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  useCases: InternalUseCases,
  hooks: { authenticate: RequestHook; requireClient: (client: ServiceClient) => RequestHook },
): void {
  const { authenticate, requireClient } = hooks;

  // 201: funded now. 200: a repeat of a funded key. A refusal (409, 422) is stored nowhere, so markets repeats the key.
  app.post<{ Body: { marketId: string; tenantId: string; creatorId: string; amount: number } }>(
    "/v1/internal/market-funding",
    { schema: schemas.fundMarket, onRequest: authenticate, preValidation: requireClient("markets") },
    async (request, reply) => {
      const { funding, created } = await useCases.fundMarket.execute({
        caller: serviceCallerOf(request),
        idempotencyKey: idempotencyKeyOf(request),
        marketId: request.body.marketId,
        tenantId: request.body.tenantId,
        creatorId: request.body.creatorId,
        amount: request.body.amount,
      });
      return reply.code(created ? 201 : 200).send({ marketId: funding.marketId, amount: funding.amount, fundedAt: funding.fundedAt.toISOString() });
    },
  );

  // 200 debited, 409 too few credits: both definitive and stored under the withdrawal id (payments' proposal).
  app.post<{ Body: { withdrawalId: string; tenantId: string; userId: string; amount: number } }>(
    "/v1/internal/debits",
    { schema: schemas.debitCredits, onRequest: authenticate, preValidation: requireClient("payments") },
    async (request, reply) => {
      const result = await useCases.debitWithdrawal.execute({
        caller: serviceCallerOf(request),
        idempotencyKey: idempotencyKeyOf(request),
        withdrawalId: request.body.withdrawalId,
        tenantId: request.body.tenantId,
        userId: request.body.userId,
        amount: request.body.amount,
      });
      if (result.kind === "insufficient_credits") throw new InsufficientCredits("The user's credits are too few for this withdrawal");
      return reply.code(200).send({ withdrawalId: result.withdrawalId, status: "debited" });
    },
  );

  app.get<{ Querystring: { status: "open"; limit?: number; cursor?: string } }>(
    "/v1/internal/markets",
    { schema: schemas.listOpenMarkets, onRequest: authenticate, preValidation: requireClient("market-maker") },
    async (request) => {
      const page = await useCases.listOpenMarkets.execute({ caller: serviceCallerOf(request), limit: request.query.limit, cursor: request.query.cursor });
      return { items: page.items.map(botMarketBody), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: MarketParams }>(
    "/v1/internal/markets/:marketId/bot-book",
    { schema: schemas.getBotBook, onRequest: authenticate, preValidation: requireClient("market-maker") },
    async (request) => botBookBody(await useCases.getBotBook.execute({ caller: serviceCallerOf(request), marketId: request.params.marketId.toLowerCase() })),
  );

  app.put<{ Params: MarketParams; Body: { basedOnSequence: number; offers: unknown[] } }>(
    "/v1/internal/markets/:marketId/bot-orders",
    { schema: schemas.replaceBotOrders, onRequest: authenticate, preValidation: requireClient("market-maker") },
    async (request) =>
      botBookBody(
        await useCases.replaceBotOrders.execute({
          caller: serviceCallerOf(request),
          marketId: request.params.marketId.toLowerCase(),
          basedOnSequence: request.body.basedOnSequence,
          offers: request.body.offers,
        }),
      ),
  );
}
