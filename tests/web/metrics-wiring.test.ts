import { readFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { tenantOfRequest } from "../../src/web/auth.js";

// src/main.ts is the composition root and is excluded from coverage, so no other test runs it. These checks pin the
// lines of the metrics convention that only it holds: the tenant label comes from the verified token and from nothing
// else, one registry serves both HTTP applications and the order counters, the listener has its own port, and it closes
// with the service.

const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

const requestWith = (parts: object): FastifyRequest => parts as unknown as FastifyRequest;

describe("tenantOfRequest, the tenant label of the metrics", () => {
  it("is the tenant of the token the service verified", () => {
    expect(tenantOfRequest(requestWith({ auth: { userId: "user-1", tenantId: "acme" } }))).toBe("acme");
  });

  it("is null when the token names no tenant or there is no verified token (every request of the internal port)", () => {
    expect(tenantOfRequest(requestWith({ auth: { userId: "user-1", tenantId: null } }))).toBeNull();
    expect(tenantOfRequest(requestWith({ auth: null, service: { clientId: "markets", client: "markets" } }))).toBeNull();
  });

  it("never reads a header or the body", () => {
    const request = requestWith({ auth: null, headers: { "x-tenant-id": "acme" }, body: { tenantId: "acme", tenant: "acme" } });
    expect(tenantOfRequest(request)).toBeNull();
  });
});

describe("the metrics wiring of src/main.ts", () => {
  it("takes the tenant label from tenantOfRequest, with one registry for everything", () => {
    expect(main).toContain("createMetrics({ tenantOf: tenantOfRequest })");
    expect(main).toContain("instrumentTrading(metrics.registry,");
  });

  it("attaches the metrics to both HTTP applications", () => {
    expect(main.match(/^\s+metrics,$/gm)).toHaveLength(2);
    expect(main).toMatch(/buildPublicApp\(\{[\s\S]*?\n {4}metrics,\n {2}\}\);/);
    expect(main).toMatch(/buildInternalApp\(\{[\s\S]*?\n {4}metrics,\n {2}\}\);/);
  });

  it("serves the metrics on their own port, once per process, and closes that listener on shutdown", () => {
    expect(main).toContain("startMetricsServer(metrics.registry, { port: config.metricsPort })");
    expect(main.match(/startMetricsServer\(/g)).toHaveLength(1);
    expect(main).toContain("await metricsServer.close()");
  });
});
