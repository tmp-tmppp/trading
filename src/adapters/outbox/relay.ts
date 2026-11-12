import { ORDER_KEY_RETENTION_MS, ORDER_SCOPE_PREFIX } from "../../usecases/support.js";
import type { Clock, EventPublisher, Logger, Store } from "../../usecases/ports.js";
import { inboxRetentionFor } from "../retention.js";

export interface RelayOptions {
  store: Store;
  publisher: EventPublisher;
  clock: Clock;
  logger: Logger;
  /** Wait between polls when the outbox is empty. */
  pollMs: number;
  /** Rows claimed per transaction. */
  batchSize?: number;
  /** Upper bound of the wait after failed publishes. */
  maxBackoffMs?: number;
  /**
   * The max age of the stream in milliseconds (STREAM_MAX_AGE_DAYS), the value the NatsEventPublisher creates the stream
   * with: a published row is kept this long, because after that it is of no use any more.
   */
  streamMaxAgeMs: number;
  /** How long an inbox entry is kept. Default: the stream's max age and a day of margin (DM-06). */
  inboxRetentionMs?: number;
  /** How long the idempotency key of an order is kept. Default 7 days (ORDER_KEY_RETENTION_MS, REL-03). */
  orderKeyRetentionMs?: number;
  /** Published rows, old inbox entries and old order keys are deleted at most this often. Default 1 hour. */
  purgeEveryMs?: number;
}

const PURGE_EVERY_MS = 3_600_000;

export interface RunResult {
  published: number;
  failed: boolean;
}

/**
 * Transactional outbox relay (REL-01, ADR-031): polls the outbox, publishes unsent rows in order and marks them.
 * Only one instance publishes at a time: the claim takes an advisory lock that lasts until the end of its
 * transaction and returns no rows while another instance holds it, so the events of a tenant keep their order with
 * several replicas (a rolling update runs two for a while). The rows are also claimed with FOR UPDATE SKIP LOCKED.
 * A failed publish stops the batch (the order is kept), counts an attempt and backs off.
 * Delivery is at least once: the event id is the deduplication id on the broker and in every consumer.
 * Published rows are deleted after the retention time, at most once an hour (purgeIfDue); the same timer deletes the
 * inbox entries of consumed events that are older than their retention (DM-06) and, in every registered tenant, the
 * idempotency keys of orders older than their retention (REL-03; funding and debit keys are business keys and stay).
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly maxBackoffMs: number;
  private readonly retentionMs: number;
  private readonly inboxRetentionMs: number;
  private readonly orderKeyRetentionMs: number;
  private readonly purgeEveryMs: number;
  private lastPurgeAt: number | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: RelayOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.retentionMs = options.streamMaxAgeMs;
    this.inboxRetentionMs = options.inboxRetentionMs ?? inboxRetentionFor(options.streamMaxAgeMs);
    this.orderKeyRetentionMs = options.orderKeyRetentionMs ?? ORDER_KEY_RETENTION_MS;
    this.purgeEveryMs = options.purgeEveryMs ?? PURGE_EVERY_MS;
  }

  /** One poll: claims a batch in a transaction and publishes it. */
  runOnce(): Promise<RunResult> {
    const { store, publisher, clock, logger } = this.options;
    return store.transaction(async (repositories) => {
      const rows = await repositories.outbox.claimBatch(this.batchSize);
      let published = 0;
      for (const row of rows) {
        try {
          await publisher.publish(row.subject, row.payload, row.id);
          await repositories.outbox.markPublished(row.id, clock.now());
          published += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await repositories.outbox.markFailed(row.id, message);
          logger.warn({ eventId: row.id, subject: row.subject, attempts: row.attempts + 1, err: error }, "Publishing an event failed");
          return { published, failed: true };
        }
      }
      return { published, failed: false };
    });
  }

  /**
   * Deletes the outbox rows that were published longer ago than the retention time, the inbox entries that were
   * processed longer ago than the inbox retention and the order idempotency keys older than their retention, if the
   * last attempt is at least purgeEveryMs ago (the first call always runs). Returns how many outbox rows went. The
   * attempt counts even when it fails, so a database that is down is not asked again at every poll. A failed inbox
   * purge does not hide the outbox purge that ran before it, and a tenant whose keys cannot be purged does not stop the
   * others (a warning names it).
   */
  async purgeIfDue(): Promise<number> {
    const { store, clock, logger } = this.options;
    const now = clock.now().getTime();
    if (this.lastPurgeAt !== null && now - this.lastPurgeAt < this.purgeEveryMs) return 0;
    this.lastPurgeAt = now;
    const purged = await store.repositories.outbox.purgePublished(new Date(now - this.retentionMs));
    if (purged > 0) logger.info({ purged }, "Deleted published events from the outbox");
    const inboxPurged = await store.repositories.inbox.purge(new Date(now - this.inboxRetentionMs));
    if (inboxPurged > 0) logger.info({ purged: inboxPurged }, "Deleted old entries of the inbox");
    await this.purgeOrderKeys(now);
    return purged;
  }

  private async purgeOrderKeys(now: number): Promise<void> {
    const { store, logger } = this.options;
    const olderThan = new Date(now - this.orderKeyRetentionMs);
    for (const tenantId of await store.repositories.tenants.list()) {
      try {
        const tenant = await store.forTenant(tenantId);
        if (tenant === null) continue;
        const keys = await tenant.repositories.idempotency.purge(ORDER_SCOPE_PREFIX, olderThan);
        if (keys > 0) logger.info({ tenantId, purged: keys }, "Deleted old idempotency keys of orders");
      } catch (error) {
        logger.warn({ tenantId, err: error }, "The relay could not delete old idempotency keys of orders");
      }
    }
  }

  /** Starts the polling loop; it runs until stop() is called. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops the loop and waits until the poll in progress has finished. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let delay = this.options.pollMs;
      try {
        const result = await this.runOnce();
        if (result.failed) {
          failures += 1;
          delay = this.backoff(failures);
        } else {
          failures = 0;
          if (result.published >= this.batchSize) delay = 0;
        }
      } catch (error) {
        failures += 1;
        delay = this.backoff(failures);
        this.options.logger.error({ err: error }, "The outbox relay could not read the outbox");
      }
      if (!this.stopping) {
        try {
          await this.purgeIfDue();
        } catch (error) {
          this.options.logger.warn({ err: error }, "The outbox relay could not delete old published events, inbox entries or order keys");
        }
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
  }

  private backoff(failures: number): number {
    const exponential = Math.min(this.maxBackoffMs, this.options.pollMs * 2 ** Math.min(failures, 16));
    return Math.round(exponential / 2 + Math.random() * (exponential / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}
