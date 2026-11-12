import { createRemoteJWKSet } from "jose";
import type pg from "pg";
import { MemoryEventPublisher } from "./adapters/memory/memory-publisher.js";
import { MemoryStore } from "./adapters/memory/memory-store.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { instrumentTrading } from "./adapters/metrics/trading-metrics.js";
import { MARKETS_CONSUMER, PAYMENTS_CONSUMER, TENANTS_CONSUMER, JetStreamConsumer } from "./adapters/nats/jetstream-consumer.js";
import { handleMarketMessage, handlePaymentMessage, handleTenantCreatedMessage } from "./adapters/nats/message-handlers.js";
import { NatsEventPublisher } from "./adapters/nats/nats-event-publisher.js";
import { OutboxRelay } from "./adapters/outbox/relay.js";
import { streamMaxAgeMs } from "./adapters/retention.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "./adapters/runtime-config.js";
import { randomIds, systemClock } from "./adapters/system.js";
import { ConfigError, loadConfig, runtimeKeysInEnv, runtimeSettingsOf } from "./config.js";
import { createLogger } from "./logger.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";
import { DebitWithdrawal } from "./usecases/debit-withdrawal.js";
import { FundMarket } from "./usecases/fund-market.js";
import { GetBotBook } from "./usecases/get-bot-book.js";
import { GetPortfolio } from "./usecases/get-portfolio.js";
import { GetQuote } from "./usecases/get-quote.js";
import { GrantCredits } from "./usecases/grant-credits.js";
import { ListOpenMarkets } from "./usecases/list-open-markets.js";
import { PlaceOrder } from "./usecases/place-order.js";
import { GetSaleQuote } from "./usecases/get-sale-quote.js";
import { SellShares } from "./usecases/sell-shares.js";
import type { EventPublisher, Store } from "./usecases/ports.js";
import { ProvisionTenant } from "./usecases/provision-tenant.js";
import { RecordMarketEvent } from "./usecases/record-market-event.js";
import { RecordPaymentEvent } from "./usecases/record-payment-event.js";
import { ReplaceBotOrders } from "./usecases/replace-bot-orders.js";
import { requestHash } from "./usecases/support.js";
import { DebitsGrpcServer } from "./web/grpc/debits-server.js";
import { tenantOfRequest } from "./web/auth.js";
import { buildInternalApp } from "./web/internal-app.js";
import { buildPublicApp } from "./web/public-app.js";

// Composition root: configuration -> adapters -> use cases -> the two web applications and the gRPC server. Nothing else wires things together.

