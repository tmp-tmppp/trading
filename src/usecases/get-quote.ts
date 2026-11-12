import { assertTradable } from "../domain/market-state.js";
import { quoteBuy } from "../domain/order-book.js";
import { parseMarketId } from "../domain/ledger.js";
import { parseCreditAmount, parseSide } from "../domain/units.js";
import { NotFound, TenantNotReady, guardDomain } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import type { GetQuoteUseCase, Quote, QuoteInput } from "./use-cases.js";

/**
 * What a buy of `amount` credits would cost now (GET /v1/trading/quote): the plan of a fill from the cheapest offer
 * up, without any change. Open to traders and tenant admins. The quote is not a promise: the next trade changes the
 * book, which is why an order may carry maxAveragePriceMicro (DM-18).
 */
export class GetQuote implements GetQuoteUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: QuoteInput): Promise<Quote> {
    const { store, clock } = this.deps;
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const side = guardDomain(() => parseSide(input.side));
    const amount = guardDomain(() => parseCreditAmount(input.amount));
    const tenant = await store.forTenant(input.actor.tenantId);
    if (!tenant) throw new TenantNotReady();

    const market = await tenant.repositories.marketStates.find(marketId);
    if (!market) throw new NotFound();
    const now = clock.now();
    guardDomain(() => assertTradable(market, now));
    // The market's sequence first, the book second: a trade in between makes the quote older, never newer, than its number.
    const book = await tenant.repositories.botOrders.get(marketId);
    const plan = guardDomain(() => quoteBuy(book.offers, side, amount));
    return {
      marketId,
      side,
      amount,
      sharesMicro: plan.sharesMicro,
      costMicro: plan.costMicro,
      averagePriceMicro: plan.averagePriceMicro,
      worstPriceMicro: plan.worstPriceMicro,
      fills: plan.fills,
      tradeSequence: market.tradeSequence,
      quotedAt: now,
    };
  }
}
