import { botStreamId, holdingOf, parseMarketId } from "../domain/ledger.js";
import type { AccountState } from "../domain/ledger.js";
import type { MarketState } from "../domain/market-state.js";
import { NotFound, guardDomain } from "./errors.js";
import type { BotOrderBook, RuleDeps, Store, TenantStore } from "./ports.js";
import type { BotBook, BotBookInput, BotMarket, GetBotBookUseCase } from "./use-cases.js";

/** A market copy as the market maker sees it. */
export function toBotMarket(tenantId: string, market: MarketState): BotMarket {
  return {
    marketId: market.marketId,
    tenantId,
    status: market.status,
    version: market.version,
    closeTime: market.closeTime,
    startingPriceMicro: market.startingPriceMicro,
    fundingMicro: market.fundingMicro,
    tradeSequence: market.tradeSequence,
  };
}

/**
 * The book of a market: the bot account's credits and holdings, its offers, the two sequences (ADR-041) and the most
 * offers per side trading accepts now (`maxOffersPerSide`, the runtime rule the caller read).
 */
export function toBotBook(tenantId: string, market: MarketState, bot: AccountState | null, book: BotOrderBook, maxOffersPerSide: number): BotBook {
  const holding = bot === null ? { yesMicro: 0, noMicro: 0 } : holdingOf(bot, market.marketId);
  return {
    market: toBotMarket(tenantId, market),
    holdings: { balanceMicro: bot?.balanceMicro ?? 0, yesMicro: holding.yesMicro, noMicro: holding.noMicro },
    offers: book.offers,
    tradeSequence: market.tradeSequence,
    offersPricedOnSequence: book.offers.length === 0 ? null : book.pricedOnSequence,
    maxOffersPerSide,
  };
}

/** The tenant of a market and its store, from the market directory (the internal API names only the market). */
export async function tenantStoreOfMarket(store: Store, marketId: string): Promise<{ tenant: TenantStore; tenantId: string }> {
  const tenantId = await store.repositories.marketDirectory.tenantOf(marketId);
  if (tenantId === null) throw new NotFound();
  const tenant = await store.forTenant(tenantId);
  if (!tenant) throw new NotFound();
  return { tenant, tenantId };
}

/**
 * GET bot-book for the market maker (ADR-041): the market's trade sequence is the `basedOnSequence` of its next PUT, and
 * `maxOffersPerSide` is the runtime limit that PUT will be checked against (read from the rules holder on every request).
 */
export class GetBotBook implements GetBotBookUseCase {
  constructor(private readonly deps: Pick<RuleDeps, "store" | "rules">) {}

  async execute(input: BotBookInput): Promise<BotBook> {
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const { tenant, tenantId } = await tenantStoreOfMarket(this.deps.store, marketId);
    const { marketStates, accounts, botOrders } = tenant.repositories;
    // The sequence first, the book second: a trade in between makes the PUT that follows stale (409, read again),
    // never a book older than its sequence.
    const market = await marketStates.find(marketId);
    if (!market) throw new NotFound();
    const bot = await accounts.load(botStreamId(marketId), { marketIds: [marketId] });
    const book = await botOrders.get(marketId);
    return toBotBook(tenantId, market, bot, book, this.deps.rules.current().maxOffersPerSide);
  }
}