const MIGRATION_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting trading");

  // Runtime settings (ADR-037): the use cases read the trading rules from the holder on every request; the watcher
  // replaces them, and the log level, when the mounted file changes. A runtime key that the environment sets keeps its
  // environment value whatever the file says (`setInEnv`). Without a file the startup values stay.
  const rules = new RuntimeSettingsHolder(runtimeSettingsOf(config));
  const runtimeConfig = config.runtimeConfigFile
    ? new RuntimeConfigWatcher({
        file: config.runtimeConfigFile,
        pollMs: config.runtimeConfigPollMs,
        startup: runtimeSettingsOf(config),
        setInEnv: runtimeKeysInEnv(process.env),
        current: () => rules.get(),
        logger,
        onChange: (settings) => {
          rules.set(settings);
          logger.level = settings.logLevel;
        },
      })
    : null;

  // Adapters. Without a setting, only APP_ENV=local falls back to memory; loadConfig has refused anything else.
  let store: Store;
  let pool: pg.Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.databasePoolMax, logger);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runMigrations(pool, logger);
        break;
      } catch (error) {
        if (attempt >= MIGRATION_ATTEMPTS) throw error;
        logger.warn({ attempt, err: error }, "The database is not ready for migrations, trying again");
        await sleep(3000);
      }
    }
    store = new PostgresStore(pool, logger);
  } else {
    logger.warn({}, "DATABASE_URL is not set: keeping all data in memory (APP_ENV=local)");
    // A tenant is registered on its first request, because no TenantCreated arrives without a database and a broker.
    store = new MemoryStore({ autoProvision: true, logger });
  }

  let publisher: EventPublisher;
  let nats: NatsEventPublisher | null = null;
  // One max age for the stream and for the relay's purge of published rows, so that the two always agree.
  const streamMaxAge = streamMaxAgeMs(config.streamMaxAgeDays);
  if (config.natsUrl) {
    nats = new NatsEventPublisher(config.natsUrl, logger, streamMaxAge);
    publisher = nats;
    // The service starts without the broker; events wait in the outbox until it answers.
    nats.ready().catch((error: unknown) => logger.warn({ err: error }, "NATS is not reachable yet; events wait in the outbox"));
  } else {
    logger.warn({}, "NATS_URL is not set: events are only logged (APP_ENV=local)");
    publisher = new MemoryEventPublisher(logger);
  }

  // Use cases.
  const deps = { store, clock: systemClock, ids: randomIds, logger };
  // Request metrics, one registry and one listener for both HTTP applications: the tenant label is the tenant of the
  // verified token (request.auth is set only after the check; a service token names no tenant, so the internal API is
  // "none"). The two counters of the orders are written around the use cases of the public API.
  const metrics = createMetrics({ tenantOf: tenantOfRequest });
  const publicUseCases = instrumentTrading(metrics.registry, {
    getQuote: new GetQuote(deps),
    placeOrder: new PlaceOrder({ ...deps, rules }),
    getSaleQuote: new GetSaleQuote(deps),
    sellShares: new SellShares({ ...deps, rules }),
    getPortfolio: new GetPortfolio(deps),
  });
  const internalUseCases = {
    fundMarket: new FundMarket(deps),
    debitWithdrawal: new DebitWithdrawal(deps),
    listOpenMarkets: new ListOpenMarkets(store),
    getBotBook: new GetBotBook({ ...deps, rules }),
    replaceBotOrders: new ReplaceBotOrders({ ...deps, rules }),
  };
  const provisionTenant = new ProvisionTenant({ store, clock: systemClock, logger });
  const recordMarketEvent = new RecordMarketEvent(deps);
  const recordPaymentEvent = new RecordPaymentEvent(deps);
  const grantCredits = new GrantCredits(deps);

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  // One key set serves both ports: the public API and the service accounts of the internal API use the same issuer.
  const getKey = createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 });
  const publicApp = buildPublicApp({
    logger,
    useCases: publicUseCases,
    auth: {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      getKey,
      rolesClaim: config.auth.rolesClaim,
      tenantClaim: config.auth.tenantClaim,
    },
    health: { ping: () => store.ping(), isDraining: () => shuttingDown },
    metrics,
  });
  // The service tokens of the internal REST port and of the gRPC port are verified with the same settings.
  const serviceAuth = {
    jwks: getKey,
    issuer: config.auth.issuer,
    audience: config.internalAuth.audience,
    clientClaim: config.internalAuth.clientClaim,
    clients: {
      markets: config.internalAuth.marketsClientId,
      payments: config.internalAuth.paymentsClientId,
      "market-maker": config.internalAuth.marketMakerClientId,
    },
  };
  const internalApp = buildInternalApp({
    logger,
    useCases: internalUseCases,
    auth: serviceAuth,
    // A local run without a broker has no consumers: the events route runs their use cases instead.
    local: config.isLocal && !config.natsUrl ? { recordMarketEvent, recordPaymentEvent, provisionTenant } : null,
    metrics,
  });
  // REQ-17 (ADR-023): the debit over gRPC, the same DebitWithdrawal object as POST /v1/internal/debits, so that the two
  // transports share one idempotency store (keyed by withdrawalId) and never disagree.
  const grpcServer = new DebitsGrpcServer({ logger, debitWithdrawal: internalUseCases.debitWithdrawal, auth: serviceAuth });

  // Background loops: the relay publishes the outbox; the three consumers (only with a broker) register the tenants
  // that tenants announces, apply the market events of markets and credit the payments of payments.
  const relay = new OutboxRelay({ store, publisher, clock: systemClock, logger, pollMs: config.outboxPollMs, streamMaxAgeMs: streamMaxAge });
  const park = (event: Parameters<Store["repositories"]["parkedEvents"]["park"]>[0]): Promise<void> => store.repositories.parkedEvents.park(event);
  const consumers = config.natsUrl
    ? [
        new JetStreamConsumer({
          url: config.natsUrl,
          spec: TENANTS_CONSUMER,
          handle: (data) => handleTenantCreatedMessage(data, provisionTenant, logger),
          park,
          logger,
        }),
        new JetStreamConsumer({
          url: config.natsUrl,
          spec: MARKETS_CONSUMER,
          handle: (data) => handleMarketMessage(data, recordMarketEvent, logger),
          park,
          logger,
        }),
        new JetStreamConsumer({
          url: config.natsUrl,
          spec: PAYMENTS_CONSUMER,
          handle: (data) => handlePaymentMessage(data, recordPaymentEvent, logger),
          park,
          logger,
        }),
      ]
    : [];

  // The first read of the runtime file comes before the first request, so the startup log level and rules are the file's.
  await runtimeConfig?.start();

  // Test credits are seed data (plan 6.2): only a local run grants them, once per line (the grant id is derived from it).
  for (const entry of config.seedCredits) {
    await store.ensureTenant(entry.tenantId, systemClock.now());
    const grantId = `seed-${requestHash(entry).slice(0, 32)}`;
    const result = await grantCredits.execute({ tenantId: entry.tenantId, userId: entry.userId, amount: entry.amount, grantId, reason: "SEED_CREDITS" });
    logger.info({ tenantId: entry.tenantId, userId: entry.userId, amount: entry.amount, result }, "Seed credits");
  }

  await publicApp.listen({ host: "0.0.0.0", port: config.port });
  await internalApp.listen({ host: "0.0.0.0", port: config.internalPort });
  // A port that cannot be bound stops the start (the catch below), so a running Pod always has its gRPC port: readiness
  // needs no check of its own for it (README, "gRPC debit").
  await grpcServer.start("0.0.0.0", config.grpcPort);
  // GET /metrics has a listener of its own: no API port serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  logger.info({ port: config.port, internalPort: config.internalPort, grpcPort: config.grpcPort }, "Listening");
  relay.start();
  for (const consumer of consumers) consumer.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await Promise.all([publicApp.close(), internalApp.close(), grpcServer.close()]);
        await metricsServer.close();
      },
      stopConsumer: async () => {
        await Promise.all(consumers.map((consumer) => consumer.stop()));
      },
      stopRelay: () => relay.stop(),
      stopRuntimeConfig: async () => {
        await runtimeConfig?.stop();
      },
      closeEvents: async () => {
        await nats?.close();
      },
      closeDatabase: async () => {
        await pool?.end();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  registerShutdownSignals(shutdown);
}

main().catch((error: unknown) => {
  console.error("trading failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
