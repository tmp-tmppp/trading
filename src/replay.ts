import { parseArgs } from "node:util";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { systemClock } from "./adapters/system.js";
import { createLogger } from "./logger.js";
import { replayTenants } from "./replay-run.js";
import { ReplayLedger } from "./usecases/replay-ledger.js";

// `npm run replay -- [--tenant <id>] [--rebuild]` (DM-07): folds every stream of the ledger with the same `evolve` the
// use cases use and compares the result with the stored accounts and positions. Exit 0 only when they are equal.
// With --rebuild the projections are rewritten from the ledger (the differences are still reported), unless a stream
// cannot be folded: that stream is reported as "unfoldable" and nothing is rewritten. A tenant that fails is reported
// and the others still run (exit 1). The ledger is locked against appends for the duration; a demo ledger replays in
// seconds.

async function run(): Promise<number> {
  const { values } = parseArgs({
    options: { tenant: { type: "string" }, rebuild: { type: "boolean", default: false } },
    strict: true,
  });
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.\nUsage: replay [--tenant <tenantId>] [--rebuild]");
    return 2;
  }

  const logger = createLogger("warn");
  const pool = createPool(databaseUrl, 2, logger);
  try {
    const store = new PostgresStore(pool, logger);
    const replay = new ReplayLedger({ store, clock: systemClock, logger });
    const tenants = values.tenant ? [values.tenant] : await store.repositories.tenants.list();
    return await replayTenants(replay, tenants, values.rebuild === true, (line) => console.log(line));
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("replay failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
