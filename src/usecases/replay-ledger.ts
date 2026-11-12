import { DomainError } from "../domain/errors.js";
import { nonEmptyPositions, replayStream } from "../domain/ledger.js";
import type { AccountState, Holding } from "../domain/ledger.js";
import { NotFound } from "./errors.js";
import type { Clock, Logger, RecordedLedgerEvent, Store } from "./ports.js";
import type { ProjectionDifference, ReplayLedgerUseCase, ReplayReport } from "./use-cases.js";

/** Events read per round trip; the whole ledger of a tenant is folded, never held as one query result. */
const BATCH_SIZE = 1000;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The projection differences of one stream: what the replay says (expected) against what the tables hold (actual). */
function differencesOf(streamId: string, expected: AccountState | undefined, actual: AccountState | undefined): ProjectionDifference[] {
  if (expected === undefined && actual === undefined) return [];
  if (actual === undefined) return [{ streamId, what: "missing", expected: { balanceMicro: expected?.balanceMicro, version: expected?.version }, actual: null }];
  if (expected === undefined) return [{ streamId, what: "extra", expected: null, actual: { balanceMicro: actual.balanceMicro, version: actual.version } }];
  const found: ProjectionDifference[] = [];
  if (expected.balanceMicro !== actual.balanceMicro) found.push({ streamId, what: "balance", expected: expected.balanceMicro, actual: actual.balanceMicro });
  if (expected.version !== actual.version) found.push({ streamId, what: "version", expected: expected.version, actual: actual.version });
  const want = nonEmptyPositions(expected);
  const have = nonEmptyPositions(actual);
  for (const marketId of [...new Set([...Object.keys(want), ...Object.keys(have)])].sort()) {
    const left: Holding | undefined = want[marketId];
    const right: Holding | undefined = have[marketId];
    if (left?.yesMicro !== right?.yesMicro || left?.noMicro !== right?.noMicro) found.push({ streamId, what: "position", marketId, expected: left ?? null, actual: right ?? null });
  }
  return found;
}

/**
 * Proof of DM-07: folds a tenant's whole ledger with `evolve` and compares the result with the stored projections
 * (accounts, positions); with `rebuild` it also replaces them by the replayed ones. Both modes run in one transaction
 * that first takes the table lock (`lockForReplay`), so the ledger and the projections are read as one consistent
 * state, no append can commit between the read and the rewrite, and the compare mode reports no false difference under
 * load. Appends wait meanwhile (the ledger of a demo replays in seconds). A difference is reported even when it is then
 * rebuilt. A stream that cannot be folded (its events break an invariant, as after an order decided on a drifted
 * projection) is reported as an "unfoldable" difference, the other streams are still compared, and a rebuild is refused
 * (`rebuilt: false`, nothing rewritten) until that stream is settled.
 */
export class ReplayLedger implements ReplayLedgerUseCase {
  /** `batchSize` is for tests that need more than one round trip without a thousand events. */
  constructor(
    private readonly deps: { store: Store; clock: Clock; logger: Logger },
    private readonly batchSize = BATCH_SIZE,
  ) {}

  async execute(input: { tenantId: string; rebuild: boolean }): Promise<ReplayReport> {
    const { store, clock, logger } = this.deps;
    const tenant = await store.forTenant(input.tenantId);
    if (!tenant) throw new NotFound("The tenant is not registered in this service");

    const report = await tenant.transaction(async (repositories): Promise<ReplayReport> => {
      await repositories.ledger.lockForReplay();
      const streams = new Map<string, RecordedLedgerEvent[]>();
      let events = 0;
      for (let after = 0; ; ) {
        const batch = await repositories.ledger.readAll(after, this.batchSize);
        const last = batch[batch.length - 1];
        if (last === undefined) break;
        for (const event of batch) streams.set(event.streamId, [...(streams.get(event.streamId) ?? []), event]);
        events += batch.length;
        after = last.position;
      }
      // A stream whose events break an invariant (an overspent balance, a settlement that does not match the holding)
      // cannot be folded; it is reported on its own and never hides the other streams.
      const replayed = new Map<string, AccountState>();
      const unfoldable = new Map<string, string>();
      for (const [streamId, streamEvents] of streams) {
        try {
          replayed.set(streamId, replayStream(streamId, streamEvents));
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "invariant_violated") throw error;
          unfoldable.set(streamId, error.message);
        }
      }
      const stored = new Map((await repositories.accounts.all()).map((account) => [account.streamId, account]));

      const streamIds = [...new Set([...replayed.keys(), ...unfoldable.keys(), ...stored.keys()])].sort(compare);
      const differences = streamIds.flatMap((streamId): ProjectionDifference[] => {
        const reason = unfoldable.get(streamId);
        if (reason === undefined) return differencesOf(streamId, replayed.get(streamId), stored.get(streamId));
        const projection = stored.get(streamId);
        return [{ streamId, what: "unfoldable", expected: reason, actual: projection ? { balanceMicro: projection.balanceMicro, version: projection.version } : null }];
      });
      // Nothing is cleared while a stream cannot be folded: its stored row is the only trace of it, and a rebuild of
      // the other streams alone would leave the tenant half repaired. The operator settles that stream first.
      const rebuilt = input.rebuild && unfoldable.size === 0;
      if (rebuilt) {
        const now = clock.now();
        await repositories.accounts.clear();
        for (const streamId of [...replayed.keys()].sort(compare)) await repositories.accounts.save(replayed.get(streamId) as AccountState, now);
      }
      return { tenantId: input.tenantId, events, streams: streams.size, differences, rebuilt };
    });
    logger.info({ tenantId: input.tenantId, events: report.events, streams: report.streams, differences: report.differences.length, rebuilt: report.rebuilt }, "Ledger replayed");
    return report;
  }
}
