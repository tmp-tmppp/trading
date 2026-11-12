import { describe, expect, it } from "vitest";
import type { Offer } from "../../src/domain/order-book.js";
import { MAX_PRICE_MICRO, MIN_PRICE_MICRO, PRICE_STEP_MICRO } from "../../src/domain/units.js";
import type { Outcome, Side } from "../../src/domain/units.js";
import { UseCaseError } from "../../src/usecases/errors.js";
import { serviceCaller } from "../support/fakes.js";
import { CREATOR, CREDIT, MARKET_1, TENANT_A, accountsOf, balanceOf, createCore, expectReplayEqual, grant, marketResolved, openMarket, order, putOffers, sell, systemValue } from "./core.js";
import type { Core } from "./core.js";

// Money conservation over random sequences of buys, sales (UC-08) and offer replacements on one market, then a YES, NO
// or INVALID resolution, all through the real use cases on the memory store. Each run is a deterministic seed. After
// every step the tenant's value (every balance plus the pairs in existence, with YES = NO in the market) equals what was
// granted; at the end the replay of the ledger equals the projections, the market's shares are gone and every
// microcredit is in a user's balance. For INVALID, each refund rests on the net payment the run itself counted.

const RUNS = 45;
const STEPS = 18;
const TRADERS = ["trader-a", "trader-b", "trader-c"];
const FUNDING = 500;
const GRANT = 300;
const EXPECTED_REFUSALS = new Set(["insufficient_liquidity", "insufficient_credits", "insufficient_shares", "proceeds_below_minimum", "insufficient_holdings"]);

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const steps = (MAX_PRICE_MICRO - MIN_PRICE_MICRO) / PRICE_STEP_MICRO;
const gridPrice = (random: () => number, from = MIN_PRICE_MICRO): number => {
  const first = (from - MIN_PRICE_MICRO) / PRICE_STEP_MICRO;
  return MIN_PRICE_MICRO + PRICE_STEP_MICRO * (first + Math.floor(random() * (steps - first + 1)));
};

/** A random book the bot account can back and that is not crossed; sometimes extreme (0.01 / 0.99), as a bad bot quotes. */
async function randomBook(core: Core, random: () => number): Promise<Offer[]> {
  const book = await core.useCases.getBotBook.execute({ caller: serviceCaller("market-maker"), marketId: MARKET_1 });
  const extreme = random() < 0.25;
  const bestYes = extreme ? pick(random, [MIN_PRICE_MICRO, MAX_PRICE_MICRO]) : gridPrice(random);
  const bestNo = extreme ? 1_000_000 - bestYes : gridPrice(random, Math.max(MIN_PRICE_MICRO, 1_000_000 - bestYes));
  const offers: Offer[] = [];
  for (const [side, best] of [["YES", bestYes], ["NO", bestNo]] as const) {
    const available = (side === "YES" ? book.holdings.yesMicro : book.holdings.noMicro) + book.holdings.balanceMicro;
    const levels = 1 + Math.floor(random() * 3);
    let price = best;
    let left = Math.floor(available * (0.3 + 0.7 * random()));
    for (let level = 0; level < levels && price <= MAX_PRICE_MICRO && left > 0; level += 1) {
      const sharesMicro = level === levels - 1 ? left : Math.floor(left * random());
      if (sharesMicro > 0) offers.push({ side, priceMicro: price, sharesMicro });
      left -= sharesMicro;
      price += PRICE_STEP_MICRO * (1 + Math.floor(random() * 5));
    }
  }
  return offers;
}

const holdingOf = (core: Core, userId: string) => accountsOf(core).find((account) => account.streamId === `account:${userId}`)?.positions[MARKET_1] ?? { yesMicro: 0, noMicro: 0 };

async function refusalOr<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof UseCaseError && EXPECTED_REFUSALS.has(error.code)) return null;
    throw error;
  }
}

