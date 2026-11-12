import { MARKET_STATUSES } from "../domain/market-state.js";
import { CREDIT_AMOUNT_MAX, OUTCOMES, SIDES } from "../domain/units.js";

// JSON schemas of the routes: they validate the input and shape the output. They mirror contracts/openapi.yaml and
// contracts/internal.openapi.yaml, and tests/contracts compares the routes with those files. What the domain decides
// (the market exists, the book can fill the order, ORDER_AMOUNT_MAX, the offers' backing) is the use cases' answer.
//
// A response schema also lists what may leave: a field that is not named here is dropped by the serializer.
const uuid = { type: "string", format: "uuid" } as const;
const dateTime = { type: "string", format: "date-time" } as const;
const nullableDateTime = { type: ["string", "null"] } as const;
const nullableText = { type: ["string", "null"] } as const;
const nullableInteger = { type: ["integer", "null"] } as const;
const integer = { type: "integer" } as const;
const side = { type: "string", enum: [...SIDES] } as const;
const marketStatus = { type: "string", enum: [...MARKET_STATUSES] } as const;
const nullableMarketStatus = { type: ["string", "null"], enum: [...MARKET_STATUSES, null] } as const;
const nullableOutcome = { type: ["string", "null"], enum: [...OUTCOMES, null] } as const;
const amount = { type: "integer", minimum: 1, maximum: CREDIT_AMOUNT_MAX } as const;
const userIdText = { type: "string", minLength: 1, maxLength: 255 } as const;

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

// A problem carries extension members (maxAmount, quote, tradeSequence, ...): any member may be added to the fixed ones.
export const problemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: integer,
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
  },
} as const;

const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const fill = {
  type: "object",
  properties: { priceMicro: integer, sharesMicro: integer, costMicro: integer },
} as const;

const quote = {
  type: "object",
  properties: {
    marketId: uuid,
    side,
    amount: integer,
    sharesMicro: integer,
    costMicro: integer,
    averagePriceMicro: integer,
    worstPriceMicro: integer,
    fills: { type: "array", items: fill },
    tradeSequence: integer,
    quotedAt: dateTime,
  },
} as const;

const position = {
  type: "object",
  properties: { marketId: uuid, yesMicro: integer, noMicro: integer },
} as const;

const order = {
  type: "object",
  properties: {
    tradeId: { type: "string" },
    marketId: uuid,
    side,
    amount: integer,
    sharesMicro: integer,
    costMicro: integer,
    averagePriceMicro: integer,
    worstPriceMicro: integer,
    fills: { type: "array", items: fill },
    tradeSequence: integer,
    executedAt: dateTime,
    balanceMicro: integer,
    position,
  },
} as const;

/** UC-08: microshares to sell, a positive safe integer. */
const sharesToSell = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;

const saleQuote = {
  type: "object",
  properties: {
    marketId: uuid,
    side,
    sharesMicro: integer,
    proceedsMicro: integer,
    averagePriceMicro: integer,
    costMicro: integer,
    fills: { type: "array", items: fill },
    tradeSequence: integer,
    quotedAt: dateTime,
  },
} as const;

const sale = {
  type: "object",
  properties: {
    tradeId: { type: "string" },
    marketId: uuid,
    side,
    sharesMicro: integer,
    proceedsMicro: integer,
    averagePriceMicro: integer,
    costMicro: integer,
    fills: { type: "array", items: fill },
    tradeSequence: integer,
    executedAt: dateTime,
    balanceMicro: integer,
    position,
  },
} as const;

const portfolio = {
  type: "object",
  properties: {
    balanceMicro: integer,
    withdrawableCredits: integer,
    positions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          marketId: uuid,
          yesMicro: integer,
          noMicro: integer,
          question: nullableText,
          status: nullableMarketStatus,
          closeTime: nullableDateTime,
        },
      },
    },
    recentTrades: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tradeId: { type: "string" },
          marketId: uuid,
          kind: { type: "string", enum: ["buy", "sale"] },
          side,
          sharesMicro: integer,
          costMicro: integer,
          proceedsMicro: nullableInteger,
          averagePriceMicro: integer,
          tradeSequence: integer,
          executedAt: dateTime,
        },
      },
    },
    payouts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          marketId: uuid,
          kind: { type: "string", enum: ["winnings", "refund", "returned"] },
          amountMicro: integer,
          outcome: nullableOutcome,
          paidAt: dateTime,
        },
      },
    },
    fundedMarkets: {
      type: ["array", "null"],
      items: {
        type: "object",
        properties: {
          marketId: uuid,
          question: nullableText,
          status: nullableMarketStatus,
          fundingMicro: nullableInteger,
          returnedMicro: nullableInteger,
          settledAt: nullableDateTime,
        },
      },
    },
  },
} as const;

