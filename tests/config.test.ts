import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_RUNTIME_SETTINGS, LOCAL_INTERNAL_PORT, loadConfig, parseRuntimeFile, runtimeKeysInEnv, runtimeSettingsOf } from "../src/config.js";

const PRODUCTION = {
  DATABASE_URL: "postgres://trading:secret@db:5432/trading", // hooks:allow test fixture, not a real password
  NATS_URL: "nats://nats:4222",
  AUTH_JWKS_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "https://auth.example/realms/chance",
  AUTH_AUDIENCE: "chance",
};

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("runs locally with in-memory defaults, the internal port beside a local Keycloak and no wait on shutdown", () => {
    const config = loadConfig({ APP_ENV: "local" });
    expect(config).toMatchObject({
      isLocal: true,
      port: 8080,
      internalPort: LOCAL_INTERNAL_PORT,
      databaseUrl: null,
      natsUrl: null,
      shutdownDelayMs: 0,
      seedCredits: [],
      tradingRules: DEFAULT_RUNTIME_SETTINGS.tradingRules,
    });
    expect(config.auth.audience).toBe("chance");
    expect(config.internalAuth).toEqual({
      audience: "chance",
      clientClaim: "azp",
      marketsClientId: "markets",
      paymentsClientId: "payments",
      marketMakerClientId: "market-maker",
    });
  });

  it("reads STREAM_MAX_AGE_DAYS: 30 days by default, 1 to 365 days allowed, anything else is reported", () => {
    expect(loadConfig(PRODUCTION).streamMaxAgeDays).toBe(30);
    expect(loadConfig({ ...PRODUCTION, STREAM_MAX_AGE_DAYS: "1" }).streamMaxAgeDays).toBe(1);
    expect(loadConfig({ ...PRODUCTION, STREAM_MAX_AGE_DAYS: "365" }).streamMaxAgeDays).toBe(365);
    for (const bad of ["0", "366", "-7", "1.5", "thirty"]) {
      expect(problemsOf({ ...PRODUCTION, STREAM_MAX_AGE_DAYS: bad }), bad).toEqual(["STREAM_MAX_AGE_DAYS must be an integer from 1 to 365"]);
    }
  });

  it("requires the database, the broker and the token settings outside local mode", () => {
    const problems = problemsOf({});
    for (const name of ["DATABASE_URL", "NATS_URL", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
      expect(problems.some((problem) => problem.startsWith(name))).toBe(true);
    }
    const config = loadConfig(PRODUCTION);
    expect(config).toMatchObject({ isLocal: false, port: 8080, internalPort: 8081, shutdownDelayMs: 5000, databasePoolMax: 5, outboxPollMs: 300, streamMaxAgeDays: 30 });
    expect(config.internalAuth.audience).toBe("chance");
  });

  it("reads every setting and reports all problems at once, never the values", () => {
    const config = loadConfig({
      ...PRODUCTION,
      PORT: "9000",
      INTERNAL_PORT: "9001",
      INTERNAL_AUTH_AUDIENCE: "trading-internal",
      INTERNAL_CLIENT_CLAIM: "client_id",
      MARKETS_CLIENT_ID: "svc-markets",
      ORDER_AMOUNT_MAX: "500",
      MAX_OFFERS_PER_SIDE: "4",
      ORDERS_ENABLED: "false",
      LOG_LEVEL: "debug",
    });
    expect(config).toMatchObject({ port: 9000, internalPort: 9001, logLevel: "debug", tradingRules: { orderAmountMax: 500, maxOffersPerSide: 4, ordersEnabled: false } });
    expect(config.internalAuth).toMatchObject({ audience: "trading-internal", clientClaim: "client_id", marketsClientId: "svc-markets" });
    const problems = problemsOf({ ...PRODUCTION, PORT: "8081", ORDERS_ENABLED: "yes", MAX_OFFERS_PER_SIDE: "51", DATABASE_URL: "mysql://x", PAYMENTS_CLIENT_ID: "markets" });
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).not.toContain("secret");
  });

  it("reads GRPC_PORT: 8082 in the cluster and locally, 1 to 65535, and never the port of another API", () => {
    expect(loadConfig(PRODUCTION).grpcPort).toBe(8082);
    expect(loadConfig({ APP_ENV: "local" }).grpcPort).toBe(8082);
    expect(loadConfig({ ...PRODUCTION, GRPC_PORT: "9002" }).grpcPort).toBe(9002);
    for (const bad of ["0", "65536", "-1", "8082.5", "grpc"]) {
      expect(problemsOf({ ...PRODUCTION, GRPC_PORT: bad }), bad).toEqual(["GRPC_PORT must be an integer from 1 to 65535"]);
    }
    const clash = "PORT, INTERNAL_PORT and GRPC_PORT must differ: the NetworkPolicy admits other callers to each";
    expect(problemsOf({ ...PRODUCTION, GRPC_PORT: "8080" })).toEqual([clash]);
    expect(problemsOf({ ...PRODUCTION, GRPC_PORT: "8081" })).toEqual([clash]);
    expect(problemsOf({ ...PRODUCTION, PORT: "8082" })).toEqual([clash]);
    expect(problemsOf({ APP_ENV: "local", GRPC_PORT: "8091" })).toEqual([clash]);
  });

  describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
    it("defaults to 9464, also in local mode", () => {
      expect(loadConfig(PRODUCTION).metricsPort).toBe(9464);
      expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    });

    it("takes a port from 1 to 65535", () => {
      expect(loadConfig({ ...PRODUCTION, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
      expect(loadConfig({ ...PRODUCTION, METRICS_PORT: "1" }).metricsPort).toBe(1);
      expect(loadConfig({ ...PRODUCTION, METRICS_PORT: "65535" }).metricsPort).toBe(65_535);
    });

    it.each(["0", "65536", "-1", "9464.5", "abc"])("rejects %s", (value) => {
      expect(problemsOf({ ...PRODUCTION, METRICS_PORT: value })).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
    });

    it("must differ from the three API ports: no API port ever serves /metrics", () => {
      const problem = "METRICS_PORT must differ from PORT, INTERNAL_PORT and GRPC_PORT (the API ports never serve /metrics)";
      expect(problemsOf({ ...PRODUCTION, METRICS_PORT: "8080" })).toEqual([problem]);
      expect(problemsOf({ ...PRODUCTION, METRICS_PORT: "8081" })).toEqual([problem]);
      expect(problemsOf({ ...PRODUCTION, METRICS_PORT: "8082" })).toEqual([problem]);
      expect(problemsOf({ APP_ENV: "local", METRICS_PORT: "8091" })).toEqual([problem]);
      expect(problemsOf({ ...PRODUCTION, PORT: "9464" })).toEqual([problem]);
      expect(loadConfig({ ...PRODUCTION, PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
    });
  });

  it("allows SEED_CREDITS in local mode only and checks every entry", () => {
    const tenant = "018f3c1e-7a00-7000-8000-0000000000AA";
    const config = loadConfig({ APP_ENV: "local", SEED_CREDITS: `${tenant}/trader-1=500, ${tenant}/admin-1=5000` });
    expect(config.seedCredits).toEqual([
      { tenantId: tenant.toLowerCase(), userId: "trader-1", amount: 500 },
      { tenantId: tenant.toLowerCase(), userId: "admin-1", amount: 5000 },
    ]);
    expect(problemsOf({ ...PRODUCTION, SEED_CREDITS: `${tenant}/trader-1=500` })).toEqual([
      "SEED_CREDITS is only allowed with APP_ENV=local (test credits are seed data, plan 6.2)",
    ]);
    expect(problemsOf({ APP_ENV: "local", SEED_CREDITS: "acme/trader-1=5,x" })).toHaveLength(2);
  });
});

describe("runtime file (ADR-037)", () => {
  const startup = runtimeSettingsOf(loadConfig({ APP_ENV: "local" }));

  it("applies runtime keys, falls back to startup values for the rest and reports unknown keys", () => {
    const { settings, problems } = parseRuntimeFile("# comment\nORDERS_ENABLED=false\nORDER_AMOUNT_MAX=250\nPORT=1\n\nLOG_LEVEL=warn\n", startup);
    expect(settings).toEqual({ logLevel: "warn", tradingRules: { orderAmountMax: 250, maxOffersPerSide: 10, ordersEnabled: false } });
    expect(problems).toEqual(["Line 4: PORT is not a runtime key (LOG_LEVEL, ORDER_AMOUNT_MAX, MAX_OFFERS_PER_SIDE, ORDERS_ENABLED)"]);
  });

  it("keeps the startup value of an invalid key and lets the environment win", () => {
    const { settings, problems } = parseRuntimeFile("ORDER_AMOUNT_MAX=0\nLOG_LEVEL=debug", startup, ["LOG_LEVEL"]);
    expect(settings).toEqual(startup);
    expect(problems).toHaveLength(2);
    expect(runtimeKeysInEnv({ LOG_LEVEL: "warn", ORDERS_ENABLED: " ", PORT: "1" })).toEqual(["LOG_LEVEL"]);
  });

  it("keeps the value in force for a key whose value is invalid, and goes back to the startup value for a key that is left out", () => {
    const running = { logLevel: "warn", tradingRules: { orderAmountMax: 250, maxOffersPerSide: 4, ordersEnabled: false } } as const;

    const typos = parseRuntimeFile("ORDERS_ENABLED=flase\nORDER_AMOUNT_MAX=5O\nMAX_OFFERS_PER_SIDE=0\nLOG_LEVEL=loud", startup, [], running);

    expect(typos.settings).toEqual(running);
    expect(typos.problems).toHaveLength(4);
    expect(parseRuntimeFile("ORDER_AMOUNT_MAX=300", startup, [], running).settings).toEqual({ ...startup, tradingRules: { ...startup.tradingRules, orderAmountMax: 300 } });
    expect(parseRuntimeFile("", startup, [], running).settings).toEqual(startup);
  });
});
