import { describe, expect, it } from "vitest";
import { replayTenants } from "../src/replay-run.js";
import type { ProjectionDifference, ReplayLedgerUseCase, ReplayReport } from "../src/usecases/use-cases.js";

const unfoldable: ProjectionDifference = { streamId: "account:u1", what: "unfoldable", expected: "The balance of account:u1 would be -40000000", actual: null };

/** A replay that answers each tenant from a table: a report, or an error to throw. */
function replayOf(answers: Record<string, ReplayReport | Error>): ReplayLedgerUseCase & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    execute: ({ tenantId }) => {
      asked.push(tenantId);
      const answer = answers[tenantId];
      if (answer === undefined || answer instanceof Error) return Promise.reject(answer ?? new Error("unknown tenant"));
      return Promise.resolve(answer);
    },
  };
}

const report = (tenantId: string, differences: ProjectionDifference[] = [], rebuilt = false): ReplayReport => ({ tenantId, events: 3, streams: 2, differences, rebuilt });

describe("replayTenants (npm run replay)", () => {
  it("prints one line per tenant and exits 0 when every projection equals its replay", async () => {
    const lines: string[] = [];

    const code = await replayTenants(replayOf({ a: report("a"), b: report("b", [], true) }), ["a", "b"], false, (line) => lines.push(line));
    const rebuilt = await replayTenants(replayOf({ a: report("a", [], true) }), ["a"], true, (line) => lines.push(line));

    expect(code).toBe(0);
    expect(rebuilt).toBe(0);
    expect(lines).toEqual(["tenant a: 3 events, 2 streams, 0 differences", "tenant b: 3 events, 2 streams, 0 differences (projections rebuilt)", "tenant a: 3 events, 2 streams, 0 differences (projections rebuilt)"]);
  });

  it("goes on with the next tenant when one fails, reports the failure and exits 1", async () => {
    const replay = replayOf({ a: new Error("invariant_violated The balance of account:u1 would be -40000000"), b: report("b", [unfoldable]) });
    const lines: string[] = [];

    const code = await replayTenants(replay, ["a", "b"], true, (line) => lines.push(line));

    expect(code).toBe(1);
    expect(replay.asked).toEqual(["a", "b"]);
    expect(lines).toEqual([
      "tenant a: replay failed: invariant_violated The balance of account:u1 would be -40000000",
      "tenant b: 3 events, 2 streams, 1 differences (rebuild refused: a stream cannot be folded)",
      `  ${JSON.stringify(unfoldable)}`,
    ]);
  });

  it("exits 1 for a failure alone, and says so when there is no tenant", async () => {
    const failing: ReplayLedgerUseCase = { execute: () => Promise.reject(new Error("boom")) };
    const lines: string[] = [];

    expect(await replayTenants(failing, ["a"], false, (line) => lines.push(line))).toBe(1);
    expect(await replayTenants(replayOf({}), [], false, (line) => lines.push(line))).toBe(0);

    expect(lines).toEqual(["tenant a: replay failed: boom", "No tenant is registered."]);
  });
});
