import { readFileSync } from "node:fs";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";
import { CREDIT_AMOUNT_MAX } from "../../src/domain/units.js";
import { DEBITS_PROTO_FILE, DEBIT_CREDITS_PATH, DEBITS_SERVICE_NAME, PROTO_LOADER_OPTIONS } from "../../src/web/grpc/debits-proto.js";
import { internalOpenapi, paymentsDebitContract } from "../support/contracts.js";
import { PROTO_FILE } from "../support/grpc-client.js";

// contracts/trading-debit.proto is written first; the server loads that very file. These tests keep it, the REST debit
// (the same use case on the other transport) and payments' own proposal of the call from drifting apart.

type Doc = Record<string, any>;
const definition = protoLoader.loadSync(PROTO_FILE, { keepCase: true });
const message = (name: string): { name: string; field: Array<{ name: string; number: number; label: string; type: string }> } =>
  (definition[`chance.trading.v1.${name}`] as unknown as { type: any }).type;
const camelToSnake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const protoText = readFileSync(PROTO_FILE, "utf8");
const readme = readFileSync(new URL("../../contracts/README.md", import.meta.url), "utf8");

const TYPE_OF_SCHEMA: Record<string, string> = { string: "TYPE_STRING", integer: "TYPE_INT32" };

describe("contracts/trading-debit.proto", () => {
  it("is the file the server loads, with the package, the service and the one call named in the contract", () => {
    expect(DEBITS_PROTO_FILE).toBe(PROTO_FILE);
    expect(protoText).toMatch(/^syntax = "proto3";$/m);
    expect(protoText).toMatch(/^package chance\.trading\.v1;$/m);
    const service = definition[DEBITS_SERVICE_NAME] as unknown as Record<string, Doc>;
    expect(Object.keys(service)).toEqual(["DebitCredits"]);
    expect(service["DebitCredits"]).toMatchObject({
      path: DEBIT_CREDITS_PATH,
      requestStream: false,
      responseStream: false,
      requestType: { type: { name: "DebitRequest" } },
      responseType: { type: { name: "DebitReply" } },
    });
  });

  it("has the fields of the REST DebitRequest, in snake case, of the same types, all of them required by the REST schema", () => {
    const rest = (internalOpenapi["components"] as Doc)["schemas"].DebitRequest as Doc;
    const fields = message("DebitRequest").field;
    expect(fields.map((field) => field.name).sort()).toEqual(Object.keys(rest["properties"]).map(camelToSnake).sort());
    expect(rest["required"].map(camelToSnake).sort()).toEqual(fields.map((field) => field.name).sort());
    for (const field of fields) {
      const schema = rest["properties"][Object.keys(rest["properties"]).find((name) => camelToSnake(name) === field.name) ?? ""] as Doc;
      expect(TYPE_OF_SCHEMA[schema["type"] as string], field.name).toBe(field.type);
      expect(field.label, field.name).toBe("LABEL_OPTIONAL");
    }
    // Numbers are part of the wire format: they never change once payments has a client.
    expect(Object.fromEntries(fields.map((field) => [field.name, field.number]))).toEqual({ withdrawal_id: 1, tenant_id: 2, user_id: 3, amount: 4 });
  });

  it("states the bounds of the REST body: the amount 1 to 1 000 000 (in an int32) and the user 1 to 255 characters", () => {
    const rest = (internalOpenapi["components"] as Doc)["schemas"].DebitRequest.properties as Doc;
    expect(rest["amount"]).toMatchObject({ minimum: 1, maximum: CREDIT_AMOUNT_MAX });
    expect(CREDIT_AMOUNT_MAX).toBeLessThan(2 ** 31);
    expect(rest["userId"]).toMatchObject({ minLength: 1, maxLength: 255 });
    expect(protoText).toContain("1 to 1 000 000");
    expect(protoText).toContain("1 to 255 characters");
    // payments' own proposal says the same, and both REST contracts and the proto name the same four fields.
    const proposal = (paymentsDebitContract["components"] as Doc)["schemas"].DebitRequest.properties as Doc;
    expect(Object.keys(proposal).map(camelToSnake).sort()).toEqual(message("DebitRequest").field.map((field) => field.name).sort());
    expect(proposal["amount"]).toMatchObject({ minimum: 1, maximum: CREDIT_AMOUNT_MAX });
  });

  it("has a reply with the REST DebitResult's fields (the withdrawal and the one status `debited`) and the debited amount", () => {
    const rest = (internalOpenapi["components"] as Doc)["schemas"].DebitResult as Doc;
    const fields = message("DebitReply").field;
    for (const name of Object.keys(rest["properties"])) expect(fields.map((field) => field.name)).toContain(camelToSnake(name));
    expect(fields.map((field) => field.name)).toEqual(["withdrawal_id", "status", "amount"]);
    expect(rest["properties"].status.enum).toEqual(["debited"]);

    const statusEnum = (definition["chance.trading.v1.DebitStatus"] as unknown as { type: { value: Array<{ name: string; number: number }> } }).type.value;
    expect(statusEnum.map(({ name, number }) => ({ name, number }))).toEqual([
      { name: "DEBIT_STATUS_UNSPECIFIED", number: 0 },
      { name: "DEBIT_STATUS_DEBITED", number: 1 },
    ]);
  });

  it("loads with the options the server uses", () => {
    const loaded = protoLoader.loadSync(PROTO_FILE, PROTO_LOADER_OPTIONS);
    expect(Object.keys(loaded)).toContain(DEBITS_SERVICE_NAME);
  });

  it("documents every status the server sends and every reason it gives, in the proto and in the contracts README", () => {
    const statuses = ["OK", "FAILED_PRECONDITION", "ALREADY_EXISTS", "INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL", "RESOURCE_EXHAUSTED"];
    const reasons = ["insufficient_credits", "idempotency_key_reused", "validation_failed", "unauthorized", "forbidden", "concurrent_update", "identity_provider_unavailable", "internal_error"];
    for (const [name, text] of [["the proto", protoText], ["contracts/README.md", readme]] as const) {
      for (const word of [...statuses, ...reasons]) expect(text, `${word} in ${name}`).toContain(word);
    }
    for (const word of ["authorization", "x-correlation-id", "retry-after", "8082", "trading-debit.proto"]) expect(readme, `${word} in contracts/README.md`).toContain(word);
  });

  // A server that is closing answers with the library's UNAVAILABLE, which has no trailing metadata at all (the real
  // server shows it: tests/web/grpc-debits.test.ts, "finishes the calls in flight"). payments copies the proto and
  // writes its retry logic from what the text promises, so the text must not promise `retry-after` for it.
  it("tells that the UNAVAILABLE of a server that is shutting down is the library's, with no `chance-problem-code`, `retry-after` or `x-correlation-id`", () => {
    const sentencesOf = (text: string): string[] => text.replace(/^\/\/ ?/gm, "").replace(/\s+/g, " ").split(/(?<=\.) /);
    for (const [name, text] of [["the proto", protoText], ["contracts/README.md", readme]] as const) {
      const sentences = sentencesOf(text);
      const shutdown = sentences.filter((sentence) => sentence.includes("shutting down"));
      expect(shutdown.length, `${name} says what a client sees while trading shuts down`).toBeGreaterThan(0);
      for (const sentence of shutdown) expect(sentence, `${name}: the shutdown answer comes from the library`).toContain("library");
      const lacking = ["`chance-problem-code`", "`retry-after`", "`x-correlation-id`"];
      expect(
        sentences.some((sentence) => sentence.includes("library") && lacking.every((key) => sentence.includes(key))),
        `${name} names the three keys that the library's own statuses lack`,
      ).toBe(true);
      expect(text, `${name} promises the keys for the answers of trading only`).not.toMatch(/every error carries/i);
    }
  });
});
