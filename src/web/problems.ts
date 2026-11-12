import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UseCaseError, Unavailable } from "../usecases/errors.js";
import type { FieldError, UseCaseErrorKind } from "../usecases/errors.js";

// RFC 9457 problem details (GP-6.14). Use-case errors are mapped to HTTP here and nowhere else (GP-6.28).
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** The API paths: what the gateway routes and what carries tenant data. The health probes are outside it. */
const API_PATH = /^\/v1(?:[/?]|$)/;

/**
 * INF-02: no cache, shared or private, keeps an answer that holds a tenant's data. Every /v1/ answer carries it,
 * problem details and the 404 of an unknown path included; the health probes carry none.
 */
export function noStoreForApi(request: FastifyRequest, reply: FastifyReply): void {
  if (API_PATH.test(request.url)) reply.header("cache-control", "private, no-store");
}

/** An error that is already an HTTP answer: authentication, authorization, a missing route. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The members every problem has; an extension member of the same name is never copied over them. */
const STANDARD_MEMBERS = ["type", "title", "status", "detail", "instance", "code", "errors"] as const;

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  errors?: FieldError[];
  /** Extension members (RFC 9457 section 3.2) such as maxAmount, quote or tradeSequence, copied from the error's details. */
  [extension: string]: unknown;
}

const STATUS_BY_KIND: Record<UseCaseErrorKind, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  unavailable: 503,
};

/** Dates become ISO 8601 text, so a problem's extension member reads like the same field of a normal answer. */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, jsonSafe(member)]));
  }
  return value;
}

function extensionMembers(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(details)) {
    if (!(STANDARD_MEMBERS as readonly string[]).includes(name)) members[name] = jsonSafe(value);
  }
  return members;
}

function problem(
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  errors?: FieldError[],
  details: Readonly<Record<string, unknown>> = {},
): Problem {
  return {
    ...extensionMembers(details),
    type: `urn:chance:problem:${code.replaceAll("_", "-")}`,
    title: STATUS_CODES[status] ?? "Error",
    status,
    detail,
    instance: request.url.split("?")[0] ?? request.url,
    code,
    ...(errors ? { errors } : {}),
  };
}

function send(reply: FastifyReply, body: Problem, headers: Record<string, string> = {}): FastifyReply {
  return reply.code(body.status).headers(headers).type(PROBLEM_CONTENT_TYPE).send(body);
}

/** Field errors of a failed JSON schema validation, named by the field the caller sent. */
function validationErrors(error: FastifyError): FieldError[] {
  return (error.validation ?? []).map((issue) => {
    const params = issue.params as { missingProperty?: string; additionalProperty?: string };
    const path = issue.instancePath.replace(/^\//, "").replaceAll("/", ".");
    const field = [path, params.missingProperty ?? params.additionalProperty].filter(Boolean).join(".");
    return { field: field || error.validationContext || "request", message: issue.message ?? "is invalid" };
  });
}

/**
 * Errors that Fastify raises before a route matches (a path parameter over the limit, a malformed URL) are problem
 * details as well, with a fixed text: the message of Fastify repeats the whole URL.
 */
export function frameworkErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  // The onSend hook of the application does not run for these answers, so the header is set here.
  noStoreForApi(request, reply);
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status === 414) {
    send(reply, problem(request, 414, "uri_too_long", "A path parameter is too long"));
  } else if (status >= 400 && status < 500) {
    send(reply, problem(request, status, "bad_request", "The request URL is invalid"));
  } else {
    send(reply, problem(request, 500, "internal_error", "The service failed to handle the request"));
  }
  // These answers bypass the hooks of the application, so the metrics are told here (src/adapters/metrics/metrics.ts).
  request.server.recordFrameworkError?.(request, reply);
}

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => send(reply, problem(request, 404, "not_found", "No such resource")));

  app.setErrorHandler((error: FastifyError | HttpError | UseCaseError, request, reply) => {
    if (error instanceof HttpError) {
      return send(reply, problem(request, error.status, error.code, error.message), error.headers);
    }
    if (error instanceof UseCaseError) {
      const status = STATUS_BY_KIND[error.kind];
      const body = problem(request, status, error.code, error.message, error.fields.length ? [...error.fields] : undefined, error.details);
      // A 503 always says when to come back (plan section 9): the tenant is being set up, orders are paused, the accounts
      // kept changing.
      const headers: Record<string, string> = error instanceof Unavailable ? { "retry-after": String(error.retryAfterSeconds) } : {};
      return send(reply, body, headers);
    }
    if ("validation" in error && error.validation) {
      const errors = validationErrors(error);
      const detail = `The request is invalid: ${errors.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`;
      return send(reply, problem(request, 400, "validation_failed", detail, errors));
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      return send(reply, problem(request, status, "bad_request", error.message));
    }
    request.log.error({ err: error }, "Unhandled error");
    return send(reply, problem(request, 500, "internal_error", "The service failed to handle the request"));
  });
}
