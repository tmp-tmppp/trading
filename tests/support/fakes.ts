import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { Actor, Clock, IdGenerator, Logger, ServiceCaller, ServiceClient, TradingRole, TradingRules, TradingRulesSource } from "../../src/usecases/ports.js";

// Test doubles shared by the domain, use-case, adapter and web tests.

export const TENANT_A = "018f3c1e-7a00-7000-8000-0000000000aa";
export const TENANT_B = "018f3c1e-7a00-7000-8000-0000000000bb";
export const MARKET_1 = "018f3c1e-7a00-7000-8000-000000000101";
export const MARKET_2 = "018f3c1e-7a00-7000-8000-000000000102";
export const CREATOR = "admin-1";
export const TRADER = "trader-1";

export class TestClock implements Clock {
  constructor(private current = new Date("2026-11-01T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Moves forward by a millisecond so that rows written one after another sort in a known order. */
  tick(): void {
    this.advanceMs(1);
  }
}

/** Ids that are valid UUIDs, grow like UUIDv7 and are predictable: ...0001, ...0002 */
export class SequentialIds implements IdGenerator {
  private counter = 0;
  newId(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
  messages(level?: string): Array<string | undefined> {
    return this.lines.filter((line) => level === undefined || line.level === level).map((line) => line.message);
  }
}

/** Trading rules a test can change between calls (the runtime configuration, ADR-037). */
export class TestRules implements TradingRulesSource {
  rules: TradingRules = { ...DEFAULT_RUNTIME_SETTINGS.tradingRules };
  current(): TradingRules {
    return this.rules;
  }
}

/** A caller of the public endpoints, as the web layer builds it from a token. */
export function actor(userId: string, role: TradingRole = "trader", tenantId = TENANT_A): Actor {
  return { userId, role, tenantId, correlationId: `corr-${userId}`, causationId: `req-${userId}` };
}

/** A caller of the internal endpoints, as the web layer builds it from a service token. */
export function serviceCaller(client: ServiceClient): ServiceCaller {
  return { client, correlationId: `corr-${client}`, causationId: `req-${client}` };
}

/** A close time `hours` after the clock's time. */
export function closeTimeIn(clock: Clock, hours: number): Date {
  return new Date(clock.now().getTime() + hours * 3_600_000);
}
