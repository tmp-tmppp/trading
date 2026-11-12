import type { ReplayLedgerUseCase } from "./usecases/use-cases.js";

/**
 * The loop of `npm run replay` (DM-07): replays each tenant in turn and prints one report per tenant, with its
 * differences below. A tenant whose replay fails (it is not registered, the database refuses) is reported and the next
 * tenant is still replayed, so one bad tenant never hides the others. Returns the exit code: 0 only when every tenant
 * replayed and every projection equals its replay.
 */
export async function replayTenants(replay: ReplayLedgerUseCase, tenants: readonly string[], rebuild: boolean, print: (line: string) => void): Promise<number> {
  let problems = 0;
  for (const tenantId of tenants) {
    try {
      const report = await replay.execute({ tenantId, rebuild });
      const outcome = report.rebuilt ? " (projections rebuilt)" : rebuild ? " (rebuild refused: a stream cannot be folded)" : "";
      print(`tenant ${tenantId}: ${String(report.events)} events, ${String(report.streams)} streams, ${String(report.differences.length)} differences${outcome}`);
      for (const difference of report.differences) print(`  ${JSON.stringify(difference)}`);
      problems += report.differences.length;
    } catch (error) {
      print(`tenant ${tenantId}: replay failed: ${error instanceof Error ? error.message : String(error)}`);
      problems += 1;
    }
  }
  if (tenants.length === 0) print("No tenant is registered.");
  return problems === 0 ? 0 : 1;
}
