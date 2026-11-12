import { parseArgs } from "node:util";
import type { HandleResult } from "./adapters/nats/message-handlers.js";
import { handleMarketMessage, handlePaymentMessage, handleTenantCreatedMessage } from "./adapters/nats/message-handlers.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { randomIds, systemClock } from "./adapters/system.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./usecases/ports.js";
import { ProvisionTenant } from "./usecases/provision-tenant.js";
import { RecordMarketEvent } from "./usecases/record-market-event.js";
import { RecordPaymentEvent } from "./usecases/record-payment-event.js";
import { MARKET_EVENTS_CONSUMER, PAYMENT_EVENTS_CONSUMER, TENANT_CREATED_CONSUMER } from "./usecases/support.js";

// `npm run parked -- [--consumer <name>] [--retry]`: lists the events a consumer gave up on after PARK_AFTER_DELIVERIES
// failed deliveries (shared.parked_events). With --retry each one runs again through the handler of its consumer, and a
// row is deleted only when the handler acknowledges the message (the inbox and the ledger keys make a repeat harmless).

const LIST_LIMIT = 1000;

async function run(): Promise<number> {
  const { values } = parseArgs({
    options: { consumer: { type: "string" }, retry: { type: "boolean", default: false } },
    strict: true,
  });
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.\nUsage: parked [--consumer <tenant-created|market-events|payment-events>] [--retry]");
    return 2;
  }

  const logger = createLogger("warn");
  const pool = createPool(databaseUrl, 2, logger);
  try {
    const store = new PostgresStore(pool, logger);
    const deps = { store, clock: systemClock, ids: randomIds, logger };
    const handlers: Record<string, (data: Uint8Array, log: Logger) => Promise<HandleResult>> = {
      [TENANT_CREATED_CONSUMER]: (data, log) => handleTenantCreatedMessage(data, new ProvisionTenant({ store, clock: systemClock, logger: log }), log),
      [MARKET_EVENTS_CONSUMER]: (data, log) => handleMarketMessage(data, new RecordMarketEvent(deps), log),
      [PAYMENT_EVENTS_CONSUMER]: (data, log) => handlePaymentMessage(data, new RecordPaymentEvent(deps), log),
    };

    const parked = await store.repositories.parkedEvents.list(values.consumer ?? null, LIST_LIMIT);
    if (parked.length === 0) console.log("No parked events.");
    let failed = 0;
    for (const event of parked) {
      const head = `${event.consumer} #${String(event.streamSequence)} ${event.subject} (${String(event.deliveries)} deliveries, parked ${event.parkedAt.toISOString()})`;
      if (!values.retry) {
        console.log(`${head}\n  ${event.reason}`);
        continue;
      }
      const handler = handlers[event.consumer];
      if (!handler) {
        console.log(`${head}: unknown consumer, left parked`);
        failed += 1;
        continue;
      }
      const result = await handler(new TextEncoder().encode(event.payload), logger);
      if (result.kind === "ack") {
        await store.repositories.parkedEvents.remove(event.consumer, event.streamSequence);
        console.log(`${head}: done, removed`);
      } else {
        console.log(`${head}: still failing, left parked (${result.reason})`);
        failed += 1;
      }
    }
    return failed === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("parked failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