const botMarket = {
  type: "object",
  properties: {
    marketId: uuid,
    tenantId: uuid,
    status: marketStatus,
    version: integer,
    closeTime: nullableDateTime,
    startingPriceMicro: nullableInteger,
    fundingMicro: nullableInteger,
    tradeSequence: integer,
  },
} as const;

const botOffer = {
  type: "object",
  properties: { side, priceMicro: integer, sharesMicro: integer },
} as const;

const botBook = {
  type: "object",
  properties: {
    market: botMarket,
    holdings: { type: "object", properties: { balanceMicro: integer, yesMicro: integer, noMicro: integer } },
    offers: { type: "array", items: botOffer },
    tradeSequence: integer,
    offersPricedOnSequence: nullableInteger,
    maxOffersPerSide: integer,
  },
} as const;

const marketIdParams = {
  type: "object",
  required: ["marketId"],
  properties: { marketId: uuid },
} as const;

/** What a client may send as an offer (internal.openapi.yaml, Offer): the grid and the side's backing are checked by the domain too. */
const offerInput = {
  type: "object",
  additionalProperties: false,
  required: ["side", "priceMicro", "sharesMicro"],
  properties: {
    side,
    priceMicro: { type: "integer", minimum: 10_000, maximum: 990_000, multipleOf: 10_000 },
    sharesMicro: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

export const schemas = {
  // --- public API ---
  getQuote: {
    querystring: {
      type: "object",
      additionalProperties: false,
      required: ["marketId", "side", "amount"],
      properties: { marketId: uuid, side, amount },
    },
    response: { 200: quote, ...errorResponses },
  },
  placeOrder: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["marketId", "side", "amount"],
      properties: {
        marketId: uuid,
        side,
        amount,
        maxAveragePriceMicro: { type: "integer", minimum: 1, maximum: 999_999 },
      },
    },
    response: { 200: order, 201: order, ...errorResponses },
  },
  getSaleQuote: {
    querystring: {
      type: "object",
      additionalProperties: false,
      required: ["marketId", "side", "sharesMicro"],
      properties: { marketId: uuid, side, sharesMicro: sharesToSell },
    },
    response: { 200: saleQuote, ...errorResponses },
  },
  sellShares: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["marketId", "side", "sharesMicro"],
      properties: {
        marketId: uuid,
        side,
        sharesMicro: sharesToSell,
        minProceedsMicro: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    response: { 200: sale, 201: sale, ...errorResponses },
  },
  getPortfolio: {
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    response: { 200: portfolio, ...errorResponses },
  },
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },

  // --- internal API ---
  fundMarket: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["marketId", "tenantId", "creatorId", "amount"],
      properties: { marketId: uuid, tenantId: uuid, creatorId: userIdText, amount },
    },
    response: {
      200: { type: "object", properties: { marketId: uuid, amount: integer, fundedAt: dateTime } },
      201: { type: "object", properties: { marketId: uuid, amount: integer, fundedAt: dateTime } },
      ...errorResponses,
    },
  },
  debitCredits: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["withdrawalId", "tenantId", "userId", "amount"],
      properties: { withdrawalId: uuid, tenantId: uuid, userId: userIdText, amount },
    },
    response: {
      200: { type: "object", properties: { withdrawalId: uuid, status: { type: "string" } } },
      ...errorResponses,
    },
  },
  listOpenMarkets: {
    querystring: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["open"] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    response: {
      200: { type: "object", properties: { items: { type: "array", items: botMarket }, nextCursor: { type: ["string", "null"] } } },
      ...errorResponses,
    },
  },
  getBotBook: {
    params: marketIdParams,
    response: { 200: botBook, ...errorResponses },
  },
  replaceBotOrders: {
    params: marketIdParams,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["basedOnSequence", "offers"],
      properties: {
        basedOnSequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        offers: { type: "array", maxItems: 100, items: offerInput },
      },
    },
    response: { 200: botBook, ...errorResponses },
  },
  localEvent: {
    body: { type: "object" },
    response: { 200: { type: "object", properties: { kind: { type: "string" }, result: { type: "string" } } }, ...errorResponses },
  },
} as const;
