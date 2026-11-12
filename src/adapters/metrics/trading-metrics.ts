// The metrics that only trading has, next to the HTTP metrics of metrics.ts (the same registry, the same listener). Two
// counters of the trader's orders, written around the use cases so that the use cases stay free of prom-client:
//
//   trading_trades_total{kind}                          executed trades: kind "buy" (POST /v1/trading/orders) or
//                                                       "sale" (POST /v1/trading/sales). A replay of a completed
//                                                       Idempotency-Key buys or sells nothing and is not counted.
//   trading_orders_refused_total{kind, reason,          refused orders and sales: reason is the stable error code of
//                                market_status}         the use case (a fixed set), market_status the status of the
//                                                       market when the refusal is market_not_open (funded, open when
//                                                       the close time has passed, closed, resolved), else "none".
//
// Every label has a bounded set of values: no market id, tenant or user ever becomes one (a tenant has the label of the
// HTTP metrics only).

import { Counter } from "prom-client";
import type { Registry } from "prom-client";
import { UseCaseError } from "../../usecases/errors.js";
import type { PlaceOrderUseCase, SellSharesUseCase, TradingUseCases } from "../../usecases/use-cases.js";

type Kind = "buy" | "sale";

/** The label value of a refusal that is not about the market's status, and of an unrecognised status. */
export const NO_MARKET_STATUS = "none";
/** The reason of a failure that is not a use-case error: a bug, logged with its stack by the application. */
export const INTERNAL_ERROR = "internal_error";

const STATUSES: readonly string[] = ["funded", "open", "closed", "resolved"];

/** The status a market_not_open refusal names in its details, "none" for any other error or an unknown status. */
export function marketStatusOf(error: unknown): string {
  if (!(error instanceof UseCaseError) || error.code !== "market_not_open") return NO_MARKET_STATUS;
  const status = error.details["status"];
  return typeof status === "string" && STATUSES.includes(status) ? status : NO_MARKET_STATUS;
}

/** The use cases of the public API with the two counters around the order and the sale; the others are returned as they are. */
export function instrumentTrading(registry: Registry, useCases: TradingUseCases): TradingUseCases {
  const trades = new Counter({
    name: "trading_trades_total",
    help: "Executed trades of traders, by kind: buy (an order) or sale. A replay of a completed Idempotency-Key is not counted.",
    labelNames: ["kind"] as const,
    registers: [registry],
  });
  const refused = new Counter({
    name: "trading_orders_refused_total",
    help: "Refused orders and sales, by kind, the error code of the refusal and, for market_not_open, the status of the market.",
    labelNames: ["kind", "reason", "market_status"] as const,
    registers: [registry],
  });

  const refuse = (kind: Kind, error: unknown): void => {
    const reason = error instanceof UseCaseError ? error.code : INTERNAL_ERROR;
    refused.inc({ kind, reason, market_status: marketStatusOf(error) });
  };

  const placeOrder: PlaceOrderUseCase = {
    execute: async (input) => {
      try {
        const placed = await useCases.placeOrder.execute(input);
        if (!placed.replayed) trades.inc({ kind: "buy" });
        return placed;
      } catch (error) {
        refuse("buy", error);
        throw error;
      }
    },
  };
  const sellShares: SellSharesUseCase = {
    execute: async (input) => {
      try {
        const placed = await useCases.sellShares.execute(input);
        if (!placed.replayed) trades.inc({ kind: "sale" });
        return placed;
      } catch (error) {
        refuse("sale", error);
        throw error;
      }
    },
  };
  return { ...useCases, placeOrder, sellShares };
}
