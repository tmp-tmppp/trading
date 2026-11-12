import { Ajv } from "ajv";
import type { SchemaObject } from "ajv";
import addFormats from "ajv-formats";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Actor } from "../usecases/ports.js";
import { requireMember } from "./auth.js";
import { frameworkErrorHandler, noStoreForApi, registerProblemHandlers } from "./problems.js";

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every route that was registered, for the contract tests. */
    registeredRoutes: RegisteredRoute[];
  }
}

// Letters, digits and a few separators, so a client cannot inject anything odd into logs and headers (the gRPC port reads
// the metadata x-correlation-id by the same rule).
export const CORRELATION_ID =/^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The longest path parameter the router accepts, measured on the raw text of the URL. Fastify's default is 100, which
 * is more than a market id (a UUID, 36 characters) needs: a value up to this length gets the 400 of the schema, a longer one
 * the 414 problem of frameworkErrorHandler.
 */
const MAX_PARAM_LENGTH = 512;

/** The options Fastify's own validator uses, except that every error is reported and unknown fields are kept for the schema to refuse. */
const VALIDATOR_OPTIONS = { allErrors: true, removeAdditional: false, useDefaults: true, allowUnionTypes: true };

/**
 * Who is calling and which request it is; the use cases put this into the events they write. The tenant and the role
 * come only from the token (403 for a platform admin, a token without a tenant or without a trading role), and the ids
 * that tie the events to the request are the correlation id of the caller and the id of this request.
 */
export function actorOf(request: FastifyRequest): Actor {
  const member = requireMember(request);
  return { ...member, correlationId: request.correlationId, causationId: request.id };
}

/**
 * The parts the public and the internal application share: request ids, correlation, strict body validation, problem
 * details, the no-store header of the API and the route list for the contract tests. The routes and the hooks of each
 * port are added by its own builder.
 */
export function createBaseApp(options: { logger: PinoLogger; bodyLimit: number }): FastifyInstance {
  const logger: FastifyBaseLogger = options.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    genReqId: () => uuidv7(),
    exposeHeadRoutes: false,
    bodyLimit: options.bodyLimit,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    frameworkErrors: frameworkErrorHandler,
  });

  // The body is checked strictly: a string amount or a numeric side is a 400, not a silent conversion (the contracts say
  // integer and string). The querystring, the path and the headers arrive as text and keep the coercion (?amount=25).
  const strict = new Ajv({ ...VALIDATOR_OPTIONS, coerceTypes: false });
  const coercing = new Ajv({ ...VALIDATOR_OPTIONS, coerceTypes: "array" });
  addFormats.default(strict);
  addFormats.default(coercing);
  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === "body" ? strict : coercing).compile(schema as SchemaObject));

  // A request that needs no body may still carry Content-Type: application/json, as curl and many fetch wrappers send it:
  // an empty body is "no body", not a 400. Fastify's own parser stays for everything else (prototype poisoning guard, 400
  // on malformed JSON), and a route whose schema needs a body still answers 400 for an empty one.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    // parseAs "string" always gives text; the Buffer branch only satisfies the type.
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text === "") {
      done(null, undefined);
      return;
    }
    // The default parser answers through `done`; the type also allows a promise, which is never returned here.
    void parseJson(request, text, done);
  });

  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("service", null);
  app.decorateRequest("correlationId", "");

  // Correlation: take X-Correlation-Id from the caller or make one, return it and bind it to the request logger.
  app.addHook("onRequest", (request, reply, done) => {
    const sent = request.headers["x-correlation-id"];
    request.correlationId = typeof sent === "string" && CORRELATION_ID.test(sent) ? sent : uuidv7();
    reply.header("x-correlation-id", request.correlationId);
    request.log = reply.log = request.log.child({ correlationId: request.correlationId });
    done();
  });

  // INF-02: every /v1/ answer carries Cache-Control: private, no-store (see noStoreForApi).
  app.addHook("onSend", (request, reply, payload, done) => {
    noStoreForApi(request, reply);
    done(null, payload);
  });

  registerProblemHandlers(app);
  return app;
}
