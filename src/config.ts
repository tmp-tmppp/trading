import { DEFAULT_STREAM_MAX_AGE_DAYS, MAX_STREAM_MAX_AGE_DAYS, MIN_STREAM_MAX_AGE_DAYS } from "./adapters/retention.js";
import { MAX_OFFERS_PER_SIDE_LIMIT } from "./domain/order-book.js";
import { CREDIT_AMOUNT_MAX } from "./domain/units.js";
import type { TradingRules } from "./usecases/ports.js";

// Typed configuration, validated once at startup. A bad or missing setting stops the start with a message that names
// every problem; values are never printed (they may hold passwords).
// ADR-037: defaults, then the watched runtime file, then environment variables (the chart's ConfigMap and Secret), so
// an environment variable always wins. The runtime keys (RUNTIME_KEYS) are read here as their startup values; the
// watcher of RUNTIME_CONFIG_FILE (src/adapters/runtime-config.ts) applies the file with parseRuntimeFile while the
// service runs, without a restart, for every runtime key the environment does not set (the chart sets none there).

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export interface AuthConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  rolesClaim: string;
  tenantClaim: string;
}

/**
 * The service accounts of the internal port (8081): tokens of the same issuer and keys as the public API, with this
 * audience; the client id claim names the calling service, and each internal endpoint admits exactly one client.
 */
export interface InternalAuthConfig {
  audience: string;
  /** The claim that carries the client id of a client-credentials token (Keycloak: "azp"). */
  clientClaim: string;
  marketsClientId: string;
  paymentsClientId: string;
  marketMakerClientId: string;
}

/** One line of SEED_CREDITS: test credits for a user, granted at startup in local mode (plan 6.2: seed data only). */
export interface SeedGrant {
  tenantId: string;
  userId: string;
  amount: number;
}

/** The keys that may change while the service runs. */
export interface RuntimeSettings {
  logLevel: string;
  tradingRules: TradingRules;
}

