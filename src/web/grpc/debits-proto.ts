import { fileURLToPath } from "node:url";
import type * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// The loading of contracts/trading-debit.proto, the one source of the gRPC debit's shape (contract first): the server
// builds its service from this file at start and nothing in the code restates the messages except the two interfaces
// below, which the contract test compares with the file.

/**
 * The proto file, found from the compiled module (dist/web/grpc) as from the source (src/web/grpc): the service's root is
 * three levels up in both. The Dockerfile copies the file to the same place in the image.
 */
export const DEBITS_PROTO_FILE = fileURLToPath(new URL("../../../contracts/trading-debit.proto", import.meta.url));

export const DEBITS_SERVICE_NAME = "chance.trading.v1.Debits";
export const DEBIT_CREDITS_PATH = "/chance.trading.v1.Debits/DebitCredits";

/**
 * How the file is read: field names as written in the proto (`withdrawal_id`), enums as their names, no 64-bit numbers
 * (the contract has none), absent fields as their defaults (an empty text, 0), which the use case then refuses.
 */
export const PROTO_LOADER_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

/** `DebitRequest` of the proto, as the server receives it. */
export interface DebitRequestMessage {
  withdrawal_id: string;
  tenant_id: string;
  user_id: string;
  amount: number;
}

/** `DebitReply` of the proto, as the server sends it (an enum is its name). */
export interface DebitReplyMessage {
  withdrawal_id: string;
  status: "DEBIT_STATUS_UNSPECIFIED" | "DEBIT_STATUS_DEBITED";
  amount: number;
}

/** The service `chance.trading.v1.Debits` of the proto file. Throws when the file does not define it. */
export function loadDebitsService(file: string = DEBITS_PROTO_FILE): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(file, PROTO_LOADER_OPTIONS);
  const service = definition[DEBITS_SERVICE_NAME];
  if (service === undefined || !("DebitCredits" in service)) {
    throw new Error(`${file} does not define the service ${DEBITS_SERVICE_NAME} with the call DebitCredits`);
  }
  return service;
}
