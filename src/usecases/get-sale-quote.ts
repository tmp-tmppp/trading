import { parseMarketId } from "../domain/ledger.js";
import { assertTradable } from "../domain/market-state.js";
import { planSale } from "../domain/order-book.js";
import { parseSide } from "../domain/units.js";
import { NotFound, TenantNotReady, ValidationFailed, guardDomain } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import type { GetSaleQuoteUseCase, SaleQuote, SaleQuoteInput } from "./use-cases.js";

/** A number of microshares to sell: a positive safe integer (the JSON schema checks it too). */
export function parseSaleShares(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationFailed([{ field: "sharesMicro", message: "sharesMicro must be a positive safe integer (microshares)" }]);
  }
  return value;
}

/**
 * What a sale of `sharesMicro` of `side` would return now (GET /v1/trading/sale-quote, UC-08): the shares of the other
 * side bought from the cheapest offer up and the proceeds, without any change. The buy quote stays as it was; a sale is
 * quoted in shares, because a position is held in microshares and the trader sells what it holds. Open to traders and
 * tenant admins. It does not look at the caller's position: a quote is about the book (the sale checks the position).
 */
export class GetSaleQuote implements GetSaleQuoteUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: SaleQuoteInput): Promise<SaleQuote> {
    const { store, clock } = this.deps;
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const side = guardDomain(() => parseSide(input.side));
    const sharesMicro = parseSaleShares(input.sharesMicro);
    const tenant = await store.forTenant(input.actor.tenantId);
    if (!tenant) throw new TenantNotReady();

    const market = await tenant.repositories.marketStates.find(marketId);
    if (!market) throw new NotFound();
    const now = clock.now();
    guardDomain(() => assertTradable(market, now));
    // As the buy quote: the market's sequence first, the book second, so the quote is never newer than its number.
    const book = await tenant.repositories.botOrders.get(marketId);
    const plan = guardDomain(() => planSale(book.offers, side, sharesMicro));
    return {
      marketId,
      side,
      sharesMicro,
      proceedsMicro: plan.proceedsMicro,
      averagePriceMicro: plan.averagePriceMicro,
      costMicro: plan.costMicro,
      fills: plan.fills,
      tradeSequence: market.tradeSequence,
      quotedAt: now,
    };
  }
}
