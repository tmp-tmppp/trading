import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  TENANT_CREATED_TYPE,
  TENANT_SCHEMA_PATTERN,
  isTenantId,
  parseTenantId,
  readTenantCreated,
  tenantSchemaIdentifier,
  tenantSchemaName,
} from "../../src/domain/tenant.js";

const tenantId = "018F3C1E-7A00-7000-8000-0000000000AA";

describe("tenant ids and schema names", () => {
  it("accepts UUIDs only and returns them in lower case", () => {
    expect(isTenantId(tenantId)).toBe(true);
    expect(parseTenantId(tenantId)).toBe("018f3c1e-7a00-7000-8000-0000000000aa");
    for (const bad of ["acme", "", "018f3c1e7a0070008000000000aa", `${tenantId}x`, 42, null]) {
      expect(isTenantId(bad), String(bad)).toBe(false);
    }
    expect(() => parseTenantId("acme", "tenantid")).toThrow(DomainError);
  });

  it("maps a tenant id to tenant_ and its 32 hex digits, as the payments service does", () => {
    expect(tenantSchemaName(tenantId)).toBe("tenant_018f3c1e7a00700080000000000000aa");
    expect(tenantSchemaName("018f3c1e-7a00-7000-8000-0000000000aa")).toBe(tenantSchemaName(tenantId));
    expect(TENANT_SCHEMA_PATTERN.test(tenantSchemaName(tenantId))).toBe(true);
    expect(tenantSchemaIdentifier(tenantId)).toBe(`"${tenantSchemaName(tenantId)}"`);
    // Request input can never reach SQL text through it.
    expect(() => tenantSchemaName('x"; DROP SCHEMA shared; --')).toThrow(DomainError);
  });
});

describe("readTenantCreated", () => {
  const event = {
    specversion: "1.0",
    id: "018f3c1e-7a00-7000-8000-000000000001",
    source: "/chance/tenants",
    type: TENANT_CREATED_TYPE,
    subject: `tenant/${tenantId}`,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: "corr-1",
    causationid: "req-1",
    data: { tenantId, name: "Acme", slug: "acme", createdAt: "2026-11-01T10:00:00.000Z", unknownField: true },
  };

  it("takes the id, the type, the tenant from tenantid and the correlation id", () => {
    expect(readTenantCreated(event)).toEqual({
      kind: "tenant_created",
      notice: { eventId: event.id, eventType: TENANT_CREATED_TYPE, tenantId: tenantId.toLowerCase(), correlationId: "corr-1" },
    });
    const { correlationid: _c, data: _d, ...minimal } = event;
    expect(readTenantCreated(minimal)).toMatchObject({ kind: "tenant_created", notice: { correlationId: null } });
  });

  it("ignores what is not a TenantCreated event trading can trust", () => {
    const ignored = (body: unknown) => {
      const result = readTenantCreated(body);
      return result.kind === "ignored" ? result : null;
    };
    expect(ignored("text")).toMatchObject({ eventId: null });
    expect(ignored([event])).toMatchObject({ eventId: null });
    expect(ignored({ ...event, specversion: "0.3" })).toMatchObject({ eventId: event.id });
    expect(ignored({ ...event, type: "si.chance.tenants.TenantCreated.v2" })?.reason).toMatch(/Unknown event type/);
    expect(ignored({ ...event, type: "si.chance.tenants.MemberJoined.v1" })).not.toBeNull();
    expect(ignored({ ...event, id: "not-a-uuid" })).toMatchObject({ eventId: null });
    expect(ignored({ ...event, tenantid: "acme" })?.reason).toMatch(/tenantid/);
    const { tenantid: _t, ...withoutTenant } = event;
    expect(ignored(withoutTenant)).not.toBeNull();
    expect(ignored({ ...event, data: { tenantId: "018f3c1e-7a00-7000-8000-0000000000bb" } })?.reason).toMatch(/differs/);
    expect(ignored({ ...event, data: { tenantId: 7 } })).not.toBeNull();
  });
});
