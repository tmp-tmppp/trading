import { toBotMarket } from "./get-bot-book.js";
import type { Store } from "./ports.js";
import { DEFAULT_BOT_PAGE_SIZE, MAX_BOT_PAGE_SIZE, decodeMarketCursor, encodeMarketCursor, pageSize } from "./support.js";
import type { PageOf } from "./support.js";
import type { BotMarket, ListOpenMarketsInput, ListOpenMarketsUseCase } from "./use-cases.js";

/**
 * The market maker's periodic check (ADR-041): the open markets of every tenant, ordered by (tenant id, market id),
 * `limit` per page (default 100, at most 500). The cursor names the last item; the next page continues in that tenant
 * after that market and then with the following tenants. One extra row is read to know whether another page exists.
 */
export class ListOpenMarkets implements ListOpenMarketsUseCase {
  constructor(private readonly store: Store) {}

  async execute(input: ListOpenMarketsInput): Promise<PageOf<BotMarket>> {
    const size = pageSize(input.limit, DEFAULT_BOT_PAGE_SIZE, MAX_BOT_PAGE_SIZE);
    const position = decodeMarketCursor(input.cursor);
    const tenantIds = [...(await this.store.repositories.tenants.list())].sort();

    const items: BotMarket[] = [];
    for (const tenantId of tenantIds) {
      if (position !== null && tenantId < position.tenantId) continue;
      const tenant = await this.store.forTenant(tenantId);
      if (!tenant) continue;
      const afterId = position !== null && tenantId === position.tenantId ? position.marketId : null;
      const rows = await tenant.repositories.marketStates.listByStatus("open", { limit: size + 1 - items.length, afterId });
      items.push(...rows.map((row) => toBotMarket(tenantId, row)));
      if (items.length > size) break;
    }
    if (items.length <= size) return { items, nextCursor: null };
    const page = items.slice(0, size);
    const last = page[page.length - 1];
    return { items: page, nextCursor: last === undefined ? null : encodeMarketCursor({ tenantId: last.tenantId, marketId: last.marketId }) };
  }
}