export interface Config {
  /** "local" allows in-memory fallbacks; any other value (default "production") requires every setting. */
  appEnv: string;
  isLocal: boolean;
  /** The public API (gateway prefix /v1/trading) and the health probes. */
  port: number;
  /** The internal API (/v1/internal: funding, debits, the market maker), admitted by the NetworkPolicy to three services only. */
  internalPort: number;
  /**
   * The gRPC debit (contracts/trading-debit.proto): the same use case as POST /v1/internal/debits, for payments only
   * (client `payments`, the same service token), on a port of its own so that the NetworkPolicy admits payments alone.
   */
  grpcPort: number;
  /** The port of the separate listener that serves GET /metrics (one per process); never an API port. */
  metricsPort: number;
  /** Startup value of a runtime key. */
  logLevel: string;
  runtimeConfigFile: string | null;
  runtimeConfigPollMs: number;
  /** Null only in local mode: the service then keeps its data in memory. */
  databaseUrl: string | null;
  databasePoolMax: number;
  /** Null only in local mode: events are then logged instead of published, and nothing is consumed. */
  natsUrl: string | null;
  auth: AuthConfig;
  internalAuth: InternalAuthConfig;
  /** Startup value of the runtime keys. */
  tradingRules: TradingRules;
  outboxPollMs: number;
  /**
   * How long this service's stream keeps its messages (STREAM_MAX_AGE_DAYS, 1 to 365 days, default 30). main.ts turns it
   * into one number for the NATS publisher (the stream's max_age) and the relay (its purge), so the two agree.
   */
  streamMaxAgeDays: number;
  shutdownDelayMs: number;
  /** Local mode only; empty otherwise. */
  seedCredits: SeedGrant[];
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;

/** The keys RUNTIME_CONFIG_FILE may set; any other key in the file is reported and ignored. */
export const RUNTIME_KEYS = ["LOG_LEVEL", "ORDER_AMOUNT_MAX", "MAX_OFFERS_PER_SIDE", "ORDERS_ENABLED"] as const;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

/** The internal port of a local run (APP_ENV=local), next to a local Keycloak on 8081. */
export const LOCAL_INTERNAL_PORT = 8091;

// Local defaults of the token settings, matching a Keycloak on port 8081 of the developer's machine (see README).
// Tokens are always verified.
const LOCAL_AUTH = {
  jwksUrl: "http://localhost:8081/realms/chance/protocol/openid-connect/certs",
  issuer: "http://localhost:8081/realms/chance",
  audience: "chance",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Source = Readonly<Record<string, string | undefined>>;

/** Readers of one source of settings; each records its problems instead of throwing, so all of them are reported. */
function readerOf(source: Source, problems: string[]) {
  const text = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
  // `fallback` is the value of a key that is not set; `onInvalid` (default: the same) the value of a key that is set but
  // fails its check, which the runtime file sets to the value in force.
  const integer = (name: string, fallback: number, min: number, max: number, onInvalid: number = fallback): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return onInvalid;
    }
    return value;
  };
  const boolean = (name: string, fallback: boolean, onInvalid: boolean = fallback): boolean => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    problems.push(`${name} must be true or false`);
    return onInvalid;
  };
  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T, onInvalid: T = fallback): T => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    problems.push(`${name} must be one of: ${allowed.join(", ")}`);
    return onInvalid;
  };
  const url = (name: string, protocols: readonly string[], value: string | undefined): string | null => {
    if (value === undefined) return null;
    try {
      const parsed = new URL(value);
      if (protocols.includes(parsed.protocol) && parsed.username === "" && parsed.password === "") return value;
      // A database URL carries its login: only the other URLs must not.
      if (protocols.includes(parsed.protocol) && protocols.includes("postgres:")) return value;
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be a URL starting with ${protocols.map((p) => `${p}//`).join(" or ")} (only a database URL may hold a user name and password)`);
    return null;
  };
  /**
   * The runtime keys, read on top of `base` (a key that is not set). A key that is set but invalid takes its value from
   * `inForce` (default `base`), so a typo in the runtime file never undoes an override that is running.
   */
  const runtime = (base: RuntimeSettings, inForce: RuntimeSettings = base): RuntimeSettings => ({
    logLevel: choice("LOG_LEVEL", LOG_LEVELS, base.logLevel, inForce.logLevel),
    tradingRules: {
      orderAmountMax: integer("ORDER_AMOUNT_MAX", base.tradingRules.orderAmountMax, 1, CREDIT_AMOUNT_MAX, inForce.tradingRules.orderAmountMax),
      maxOffersPerSide: integer("MAX_OFFERS_PER_SIDE", base.tradingRules.maxOffersPerSide, 1, MAX_OFFERS_PER_SIDE_LIMIT, inForce.tradingRules.maxOffersPerSide),
      ordersEnabled: boolean("ORDERS_ENABLED", base.tradingRules.ordersEnabled, inForce.tradingRules.ordersEnabled),
    },
  });
  return { text, integer, boolean, choice, url, runtime };
}

/** The defaults of the runtime keys. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  logLevel: "info",
  tradingRules: { orderAmountMax: 100_000, maxOffersPerSide: 10, ordersEnabled: true },
};

/**
 * SEED_CREDITS: comma-separated `<tenantId>/<userId>=<credits>` (local mode only), for example
 * `018f.../user-1=5000,018f.../user-2=5000`. Each line is granted once (its grant id is derived from the line).
 */
export function parseSeedCredits(raw: string | undefined, problems: string[]): SeedGrant[] {
  if (raw === undefined) return [];
  const grants: SeedGrant[] = [];
  for (const [index, item] of raw.split(",").entries()) {
    const entry = item.trim();
    if (entry === "") continue;
    const match = /^([^/]+)\/([^=]+)=(\d+)$/.exec(entry);
    const amount = match ? Number(match[3]) : NaN;
    if (!match || !UUID_PATTERN.test(match[1] ?? "") || !Number.isInteger(amount) || amount < 1 || amount > CREDIT_AMOUNT_MAX) {
      problems.push(`SEED_CREDITS entry ${index + 1} must be <tenantId>/<userId>=<credits> with a UUID tenant and 1 to ${CREDIT_AMOUNT_MAX} credits`);
      continue;
    }
    grants.push({ tenantId: (match[1] ?? "").toLowerCase(), userId: (match[2] ?? "").trim(), amount });
  }
  return grants;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const read = readerOf(env, problems);
  const { text, integer, url } = read;

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";
  const required = (name: string, hint: string): string | undefined => {
    const value = text(name);
    if (value === undefined && !isLocal) problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
    return value;
  };

  const runtime = read.runtime(DEFAULT_RUNTIME_SETTINGS);

  const databaseUrl = url("DATABASE_URL", ["postgres:", "postgresql:"], required("DATABASE_URL", "the connection string of the service's PostgreSQL database"));
  const natsUrl = url("NATS_URL", ["nats:", "tls:"], required("NATS_URL", "the NATS server"));

  const authText = (name: string, local: string, hint: string): string => required(name, hint) ?? local;
  const jwksUrl = url("AUTH_JWKS_URL", ["http:", "https:"], authText("AUTH_JWKS_URL", LOCAL_AUTH.jwksUrl, "the JWKS URL of the identity provider"));
  const auth: AuthConfig = {
    jwksUrl: jwksUrl ?? LOCAL_AUTH.jwksUrl,
    issuer: authText("AUTH_ISSUER", LOCAL_AUTH.issuer, "the issuer (iss) of the tokens"),
    audience: authText("AUTH_AUDIENCE", LOCAL_AUTH.audience, "the audience (aud) of the tokens"),
    rolesClaim: text("AUTH_ROLES_CLAIM") ?? "realm_access.roles",
    tenantClaim: text("AUTH_TENANT_CLAIM") ?? "organization",
  };
  const internalAuth: InternalAuthConfig = {
    audience: text("INTERNAL_AUTH_AUDIENCE") ?? auth.audience,
    clientClaim: text("INTERNAL_CLIENT_CLAIM") ?? "azp",
    marketsClientId: text("MARKETS_CLIENT_ID") ?? "markets",
    paymentsClientId: text("PAYMENTS_CLIENT_ID") ?? "payments",
    marketMakerClientId: text("MARKET_MAKER_CLIENT_ID") ?? "market-maker",
  };
  const clientIds = [internalAuth.marketsClientId, internalAuth.paymentsClientId, internalAuth.marketMakerClientId];
  if (new Set(clientIds).size !== clientIds.length) problems.push("MARKETS_CLIENT_ID, PAYMENTS_CLIENT_ID and MARKET_MAKER_CLIENT_ID must differ");

  const port = integer("PORT", 8080, 1, 65535);
  // 8081 in the cluster (markets' contract: http://trading:8081). A local run defaults to 8091, because the local
  // Keycloak of the identity repository listens on 8081.
  const internalPort = integer("INTERNAL_PORT", isLocal ? LOCAL_INTERNAL_PORT : 8081, 1, 65535);
  // 8082 everywhere: nothing else of a local run listens there (the local Keycloak is on 8081).
  const grpcPort = integer("GRPC_PORT", 8082, 1, 65535);
  if (new Set([port, internalPort, grpcPort]).size !== 3) {
    problems.push("PORT, INTERNAL_PORT and GRPC_PORT must differ: the NetworkPolicy admits other callers to each");
  }
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // No API port serves /metrics (so the gateway can never route it): the listeners need ports of their own.
  if ([port, internalPort, grpcPort].includes(metricsPort)) {
    problems.push("METRICS_PORT must differ from PORT, INTERNAL_PORT and GRPC_PORT (the API ports never serve /metrics)");
  }

  const seedCredits = parseSeedCredits(text("SEED_CREDITS"), problems);
  if (!isLocal && seedCredits.length > 0) problems.push("SEED_CREDITS is only allowed with APP_ENV=local (test credits are seed data, plan 6.2)");

  const config: Config = {
    appEnv,
    isLocal,
    port,
    internalPort,
    grpcPort,
    metricsPort,
    logLevel: runtime.logLevel,
    runtimeConfigFile: text("RUNTIME_CONFIG_FILE") ?? null,
    runtimeConfigPollMs: integer("RUNTIME_CONFIG_POLL_MS", 10_000, 1000, 3_600_000),
    databaseUrl,
    databasePoolMax: integer("DATABASE_POOL_MAX", 5, 1, 50),
    natsUrl,
    auth,
    internalAuth,
    tradingRules: runtime.tradingRules,
    outboxPollMs: integer("OUTBOX_POLL_MS", 300, 50, 60_000),
    streamMaxAgeDays: integer("STREAM_MAX_AGE_DAYS", DEFAULT_STREAM_MAX_AGE_DAYS, MIN_STREAM_MAX_AGE_DAYS, MAX_STREAM_MAX_AGE_DAYS),
    // Nobody routes traffic to a local run, so it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", isLocal ? 0 : 5000, 0, MAX_SHUTDOWN_DELAY_MS),
    seedCredits: isLocal ? seedCredits : [],
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The startup values of the runtime keys. */
export function runtimeSettingsOf(config: Config): RuntimeSettings {
  return { logLevel: config.logLevel, tradingRules: { ...config.tradingRules } };
}

export interface RuntimeFileResult {
  settings: RuntimeSettings;
  /** Invalid values and unknown keys; the service logs them, and an invalid key keeps the value in force. */
  problems: string[];
}

/** The runtime keys that the environment sets: they win over the runtime file (ADR-037). */
export function runtimeKeysInEnv(env: NodeJS.ProcessEnv): string[] {
  return RUNTIME_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Reads the runtime file: lines KEY=value, blank lines and lines starting with # are skipped, the last of repeated
 * keys counts. A key that is not in the file takes its startup value (defaults, then env), so deleting a line undoes
 * an override. A key whose value is invalid keeps `inForce`, the settings now running (default: the startup values), so
 * a typo such as ORDERS_ENABLED=flase never re-enables orders that were paused; an unknown or misspelled key is only
 * reported. A key in `setInEnv` keeps its environment value (ADR-037: env wins over the file) and is reported.
 * Never throws: a running service keeps working with what it has.
 */
export function parseRuntimeFile(content: string, startup: RuntimeSettings, setInEnv: readonly string[] = [], inForce: RuntimeSettings = startup): RuntimeFileResult {
  const problems: string[] = [];
  const values: Record<string, string> = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
      problems.push(`Line ${index + 1}: ${key || "a line without KEY=value"} is not a runtime key (${RUNTIME_KEYS.join(", ")})`);
      continue;
    }
    values[key] = line.slice(separator + 1).trim();
  }
  for (const key of setInEnv) {
    if (key in values) {
      problems.push(`${key} is set in the environment, which wins over the runtime file (ADR-037); the file's value is ignored`);
      delete values[key];
    }
  }
  const settings = readerOf(values, problems).runtime(startup, inForce);
  return { settings, problems };
}
