import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConcurrentUpdate } from "../../src/usecases/errors.js";
import type { DebitInput, DebitResult, DebitWithdrawalUseCase } from "../../src/usecases/use-cases.js";
import { loadDebitsService } from "../../src/web/grpc/debits-proto.js";
import { DebitsGrpcServer } from "../../src/web/grpc/debits-server.js";
import type { ServiceAuthOptions } from "../../src/web/service-auth.js";
import { TENANT_A, TENANT_B, TRADER } from "../support/fakes.js";
import { DebitClient } from "../support/grpc-client.js";
import type { DebitOptions, DebitRequestBody, Outcome } from "../support/grpc-client.js";
import { CREDIT, asTrader, call, callInternal, createHarness, grant } from "../support/harness.js";
import type { Harness } from "../support/harness.js";
import { AUDIENCE, ISSUER } from "../support/tokens.js";

// The gRPC debit against a real server over a real HTTP/2 connection, with a client that loads contracts/trading-debit.proto
// by itself, and real signed tokens. Every status of the table in the proto, the idempotency shared with REST, deadlines
// and the graceful close.

const WITHDRAWAL = (n: number): string => `018f3c1e-7a00-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const [W_DEBIT, W_REFUSED, W_BODY, W_SHARED_REST, W_SHARED_GRPC, W_REFUSED_REST, W_REFUSED_GRPC, W_CASE, W_FAKE, W_LATE, W_NEVER, W_CORR, W_CANCEL] = [
  WITHDRAWAL(11),
  WITHDRAWAL(12),
  WITHDRAWAL(13),
  WITHDRAWAL(14),
  WITHDRAWAL(15),
  WITHDRAWAL(16),
  WITHDRAWAL(17),
  WITHDRAWAL(18),
  WITHDRAWAL(19),
  WITHDRAWAL(20),
  WITHDRAWAL(21),
  WITHDRAWAL(22),
  WITHDRAWAL(23),
];

const DEBITS_URL = "/v1/internal/debits";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A promise that a test opens by hand: the fake use case or the key resolver waits on it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const request = (withdrawalId: string, amount: number, overrides: Partial<DebitRequestBody> = {}): DebitRequestBody => ({
  withdrawal_id: withdrawalId,
  tenant_id: TENANT_A,
  user_id: TRADER,
  amount,
  ...overrides,
});

describe("gRPC Debits.DebitCredits (payments)", () => {
  let h: Harness;
  let server: DebitsGrpcServer;
  let client: DebitClient;
  let address: string;

  beforeAll(async () => {
    h = await createHarness();
    server = new DebitsGrpcServer({ logger: h.logger, debitWithdrawal: h.core.useCases.debitWithdrawal, auth: h.serviceAuth });
    const port = await server.start("127.0.0.1", 0);
    address = `127.0.0.1:${port}`;
    client = new DebitClient(address);
    await grant(h.core, TRADER, 100);
  });
  afterAll(async () => {
    client.close();
    await server.close(1000);
    await h.close();
  });

  /** The call of payments: its own service token unless the test says otherwise. */
  const debit = async (body: DebitRequestBody, options: DebitOptions = {}): Promise<Outcome> =>
    client.debit(body, { ...options, token: options.token === undefined ? await h.signService("payments") : options.token });
  const balance = async (): Promise<number> => (await call(h, "GET", "/v1/trading/portfolio", { token: asTrader(TRADER) })).body?.["balanceMicro"] as number;

  it("debits and answers OK with the withdrawal, the status and the amount; a repeat answers OK again and debits nothing more", async () => {
    const before = await balance();
    const first = await debit(request(W_DEBIT, 40));
    expect(first.code).toBe(grpc.status.OK);
    expect(first.reply).toEqual({ withdrawal_id: W_DEBIT, status: "DEBIT_STATUS_DEBITED", amount: 40 });
    expect(first.trailer("x-correlation-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await balance()).toBe(before - 40 * CREDIT);

    const again = await debit(request(W_DEBIT, 40));
    expect(again.code).toBe(grpc.status.OK);
    expect(again.reply).toEqual(first.reply);
    // The id is read in any letter case and answered in lower case; it is the same withdrawal, not a second debit.
    const upper = await debit(request(W_DEBIT.toUpperCase(), 40));
    expect(upper.code).toBe(grpc.status.OK);
    expect(upper.reply?.withdrawal_id).toBe(W_DEBIT);
    expect(await balance()).toBe(before - 40 * CREDIT);
  });

  it("answers FAILED_PRECONDITION with the reason insufficient_credits, definitive for the withdrawal: it stays so after the user topped up", async () => {
    const before = await balance();
    const refused = await debit(request(W_REFUSED, 1000));
    expect(refused.code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(refused.reply).toBeNull();
    expect(refused.trailer("chance-problem-code")).toBe("insufficient_credits");
    expect(refused.details).toContain("credits");
    expect(refused.trailer("x-correlation-id")).toBeDefined();
    expect(await balance()).toBe(before);

    await grant(h.core, TRADER, 5000);
    const again = await debit(request(W_REFUSED, 1000));
    expect(again.code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(again.trailer("chance-problem-code")).toBe("insufficient_credits");
    expect(await balance()).toBe(before + 5000 * CREDIT);
  });

  it("answers ALREADY_EXISTS with the reason idempotency_key_reused for a withdrawal id repeated with another amount, user or tenant", async () => {
    const before = await balance();
    for (const [name, other] of [
      ["amount", request(W_DEBIT, 41)],
      ["user", request(W_DEBIT, 40, { user_id: "someone-else" })],
      ["tenant", request(W_DEBIT, 40, { tenant_id: TENANT_B })],
    ] as const) {
      const answer = await debit(other);
      expect(answer.code, name).toBe(grpc.status.ALREADY_EXISTS);
      expect(answer.trailer("chance-problem-code"), name).toBe("idempotency_key_reused");
    }
    expect(await balance()).toBe(before);
  });

  it("answers INVALID_ARGUMENT with the reason validation_failed and the proto field names for a missing or out-of-bounds field", async () => {
    const before = await balance();
    const cases: Array<[string, Partial<DebitRequestBody>, string]> = [
      ["missing withdrawal id", { withdrawal_id: "" }, "withdrawal_id"],
      ["withdrawal id that is no UUID", { withdrawal_id: "w-1" }, "withdrawal_id"],
      ["tenant id that is no UUID", { tenant_id: "acme" }, "tenant_id"],
      ["missing tenant id", { tenant_id: "" }, "tenant_id"],
      ["empty user", { user_id: "" }, "user_id"],
      ["user of 256 characters", { user_id: "x".repeat(256) }, "user_id"],
      ["user with surrounding spaces", { user_id: " trader-1" }, "user_id"],
      ["amount 0 (a missing amount reads as 0)", { amount: 0 }, "amount"],
      ["negative amount", { amount: -5 }, "amount"],
      ["amount above 1 000 000", { amount: 1_000_001 }, "amount"],
    ];
    for (const [name, overrides, field] of cases) {
      const answer = await debit(request(W_BODY, 10, overrides));
      expect(answer.code, name).toBe(grpc.status.INVALID_ARGUMENT);
      expect(answer.trailer("chance-problem-code"), name).toBe("validation_failed");
      expect(answer.details, name).toContain(field);
      // The proto's names, not the REST body's: withdrawalId, tenantId and userId never reach a gRPC client.
      expect(answer.details, name).not.toMatch(/[a-z][A-Z]/);
    }
    // The bounds themselves are fine: a user of 255 characters, an amount of 1 and one of 1 000 000 are valid input.
    const longUser = "x".repeat(255);
    await grant(h.core, longUser, 5);
    expect((await debit(request(WITHDRAWAL(30), 1, { user_id: longUser }))).code).toBe(grpc.status.OK);
    expect((await debit(request(WITHDRAWAL(33), 1_000_000))).code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(await balance()).toBe(before);
  });

  it("answers RESOURCE_EXHAUSTED for a message above 16 KiB, before the handler sees it", async () => {
    const answer = await debit(request(W_BODY, 10, { user_id: "x".repeat(20 * 1024) }));
    expect(answer.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
  });

  describe("authentication, exactly as the internal REST endpoints", () => {
    const payments = { sub: "service-account-payments", azp: "payments", audience: AUDIENCE };

    it("answers UNAUTHENTICATED with the reason unauthorized for a missing, malformed, expired or untrusted token", async () => {
      const before = await balance();
      const good = await h.signService("payments");
      const cases: Array<[string, DebitOptions]> = [
        ["no authorization metadata", { token: null }],
        ["not a token", { token: "not-a-token" }],
        ["the Basic scheme", { token: null, metadata: { authorization: ["Basic YTpi"] } }],
        ["a token with a trailing part", { token: `${good} ${good}` }],
        ["an expired token", { token: await h.sign({ ...payments, expiresIn: -60 }) }],
        ["a token without exp", { token: await h.sign({ ...payments, noExpiry: true }) }],
        ["another audience", { token: await h.sign({ ...payments, audience: "another-audience" }) }],
        ["another issuer", { token: await h.sign({ ...payments, issuer: `${ISSUER}-other` }) }],
        ["a key the service does not trust", { token: await h.keys.signWithOtherKey(payments) }],
      ];
      for (const [name, options] of cases) {
        const answer = await debit(request(W_CASE, 10), options);
        expect(answer.code, name).toBe(grpc.status.UNAUTHENTICATED);
        expect(answer.trailer("chance-problem-code"), name).toBe("unauthorized");
        expect(answer.reply, name).toBeNull();
      }
      expect(await balance()).toBe(before);
    });

    it("answers PERMISSION_DENIED with the reason forbidden for a valid token that is not the client payments, before it looks at the input", async () => {
      const before = await balance();
      const cases: Array<[string, string]> = [
        ["markets", await h.signService("markets")],
        ["market-maker", await h.signService("market-maker")],
        ["a user's token", await h.sign(asTrader(TRADER))],
        ["a client that is none of the three", await h.sign({ ...payments, azp: "another-client" })],
        ["no client claim", await h.sign({ sub: "service-account-x", audience: AUDIENCE })],
      ];
      for (const [name, token] of cases) {
        const answer = await debit(request(W_CASE, 10), { token });
        expect(answer.code, name).toBe(grpc.status.PERMISSION_DENIED);
        expect(answer.trailer("chance-problem-code"), name).toBe("forbidden");
      }
      // 403 comes before the validation of the body, as on the REST port.
      const invalid = await debit(request("not-a-uuid", 0), { token: await h.signService("markets") });
      expect(invalid.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(await balance()).toBe(before);
    });

    it("answers UNAVAILABLE with the reason identity_provider_unavailable and retry-after while the signing keys cannot be fetched", async () => {
      const token = await h.signService("payments");
      h.failKeys(new Error("the key set cannot be downloaded"));
      try {
        const answer = await debit(request(W_CASE, 10), { token });
        expect(answer.code).toBe(grpc.status.UNAVAILABLE);
        expect(answer.trailer("chance-problem-code")).toBe("identity_provider_unavailable");
        expect(answer.trailer("retry-after")).toBe("5");
      } finally {
        h.failKeys(null);
      }
      expect((await debit(request(WITHDRAWAL(31), 1), { token })).code).toBe(grpc.status.OK);
    });

    it("never writes a token into a log line", async () => {
      const token = await h.signService("payments");
      await debit(request(WITHDRAWAL(32), 1), { token });
      await debit(request(W_CASE, 10), { token: `${token}x` });
      expect(h.logLines.join("")).not.toContain(token.slice(20, 80));
    });
  });

  describe("failures of the use case", () => {
    const fake = (execute: (input: DebitInput) => Promise<DebitResult>): DebitWithdrawalUseCase => ({ execute });

    async function serve(use: DebitWithdrawalUseCase, extra: { now?: () => number; auth?: ServiceAuthOptions } = {}) {
      const own = new DebitsGrpcServer({ logger: h.logger, debitWithdrawal: use, auth: extra.auth ?? h.serviceAuth, ...(extra.now ? { now: extra.now } : {}) });
      const port = await own.start("127.0.0.1", 0);
      const ownClient = new DebitClient(`127.0.0.1:${port}`);
      return { server: own, client: ownClient, port, stop: async () => { ownClient.close(); await own.close(300); } };
    }

    it("answers UNAVAILABLE with retry-after for a transient failure, and INTERNAL without the cause for any other", async () => {
      const calls: string[] = [];
      const own = await serve(
        fake((input) => {
          calls.push(input.withdrawalId);
          return input.withdrawalId === W_FAKE ? Promise.reject(new ConcurrentUpdate()) : Promise.reject(new Error("the table ledger_events exploded"));
        }),
      );
      try {
        const token = await h.signService("payments");
        const transient = await own.client.debit(request(W_FAKE, 10), { token });
        expect(transient.code).toBe(grpc.status.UNAVAILABLE);
        expect(transient.trailer("chance-problem-code")).toBe("concurrent_update");
        expect(transient.trailer("retry-after")).toBe("1");

        const broken = await own.client.debit(request(W_CASE, 10), { token });
        expect(broken.code).toBe(grpc.status.INTERNAL);
        expect(broken.trailer("chance-problem-code")).toBe("internal_error");
        expect(broken.trailer("retry-after")).toBeUndefined();
        expect(broken.details).not.toContain("exploded");
        // The cause is in the log, for whoever runs the service.
        expect(h.logLines.join("")).toContain("the table ledger_events exploded");
        expect(calls).toEqual([W_FAKE, W_CASE]);
      } finally {
        await own.stop();
      }
    });

    it("passes the caller, the correlation id and the fields to the use case, with no Idempotency-Key header to compare", async () => {
      const seen: DebitInput[] = [];
      const own = await serve(
        fake((input) => {
          seen.push(input);
          return Promise.resolve({ kind: "debited", withdrawalId: input.withdrawalId });
        }),
      );
      try {
        const token = await h.signService("payments");
        const sent = await own.client.debit(request(W_CORR, 7), { token, metadata: { "x-correlation-id": ["corr-42"] } });
        expect(sent.code).toBe(grpc.status.OK);
        expect(sent.trailer("x-correlation-id")).toBe("corr-42");
        // A value that is not a plain id is replaced by a new one, never copied into a log line.
        const odd = await own.client.debit(request(W_CORR, 7), { token, metadata: { "x-correlation-id": ["not an id !"] } });
        expect(odd.trailer("x-correlation-id")).not.toContain("not an id");
        expect(odd.trailer("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);

        expect(seen[0]).toMatchObject({
          caller: { client: "payments", correlationId: "corr-42" },
          idempotencyKey: undefined,
          withdrawalId: W_CORR,
          tenantId: TENANT_A,
          userId: TRADER,
          amount: 7,
        });
        expect(seen[0]?.caller.causationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(seen[1]?.caller.correlationId).not.toBe("corr-42");
      } finally {
        await own.stop();
      }
    });
  });

  describe("deadlines", () => {
    it("ends the call with DEADLINE_EXCEEDED when the deadline passes during the debit; the debit still finishes and a repeat returns it", async () => {
      const slow = gate();
      const calls: string[] = [];
      const real = h.core.useCases.debitWithdrawal;
      const own = new DebitsGrpcServer({
        logger: h.logger,
        auth: h.serviceAuth,
        debitWithdrawal: {
          execute: async (input) => {
            calls.push(input.withdrawalId);
            await slow.opened;
            return real.execute(input);
          },
        },
      });
      const ownClient = new DebitClient(`127.0.0.1:${await own.start("127.0.0.1", 0)}`);
      try {
        const before = await balance();
        const token = await h.signService("payments");
        const timedOut = await ownClient.debit(request(W_LATE, 3), { token, deadlineMs: 150 });
        expect(timedOut.code).toBe(grpc.status.DEADLINE_EXCEEDED);
        expect(calls).toEqual([W_LATE]);

        // The client and the server share this process's event loop: give the server the time to read the client's
        // cancellation before the debit finishes (in production the debit takes longer than a network hop).
        await sleep(200);
        slow.open();
        await waitFor(() => h.logLines.some((line) => line.includes("The debit finished after the call had ended") && line.includes(W_LATE)), "the late finish to be logged");
        // Committed although nobody read the answer; the repeat of payments returns the stored result and debits nothing more.
        expect(await balance()).toBe(before - 3 * CREDIT);
        const repeat = await ownClient.debit(request(W_LATE, 3), { token });
        expect(repeat.code).toBe(grpc.status.OK);
        expect(repeat.reply).toEqual({ withdrawal_id: W_LATE, status: "DEBIT_STATUS_DEBITED", amount: 3 });
        expect(await balance()).toBe(before - 3 * CREDIT);
      } finally {
        slow.open();
        ownClient.close();
        await own.close(300);
      }
    });

    it("starts no work for a call whose deadline had passed when it reached the handler", async () => {
      const calls: string[] = [];
      const own = new DebitsGrpcServer({
        logger: h.logger,
        auth: h.serviceAuth,
        // The server's clock is a minute ahead of the client's: the deadline of the call has passed on arrival.
        now: () => Date.now() + 60_000,
        debitWithdrawal: {
          execute: (input) => {
            calls.push(input.withdrawalId);
            return Promise.resolve({ kind: "debited", withdrawalId: input.withdrawalId });
          },
        },
      });
      const ownClient = new DebitClient(`127.0.0.1:${await own.start("127.0.0.1", 0)}`);
      try {
        const answer = await ownClient.debit(request(W_NEVER, 3), { token: await h.signService("payments"), deadlineMs: 20_000 });
        expect(answer.code).toBe(grpc.status.DEADLINE_EXCEEDED);
        expect(answer.trailer("chance-problem-code")).toBe("deadline_exceeded");
        expect(calls).toEqual([]);
      } finally {
        ownClient.close();
        await own.close(300);
      }
    });

    it("starts no work for a call that the client cancelled before the handler got to the debit", async () => {
      const keysWaiting = gate();
      const calls: string[] = [];
      const own = new DebitsGrpcServer({
        logger: h.logger,
        // Verifying the token waits for the key set, which is how a slow identity provider holds a call back.
        auth: { ...h.serviceAuth, jwks: async (header, token) => { await keysWaiting.opened; return h.serviceAuth.jwks(header, token); } },
        debitWithdrawal: {
          execute: (input) => {
            calls.push(input.withdrawalId);
            return Promise.resolve({ kind: "debited", withdrawalId: input.withdrawalId });
          },
        },
      });
      const ownClient = new DebitClient(`127.0.0.1:${await own.start("127.0.0.1", 0)}`);
      try {
        const started = ownClient.start(request(W_CANCEL, 3), await h.signService("payments"));
        await sleep(150);
        started.call.cancel();
        expect(await started.outcome).toBe(grpc.status.CANCELLED);
        await sleep(150);
        keysWaiting.open();
        await waitFor(() => h.logLines.some((line) => line.includes("The debit call was refused") && line.includes('"reason":"cancelled"')), "the cancelled call to be logged");
        expect(calls).toEqual([]);
      } finally {
        keysWaiting.open();
        ownClient.close();
        await own.close(300);
      }
    });
  });

  describe("one use case, two transports", () => {
    const rest = (withdrawalId: string, amount: number) =>
      callInternal(h, "POST", DEBITS_URL, { client: "payments", body: { withdrawalId, tenantId: TENANT_A, userId: TRADER, amount } });

    it("answers a REST debit's repeat over gRPC with the stored result, and the other way round; the credits are debited once", async () => {
      const before = await balance();
      const viaRest = await rest(W_SHARED_REST, 10);
      expect(viaRest.status).toBe(200);
      const repeatedOverGrpc = await debit(request(W_SHARED_REST, 10));
      expect(repeatedOverGrpc.code).toBe(grpc.status.OK);
      expect(repeatedOverGrpc.reply).toEqual({ withdrawal_id: W_SHARED_REST, status: "DEBIT_STATUS_DEBITED", amount: 10 });
      expect(await balance()).toBe(before - 10 * CREDIT);

      const viaGrpc = await debit(request(W_SHARED_GRPC, 10));
      expect(viaGrpc.code).toBe(grpc.status.OK);
      const repeatedOverRest = await rest(W_SHARED_GRPC, 10);
      expect(repeatedOverRest.status).toBe(200);
      expect(repeatedOverRest.body).toEqual({ withdrawalId: W_SHARED_GRPC, status: "debited" });
      expect(await balance()).toBe(before - 20 * CREDIT);
    });

    it("keeps a refusal definitive across the transports: 409 and FAILED_PRECONDITION answer each other's repeat", async () => {
      const before = await balance();
      expect((await rest(W_REFUSED_REST, 900_000)).status).toBe(409);
      const overGrpc = await debit(request(W_REFUSED_REST, 900_000));
      expect(overGrpc.code).toBe(grpc.status.FAILED_PRECONDITION);
      expect(overGrpc.trailer("chance-problem-code")).toBe("insufficient_credits");

      expect((await debit(request(W_REFUSED_GRPC, 900_000))).code).toBe(grpc.status.FAILED_PRECONDITION);
      const overRest = await rest(W_REFUSED_GRPC, 900_000);
      expect(overRest.status).toBe(409);
      expect(overRest.body).toMatchObject({ code: "insufficient_credits" });
      expect(await balance()).toBe(before);
    });

    it("refuses another body for an id the other transport used: 422 and ALREADY_EXISTS", async () => {
      // Its own ids, debited here: the test does not lean on what an earlier test debited, so it passes alone, with
      // `.only` and in any order.
      const debitedOverRest = WITHDRAWAL(44);
      const debitedOverGrpc = WITHDRAWAL(45);
      expect((await rest(debitedOverRest, 10)).status).toBe(200);
      expect((await debit(request(debitedOverGrpc, 10))).code).toBe(grpc.status.OK);
      const before = await balance();

      const overGrpc = await debit(request(debitedOverRest, 11));
      expect(overGrpc.code).toBe(grpc.status.ALREADY_EXISTS);
      const overRest = await rest(debitedOverGrpc, 11);
      expect(overRest.status).toBe(422);
      expect(overRest.body).toMatchObject({ code: "idempotency_key_reused" });
      // Another tenant's attempt with the id of a debit made over REST: the same refusal, the credits stay.
      expect((await debit(request(debitedOverRest, 10, { tenant_id: TENANT_B }))).code).toBe(grpc.status.ALREADY_EXISTS);
      expect(await balance()).toBe(before);
    });

    it("debits once when the same withdrawal arrives over both transports at the same time", async () => {
      const before = await balance();
      const id = WITHDRAWAL(40);
      const answers = await Promise.all([rest(id, 5), debit(request(id, 5)), rest(id, 5), debit(request(id, 5))]);
      expect(answers[0].status).toBe(200);
      expect(answers[2].status).toBe(200);
      expect(answers[1].code).toBe(grpc.status.OK);
      expect(answers[3].code).toBe(grpc.status.OK);
      expect(await balance()).toBe(before - 5 * CREDIT);
    });
  });

  describe("start and close", () => {
    const okUse = (calls: string[], wait?: Promise<void>): DebitWithdrawalUseCase => ({
      execute: async (input) => {
        calls.push(input.withdrawalId);
        if (wait) await wait;
        return { kind: "debited", withdrawalId: input.withdrawalId };
      },
    });

    it("refuses to start on a port that is taken, so a Pod without its gRPC port never starts", async () => {
      const port = Number(address.split(":")[1]);
      const second = new DebitsGrpcServer({ logger: h.logger, debitWithdrawal: okUse([]), auth: h.serviceAuth });
      await expect(second.start("127.0.0.1", port)).rejects.toThrow();
      await second.close(100);
    });

    it("finishes the calls in flight on a graceful close, then refuses new connections", async () => {
      const release = gate();
      const calls: string[] = [];
      const own = new DebitsGrpcServer({ logger: h.logger, debitWithdrawal: okUse(calls, release.opened), auth: h.serviceAuth });
      const port = await own.start("127.0.0.1", 0);
      const ownClient = new DebitClient(`127.0.0.1:${port}`);
      const token = await h.signService("payments");
      const inFlight = ownClient.debit(request(WITHDRAWAL(41), 1), { token });
      await waitFor(() => calls.length === 1, "the call to reach the use case");

      let closed = false;
      const closing = own.close(5000).then(() => {
        closed = true;
      });
      await sleep(150);
      expect(closed).toBe(false);
      release.open();
      const answer = await inFlight;
      await closing;
      expect(answer.code).toBe(grpc.status.OK);
      expect(answer.reply?.withdrawal_id).toBe(WITHDRAWAL(41));
      // The channel that was open when the close began (payments' own, in a rollout), and a new one.
      const onOpenChannel = await ownClient.debit(request(WITHDRAWAL(42), 1), { token, deadlineMs: 1000 });
      ownClient.close();
      const late = new DebitClient(`127.0.0.1:${port}`);
      const onNewChannel = await late.debit(request(WITHDRAWAL(42), 1), { token, deadlineMs: 1000 });
      late.close();
      for (const [which, refused] of [["open channel", onOpenChannel], ["new channel", onNewChannel]] as const) {
        expect(refused.code, which).toBe(grpc.status.UNAVAILABLE);
        // The library's own UNAVAILABLE, not trading's answer: the contract tells a client not to expect any of these.
        for (const key of ["chance-problem-code", "retry-after", "x-correlation-id"]) expect(refused.trailer(key), `${which}: trailing metadata ${key}`).toBeUndefined();
      }
      // A second close changes nothing.
      await own.close(100);
    });

    it("cuts the connections after the grace period when a call does not finish", async () => {
      const never = gate();
      const calls: string[] = [];
      const own = new DebitsGrpcServer({ logger: h.logger, debitWithdrawal: okUse(calls, never.opened), auth: h.serviceAuth });
      const ownClient = new DebitClient(`127.0.0.1:${await own.start("127.0.0.1", 0)}`);
      try {
        const stuck = ownClient.debit(request(WITHDRAWAL(43), 1), { token: await h.signService("payments") });
        await waitFor(() => calls.length === 1, "the call to reach the use case");
        const started = Date.now();
        await own.close(200);
        expect(Date.now() - started).toBeLessThan(2000);
        expect((await stuck).code).not.toBe(grpc.status.OK);
        expect(h.logLines.join("")).toContain("did not finish in time");
      } finally {
        never.open();
        ownClient.close();
      }
    });
  });

  describe("the proto file", () => {
    it("is the one the service is built from, and a file without the service is refused", () => {
      expect(Object.keys(loadDebitsService())).toEqual(["DebitCredits"]);
      const dir = mkdtempSync(join(tmpdir(), "trading-proto-"));
      try {
        const other = join(dir, "other.proto");
        writeFileSync(other, 'syntax = "proto3";\npackage other.v1;\nservice Other { }\n');
        expect(() => loadDebitsService(other)).toThrow(/does not define the service chance\.trading\.v1\.Debits/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
