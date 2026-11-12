import type { JWTVerifyGetKey } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServiceCaller, ServiceClient } from "../usecases/ports.js";
import { bearerTokenVerifier, readPath, unauthorized } from "./auth.js";
import type { RequestHook, VerifyLog } from "./auth.js";
import { HttpError } from "./problems.js";

/**
 * The internal port (ADR-017, ADR-019): the tokens of the identity provider's client-credentials grant, verified like
 * user tokens (signature, issuer, required exp) against their own audience. The client id claim names the calling
 * service and each endpoint admits exactly one client; the tenant never comes from the token (plan section 9).
 */
export interface ServiceAuthOptions {
  /** Resolves the signing key of a token (the identity provider's JWKS in production, a local key in tests). */
  jwks: JWTVerifyGetKey;
  issuer: string;
  /** INTERNAL_AUTH_AUDIENCE. */
  audience: string;
  /** The claim that carries the client id of the token, for example "azp". */
  clientClaim: string;
  /** The identity provider's client id of each calling service. */
  clients: Record<ServiceClient, string>;
}

/** Who a verified service token belongs to: its client id, and the service that id names (null for any other client). */
export interface ServiceIdentity {
  clientId: string | null;
  client: ServiceClient | null;
}

declare module "fastify" {
  interface FastifyRequest {
    service: ServiceIdentity | null;
  }
}

/**
 * The verification of a service token from the value of the Authorization header (the `authorization` metadata of a
 * gRPC call): the bearer token as for users, then the calling service from the client id claim. The one function the
 * HTTP port and the gRPC port both use, so that they admit the same callers. Errors are HttpError (401, 503).
 */
export function serviceVerifier(options: ServiceAuthOptions): (authorization: string | undefined, log: VerifyLog) => Promise<ServiceIdentity> {
  const verify = bearerTokenVerifier({ issuer: options.issuer, audience: options.audience, getKey: options.jwks });
  return async (authorization, log) => {
    const payload = await verify(authorization, log);
    const claim = readPath(payload, options.clientClaim);
    const clientId = typeof claim === "string" && claim !== "" ? claim : null;
    const client = clientId === null ? null : ((Object.entries(options.clients).find(([, id]) => id === clientId)?.[0] as ServiceClient | undefined) ?? null);
    return { clientId, client };
  };
}

/** onRequest hook of the internal port: verifies the bearer token and puts the calling service on the request. */
export function authenticateService(options: ServiceAuthOptions): RequestHook {
  const verify = serviceVerifier(options);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const identity = await verify(request.headers.authorization, request.log);
    request.service = identity;
    // A client id is a public name, not a secret: it helps to tell the callers apart in the logs.
    request.log = reply.log = request.log.child({ client: identity.clientId });
  };
}

function requireService(request: FastifyRequest): ServiceIdentity {
  if (!request.service) throw unauthorized("A bearer token is required", "Bearer");
  return request.service;
}

/** The caller is this service: 403 for any other client, also for a user's token. The check of both transports. */
export function assertClient(identity: ServiceIdentity, client: ServiceClient): void {
  if (identity.client !== client) {
    throw new HttpError(403, "forbidden", "The token belongs to another client than this endpoint admits");
  }
}

/** preValidation hook: the caller is this service (403 for any other client, also for a user's token), before validation. */
export function requireClient(client: ServiceClient): RequestHook {
  return (request) =>
    Promise.resolve().then(() => {
      assertClient(requireService(request), client);
    });
}

/** preValidation hook of the local events route: any of the three services. */
export const requireAnyClient: RequestHook = (request) =>
  Promise.resolve().then(() => {
    if (requireService(request).client === null) throw new HttpError(403, "forbidden", "The token does not belong to a known service");
  });

/** The caller of an internal use case; the ids tie its events to this request. */
export function serviceCallerOf(request: FastifyRequest): ServiceCaller {
  const { client } = requireService(request);
  if (client === null) throw new HttpError(403, "forbidden", "The token does not belong to a known service");
  return { client, correlationId: request.correlationId, causationId: request.id };
}
