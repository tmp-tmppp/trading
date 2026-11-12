import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// A client of the gRPC debit the way payments will write it: it loads contracts/trading-debit.proto by itself (nothing of
// src/ is used), with the options the contract documents, and talks to a real server over a real HTTP/2 connection.

export const PROTO_FILE = fileURLToPath(new URL("../../contracts/trading-debit.proto", import.meta.url));

export interface DebitRequestBody {
  withdrawal_id: string;
  tenant_id: string;
  user_id: string;
  amount: number;
}

export interface DebitReplyBody {
  withdrawal_id: string;
  status: string;
  amount: number;
}

/** What a call ended with: the status, its text, the reply (null for an error) and the trailing metadata. */
export interface Outcome {
  code: grpc.status;
  details: string;
  reply: DebitReplyBody | null;
  trailers: grpc.Metadata;
  /** The trailing metadata key as text, or undefined. */
  trailer(key: string): string | undefined;
}

export interface DebitOptions {
  /** The bearer token; null sends no authorization metadata. */
  token?: string | null;
  /** More metadata, key to values (a second `authorization`, `x-correlation-id`). */
  metadata?: Record<string, string[]>;
  /** The call's deadline in milliseconds from now; default 5000. */
  deadlineMs?: number;
}

const definition = protoLoader.loadSync(PROTO_FILE, { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
const DebitsClient = (grpc.loadPackageDefinition(definition) as any).chance.trading.v1.Debits as grpc.ServiceClientConstructor;

export class DebitClient {
  private readonly client: any;

  constructor(address: string) {
    this.client = new DebitsClient(address, grpc.credentials.createInsecure());
  }

  /** One DebitCredits call; resolves with the outcome, never rejects (an error status is an outcome). */
  debit(request: DebitRequestBody, options: DebitOptions = {}): Promise<Outcome> {
    return new Promise((resolve) => {
      const metadata = new grpc.Metadata();
      if (options.token !== null && options.token !== undefined) metadata.add("authorization", `Bearer ${options.token}`);
      for (const [key, values] of Object.entries(options.metadata ?? {})) for (const value of values) metadata.add(key, value);
      let reply: DebitReplyBody | null = null;
      const call = this.client.DebitCredits(request, metadata, { deadline: Date.now() + (options.deadlineMs ?? 5000) }, (_error: unknown, response: DebitReplyBody | undefined) => {
        reply = response ?? null;
      });
      // The status event comes after the callback, with the trailing metadata of success and failure alike.
      call.on("status", (status: grpc.StatusObject) =>
        resolve({
          code: status.code,
          details: status.details,
          reply,
          trailers: status.metadata,
          trailer: (key: string) => {
            const [value] = status.metadata.get(key);
            return typeof value === "string" ? value : undefined;
          },
        }),
      );
    });
  }

  /** Starts a call and hands back its handle without waiting (for a test that cancels it). */
  start(request: DebitRequestBody, token: string, deadlineMs = 5000): { call: grpc.ClientUnaryCall; outcome: Promise<number> } {
    const metadata = new grpc.Metadata();
    metadata.add("authorization", `Bearer ${token}`);
    let call!: grpc.ClientUnaryCall;
    const outcome = new Promise<number>((resolve) => {
      call = this.client.DebitCredits(request, metadata, { deadline: Date.now() + deadlineMs }, () => undefined);
      call.on("status", (status: grpc.StatusObject) => resolve(status.code));
    });
    return { call, outcome };
  }

  close(): void {
    (this.client as grpc.Client).close();
  }
}
