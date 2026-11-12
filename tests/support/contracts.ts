import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

type Doc = Record<string, any>;

const parseFile = (url: URL): Doc => parse(readFileSync(url, "utf8")) as Doc;
const read = (file: string): Doc => parseFile(new URL(`../../contracts/${file}`, import.meta.url));

/** Trading's own contracts. */
export const openapi = read("openapi.yaml");
export const internalOpenapi = read("internal.openapi.yaml");
export const asyncapi = read("asyncapi.yaml");

// The sibling services' files are copies in contracts/external (their origin and hashes: contracts/README.md), because
// this repository is built on its own and its pipeline never has the sibling folders. A test that compared against a
// folder that may be missing would be skipped there, and the check would never run; the copies always exist.
/** What markets expects of trading's funding endpoint (markets' contracts/outgoing). */
export const marketsFundingContract: Doc = read("external/markets-trading-market-funding.openapi.yaml");
/** What payments proposes for the debit endpoint (payments' contracts). */
export const paymentsDebitContract: Doc = read("external/payments-trading-debit.openapi.yaml");
/** payments' event contract: it consumes trading's WithdrawalRefunded (a proposal there). */
export const paymentsAsyncapi: Doc = read("external/payments-asyncapi.yaml");

// OpenAPI 3.1 schemas are JSON Schema 2020-12.
const openapiAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(openapiAjv);

// AsyncAPI 3.0 schemas default to a superset of JSON Schema draft-07.
const asyncapiAjv = new Ajv({ strict: false, allErrors: true });
addFormats.default(asyncapiAjv);

const describeErrors = (errors: ReadonlyArray<{ instancePath: string; message?: string }> | null | undefined): string[] =>
  (errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);

function resolveResponse(doc: Doc, response: Doc): Doc {
  return response.$ref ? doc["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
}

/** Errors of a body against the schema of an operation's response in an OpenAPI document; empty = valid. */
export function responseErrorsIn(doc: Doc, path: string, method: string, status: number, body: unknown): string[] {
  const response = doc["paths"][path]?.[method.toLowerCase()]?.responses?.[String(status)];
  if (!response) return [`${method} ${path} has no ${status} response in the contract`];
  const resolved = resolveResponse(doc, response);
  const content = resolved.content?.["application/json"] ?? resolved.content?.["application/problem+json"];
  if (!content) return [];
  const validate = openapiAjv.compile({ components: doc["components"], ...content.schema });
  return validate(body) ? [] : describeErrors(validate.errors);
}

/** Errors of a request body against the requestBody schema of an operation in an OpenAPI document; empty = valid. */
export function requestErrorsIn(doc: Doc, path: string, method: string, body: unknown): string[] {
  const operation = doc["paths"][path]?.[method.toLowerCase()];
  const schema = operation?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return [`${method} ${path} has no request body schema in the contract`];
  const validate = openapiAjv.compile({ components: doc["components"], ...schema });
  return validate(body) ? [] : describeErrors(validate.errors);
}

/** The statuses an OpenAPI operation documents, as numbers. */
export function documentedStatuses(doc: Doc, path: string, method: string): number[] {
  return Object.keys(doc["paths"][path][method.toLowerCase()].responses as Record<string, unknown>).map(Number);
}

/** Errors of a body against the schema of an operation's response in contracts/openapi.yaml (the public API). */
export const publicResponseErrors = (path: string, method: string, status: number, body: unknown): string[] => responseErrorsIn(openapi, path, method, status, body);

/** Errors of a body against the schema of an operation's response in contracts/internal.openapi.yaml. */
export const internalResponseErrors = (path: string, method: string, status: number, body: unknown): string[] =>
  responseErrorsIn(internalOpenapi, path, method, status, body);

/** Errors of an event against a schema of any AsyncAPI document, for example "WithdrawalRefundedEvent" of payments' contract. */
export function eventErrorsIn(doc: Doc, schemaName: string, event: unknown): string[] {
  const validate = asyncapiAjv.compile({ components: doc["components"], $ref: `#/components/schemas/${schemaName}` });
  return validate(event) ? [] : describeErrors(validate.errors);
}

/** Errors of an event against a schema of contracts/asyncapi.yaml, for example "TradeExecutedEvent". */
export const eventErrors = (schemaName: string, event: unknown): string[] => eventErrorsIn(asyncapi, schemaName, event);

/** Errors of a value against a named schema of the components of any OpenAPI document. */
export function schemaErrorsIn(doc: Doc, schemaName: string, value: unknown): string[] {
  const validate = openapiAjv.compile({ components: doc["components"], $ref: `#/components/schemas/${schemaName}` });
  return validate(value) ? [] : describeErrors(validate.errors);
}
