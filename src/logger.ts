import { pino } from "pino";
import type { DestinationStream, Logger } from "pino";

/**
 * JSON logs (ADR-026). The Authorization header and cookies are redacted wherever they could appear in a log line, and
 * so are the client secret and the access token of the funding call; request ids, correlation ids, tenant ids, market
 * ids and user ids are bound by the web layer and the use cases. The level can change at runtime (ADR-037).
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "trading" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "headers.authorization",
          "authorization",
          "*.authorization",
          "clientSecret",
          "*.clientSecret",
          "accessToken",
          "*.accessToken",
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
