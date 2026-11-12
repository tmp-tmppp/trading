import { parseArgs } from "node:util";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { randomIds, systemClock } from "./adapters/system.js";
import { createLogger } from "./logger.js";
import { GrantCredits } from "./usecases/grant-credits.js";

// `npm run seed:credits -- --tenant <id> --user <sub> --amount <credits> [--grant-id <id>]`
// Test credits are seed data only (plan 6.2): the ledger has no other way to create credits without a payment. The
// grant id is the business key, so running the same command again with the same id credits nothing more. Without
// --grant-id a new UUIDv7 is used, which means every run grants again.

const USAGE = "Usage: seed-credits --tenant <tenantId> --user <userId> --amount <credits> [--grant-id <id>] (needs DATABASE_URL)";

async function run(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      user: { type: "string" },
      amount: { type: "string" },
      "grant-id": { type: "string" },
    },
    strict: true,
  });
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  const amount = Number(values.amount);
  if (!values.tenant || !values.user || !Number.isInteger(amount) || !databaseUrl) {
    console.error(!databaseUrl ? `DATABASE_URL is not set.\n${USAGE}` : USAGE);
    return 2;
  }

  const logger = createLogger("warn");
  const pool = createPool(databaseUrl, 2, logger);
  try {
    await runMigrations(pool, logger);
    const store = new PostgresStore(pool, logger);
    // The tenant's schema is created when it does not exist yet (the work TenantCreated would have done).
    await store.ensureTenant(values.tenant, systemClock.now());
    const grantId = values["grant-id"] ?? randomIds.newId();
    const result = await new GrantCredits({ store, clock: systemClock, ids: randomIds, logger }).execute({
      tenantId: values.tenant,
      userId: values.user,
      amount,
      grantId,
      reason: "seed",
    });
    console.log(`${result}: ${String(amount)} credits for ${values.user} in tenant ${values.tenant} (grant id ${grantId})`);
    return 0;
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("seed-credits failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
