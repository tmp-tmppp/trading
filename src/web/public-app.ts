import type { FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import type { TradingUseCases } from "../usecases/use-cases.js";
import { authenticate } from "./auth.js";
import type { AuthOptions } from "./auth.js";
import { createBaseApp } from "./context.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HealthChecks } from "./routes/health.js";
import { registerTradingRoutes } from "./routes/trading.js";

export interface PublicWebDeps {
  logger: PinoLogger;
  useCases: TradingUseCases;
  auth: AuthOptions;
  health: HealthChecks;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

/** A body of the public API is a few fields: 16 KiB is generous. */
const PUBLIC_BODY_LIMIT = 16 * 1024;

/** The public application (port 8080, gateway prefix /v1/trading), not started: tests call it with app.inject. */
export function buildPublicApp(deps: PublicWebDeps): FastifyInstance {
  const app = createBaseApp({ logger: deps.logger, bodyLimit: PUBLIC_BODY_LIMIT });
  // Before the routes, so that every response is counted, also the 404 of a path that matches no route.
  deps.metrics?.attach(app);
  registerHealthRoutes(app, deps.health);
  registerTradingRoutes(app, deps.useCases, authenticate(deps.auth));
  return app;
}
