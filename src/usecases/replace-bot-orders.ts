import { botStreamId, parseMarketId } from "../domain/ledger.js";
import { assertOffersAccepted } from "../domain/market-state.js";
import { assertOffersBacked, parseOffers } from "../domain/order-book.js";
import { MarketNotOpen, NotFound, StaleSequence, ValidationFailed, guardDomain } from "./errors.js";
import { tenantStoreOfMarket, toBotBook } from "./get-bot-book.js";
import type { RuleDeps } from "./ports.js";
import type { BotBook, ReplaceBotOrdersInput, ReplaceBotOrdersUseCase } from "./use-cases.js";

/**
 * PUT bot-orders (ADR-041): the market maker replaces all offers of one market in one transaction. Checks in order:
 * the market copy (locked), `basedOnSequence` equals the market's trade sequence (else StaleSequence: a trade happened,
 * read the book again), the copy accepts offers (funded or open, before its close time, never closed or resolved), the
 * offers pass the domain checks (grid, one per price, at most MAX_OFFERS_PER_SIDE, not crossed) and the bot account
 * can back them (per side, offered shares <= its holding + its credits, so the book stays fillable after any fill).
 * An empty list cancels every offer. The bot account itself is only read: offers move no shares.
 */
export class ReplaceBotOrders implements ReplaceBotOrdersUseCase {
  constructor(private readonly deps: RuleDeps) {}

  async execute(input: ReplaceBotOrdersInput): Promise<BotBook> {
    const { store, clock, logger, rules } = this.deps;
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    if (!Number.isSafeInteger(input.basedOnSequence) || input.basedOnSequence < 0) {
      throw new ValidationFailed([{ field: "basedOnSequence", message: "basedOnSequence must be a non-negative integer" }]);
    }
    const { tenant, tenantId } = await tenantStoreOfMarket(store, marketId);

    const book = await tenant.transaction(async (repositories) => {
      const market = await repositories.marketStates.find(marketId, { lock: true });
      if (!market) throw new NotFound();
      // Read after the lock: the wait for the market row (orders, settlement) must not make the close-time check stale.
      const now = clock.now();
      if (input.basedOnSequence !== market.tradeSequence) throw new StaleSequence(market.tradeSequence);
      guardDomain(() => assertOffersAccepted(market, now));
      // One read for the check and for the book that answers: the limit the bot is told is the one applied.
      const { maxOffersPerSide } = rules.current();
      const offers = guardDomain(() => parseOffers(input.offers, maxOffersPerSide));
      const bot = await repositories.accounts.load(botStreamId(marketId), { lock: true, marketIds: [marketId] });
      if (!bot) throw new MarketNotOpen("The market has no bot account yet");
      guardDomain(() => assertOffersBacked(offers, bot));
      // The offers are priced on the sequence the bot read; an empty list leaves no book, so no sequence either.
      await repositories.botOrders.replace(marketId, offers, offers.length === 0 ? null : market.tradeSequence, now);
      return toBotBook(tenantId, market, bot, await repositories.botOrders.get(marketId), maxOffersPerSide);
    });
    logger.info({ tenantId, marketId, correlationId: input.caller.correlationId, client: input.caller.client, offers: book.offers.length }, "Bot offers replaced");
    return book;
  }
}