describe("buys and sales in random order, then a resolution (property style, deterministic seeds)", () => {
  it(`keeps every microcredit over ${RUNS} runs of ${STEPS} steps each, with YES, NO and INVALID resolutions`, async () => {
    let sales = 0;
    let profitableSales = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const random = generator(seed);
      const core = await createCore();
      await openMarket(core, { credits: FUNDING, offers: [] });
      for (const userId of TRADERS) await grant(core, userId, GRANT);
      const granted = (FUNDING + GRANT * TRADERS.length) * CREDIT;
      const paid = new Map<string, number>(TRADERS.map((userId) => [userId, 0]));
      const returned = new Map<string, number>(TRADERS.map((userId) => [userId, 0]));
      await putOffers(core, MARKET_1, await randomBook(core, random));

      for (let step = 0; step < STEPS; step += 1) {
        const userId = pick(random, TRADERS);
        const side: Side = random() < 0.5 ? "YES" : "NO";
        const roll = random();
        if (roll < 0.2) {
          await putOffers(core, MARKET_1, await randomBook(core, random));
        } else if (roll < 0.55) {
          const credits = Math.floor(balanceOf(core, userId) / CREDIT);
          if (credits < 1) continue;
          const placed = await refusalOr(order(core, userId, { side, amount: 1 + Math.floor(random() * Math.min(credits, 60)) }));
          if (placed) paid.set(userId, (paid.get(userId) ?? 0) + placed.result.costMicro);
        } else {
          const held = side === "YES" ? holdingOf(core, userId).yesMicro : holdingOf(core, userId).noMicro;
          if (held < 1) continue;
          const sharesMicro = random() < 0.3 ? held : 1 + Math.floor(random() * held);
          const before = balanceOf(core, userId);
          const placed = await refusalOr(sell(core, userId, { side, sharesMicro }));
          if (placed) {
            sales += 1;
            expect(placed.result.proceedsMicro).toBe(sharesMicro - placed.result.costMicro);
            expect(balanceOf(core, userId)).toBe(before + placed.result.proceedsMicro);
            paid.set(userId, (paid.get(userId) ?? 0) + placed.result.costMicro);
            returned.set(userId, (returned.get(userId) ?? 0) + sharesMicro);
            if (placed.result.averagePriceMicro > 500_000) profitableSales += 1;
          }
        }
        expect(systemValue(core), `seed ${seed}, step ${step}`).toBe(granted);
      }
      await expectReplayEqual(core);

      const outcome: Outcome = (["YES", "NO", "INVALID"] as const)[seed % 3] ?? "YES";
      const before = new Map(TRADERS.map((userId) => [userId, { balance: balanceOf(core, userId), holding: holdingOf(core, userId) }]));
      await core.useCases.recordMarketEvent.execute(marketResolved(core, outcome));

      // Nothing of the market is left: no position, no bot credits; every microcredit is in a user's balance.
      for (const account of accountsOf(core)) expect(account.positions[MARKET_1] ?? { yesMicro: 0, noMicro: 0 }).toEqual({ yesMicro: 0, noMicro: 0 });
      expect(accountsOf(core).find((account) => account.kind === "bot")?.balanceMicro).toBe(0);
      expect([CREATOR, ...TRADERS].reduce((sum, userId) => sum + balanceOf(core, userId), 0), `seed ${seed} ${outcome}`).toBe(granted);
      if (outcome !== "INVALID") {
        for (const userId of TRADERS) {
          const { balance, holding } = before.get(userId) ?? { balance: 0, holding: { yesMicro: 0, noMicro: 0 } };
          expect(balanceOf(core, userId)).toBe(balance + (outcome === "YES" ? holding.yesMicro : holding.noMicro));
        }
      } else {
        const refunds = core.store.snapshot().tenantData[TENANT_A]?.ledger.filter((row) => row.type === "PositionRefunded") ?? [];
        for (const row of refunds) {
          const userId = row.streamId.slice("account:".length);
          if (!TRADERS.includes(userId)) continue;
          const data = row.data as { paidMicro: number; returnedMicro: number; refundMicro: number };
          // The refund basis is the net payment the run counted itself: buys and the other side of sales, minus the pairs returned.
          expect({ paid: data.paidMicro, returned: data.returnedMicro }).toEqual({ paid: paid.get(userId), returned: returned.get(userId) });
          expect(data.refundMicro).toBeLessThanOrEqual(Math.max(0, data.paidMicro - data.returnedMicro));
        }
      }
      await expectReplayEqual(core);
    }
    // The runs really sell, and some sales are at a profit (the INVALID refunds then rest on net payments).
    expect(sales).toBeGreaterThan(RUNS);
    expect(profitableSales).toBeGreaterThan(0);
  });
});
