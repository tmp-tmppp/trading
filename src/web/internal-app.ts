import type { FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import type { InternalUseCases } from "../usecases/use-cases.js";
import { createBaseApp } from "./context.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerLocalEventRoutes } from "./routes/local-events.js";
import type { LocalEventUseCases } from "./routes/local-events.js";
import { authenticateService, requireClient } from "./service-auth.js";
import type { ServiceAuthOptions } from "./service-auth.js";

export interface InternalWebDeps {
  logger: PinoLogger;
  useCases: InternalUseCases;
  auth: ServiceAuthOptions;
  /** Local mode without NATS only: the consumers' use cases behind POST /v1/internal/local/events. Null or absent: no such route. */
  local?: LocalEventUseCases | null;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

/** A replacement book is at most 100 offers of about 80 bytes each; 64 KiB leaves room for whitespace. */
const INTERNAL_BODY_LIMIT = 64 * 1024;

/**
 * The internal application (port 8081, 8091 in a local run): called by markets, payments and the market maker, never
 * routed by the gateway. It has no health routes: the probes run on the public port.
 */
export function buildInternalApp(deps: InternalWebDeps): FastifyInstance {
  const app = createBaseApp({ logger: deps.logger, bodyLimit: INTERNAL_BODY_LIMIT });
  // Before the routes, so that every response is counted, also the 404 of a path that matches no route.
  deps.metrics?.attach(app);
  const authenticate = authenticateService(deps.auth);
  registerInternalRoutes(app, deps.useCases, { authenticate, requireClient });
  if (deps.local) registerLocalEventRoutes(app, deps.local, authenticate);
  return app;
}
