import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { RuntimeSettings } from "../../src/config.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "../../src/adapters/runtime-config.js";
import { RecordingLogger } from "../support/fakes.js";

describe("RuntimeSettingsHolder", () => {
  it("hands out the current trading rules and takes new settings", () => {
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    expect(holder.current()).toEqual(DEFAULT_RUNTIME_SETTINGS.tradingRules);
    holder.set({ logLevel: "warn", tradingRules: { orderAmountMax: 5, maxOffersPerSide: 2, ordersEnabled: false } });
    expect(holder.current().ordersEnabled).toBe(false);
    expect(holder.get().logLevel).toBe("warn");
  });
});

describe("RuntimeConfigWatcher", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trading-runtime-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies the file when it changes, ignores an unchanged file and survives a missing one", async () => {
    const file = join(dir, "runtime.env");
    const logger = new RecordingLogger();
    const seen: RuntimeSettings[] = [];
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, logger, onChange: (s) => seen.push(s) });

    expect(await watcher.checkNow()).toBe(false);
    expect(await watcher.checkNow()).toBe(false);
    expect(logger.messages("warn")).toHaveLength(1);

    await writeFile(file, "ORDERS_ENABLED=false\nNOT_A_KEY=1\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(seen.at(-1)?.tradingRules.ordersEnabled).toBe(false);
    expect(logger.messages("warn")).toContain("Ignored a setting of the runtime configuration file");
    expect(await watcher.checkNow()).toBe(false);

    await writeFile(file, "MAX_OFFERS_PER_SIDE=3\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(seen.at(-1)?.tradingRules).toEqual({ orderAmountMax: 100_000, maxOffersPerSide: 3, ordersEnabled: true });

    await watcher.start();
    await watcher.stop();
  });

  it("keeps a pause in force when the line is later misspelled, and ends it only when the line is deleted", async () => {
    const file = join(dir, "runtime.env");
    const logger = new RecordingLogger();
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, current: () => holder.get(), logger, onChange: (s) => holder.set(s) });

    await writeFile(file, "ORDERS_ENABLED=false\nORDER_AMOUNT_MAX=250\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(holder.current()).toMatchObject({ ordersEnabled: false, orderAmountMax: 250 });

    await writeFile(file, "ORDERS_ENABLED=flase\nORDER_AMOUNT_MAX=25O\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(holder.current()).toMatchObject({ ordersEnabled: false, orderAmountMax: 250 });
    expect(logger.messages("warn")).toContain("Ignored a setting of the runtime configuration file");

    await writeFile(file, "# the pause is over\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(holder.current()).toEqual(DEFAULT_RUNTIME_SETTINGS.tradingRules);
  });
});
