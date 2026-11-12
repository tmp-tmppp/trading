# Contracts of the trading service

The contracts are written first and the code follows them. Tests fail when the two differ.

| File | What it says |
|---|---|
| `openapi.yaml` | OpenAPI 3.1 of the public port (gateway prefix `/v1/trading`): quote, orders with `Idempotency-Key`, sale quote and sales with `Idempotency-Key` (UC-08), portfolio, health probes |
| `internal.openapi.yaml` | OpenAPI 3.1 of the internal port (8081, never routed by the gateway): market funding (markets), debits (payments), the market maker's book and offers |
| `trading-debit.proto` | Protocol Buffers 3 (package `chance.trading.v1`, service `Debits`): the debit of a withdrawal over gRPC (port 8082), the same use case as `POST /v1/internal/debits`; the server loads this file |
| `asyncapi.yaml` | AsyncAPI 3.0: the four events trading publishes on the stream `TRADING` and the six it consumes |
| `external/` | Byte-for-byte copies of what the other services expect of trading (see below); the contract tests compare against them |

## Copies of the other services' contracts

trading is built on its own (its pipeline checks out this repository only), so the contract tests read these copies and
fail when a funding or debit answer, or the `WithdrawalRefunded` event, stops matching them. They are plain copies, no
header was added, so that `cmp` can compare them with their source.

| Copy | Source (in the workspace, relative to this repository) | SHA-256 at the time of copying (2026-11-11) |
|---|---|---|
| `external/markets-trading-market-funding.openapi.yaml` | `../markets/contracts/outgoing/trading-market-funding.openapi.yaml` | `6adbe72d78a973ba18b6b614b6bf9c28e65747797af57ccfc41d63bed64958c3` |
| `external/payments-trading-debit.openapi.yaml` | `../payments/contracts/trading-debit.openapi.yaml` | `07ef5e5c5658a431df7bc3f5233ec094c4e90f4bb8700264cd8a23c37d04e08d` |
| `external/payments-asyncapi.yaml` | `../payments/contracts/asyncapi.yaml` | `128f0e4112930cc3c103f5ef822d77a8ced738a32360721c50a355daeac631c3` |

When the owner of a source changes it, copy the file again, update its hash here, and run `npm test`; a failing contract
test then names what trading has to change. With the repositories side by side, `cmp <copy> <source>` shows whether a
copy is stale. The sources have no commit to name yet (their repositories have none, or hold the file untracked).

## Units

- **`amount` is whole credits**, exactly as payments and markets carry it (1 credit = 1 EUR cent; 1 to 1 000 000):
  deposits, withdrawals, funding, the amount of an order, `MarketFunded` and `WithdrawalRefunded`.
- **Every other quantity is an exact integer in micro-units**, and its field name ends in `Micro`:
  microcredits (1 credit = 1 000 000), microshares (1 share = 1 000 000; a winning share pays 1 credit) and prices
  in microcredits per share on the 0.01 grid (`10000` = 0.01 ... `990000` = 0.99). All of them fit in a JSON safe
  integer. Divide by 1 000 000 to show credits, shares or a price.
- A buy spends exactly its `amount`. A conversion that cannot be exact rounds in favour of the market's bot account
  (whose holdings return to the market's creator), never in favour of the person asking, by less than one microunit
  per fill. Withdrawals take whole credits; `withdrawableCredits` of the portfolio says how many.

## For the authors of consuming services

- **Where.** NATS JetStream, stream `TRADING` (subjects `chance.trading.>`, 30 days by default (`STREAM_MAX_AGE_DAYS`), duplicate window 2 minutes). One
  subject per event and tenant: `chance.trading.<Event>.<tenantId>`.
- **Format.** CloudEvents 1.0 in structured JSON mode with the extensions `tenantid`, `correlationid`, `causationid`;
  type `si.chance.trading.<Event>.v1`, source `/chance/trading`, subject `market/<marketId>` or
  `withdrawal/<withdrawalId>`.
- **Delivery is at least once.** Deduplicate by the event `id` (UUIDv7, also the NATS header `Nats-Msg-Id`) in the
  same transaction as your change.
- **Order.** The outbox relay publishes in the order of writing, so the events of one market keep their order.
  `TradeExecuted.tradeSequence` counts the trades of a market (1, 2, ...); a reader that needs the order of prices uses it.
- **Ignore unknown fields.** New fields are added as optional ones; a breaking change gets a new type version.
- **No personal data.** Ids and numbers only.

| Event | Who acts on it | What it carries |
|---|---|---|
| `TradeExecuted` | market-data (price point, volume), market-maker (a notification only: re-read the book, EP-1), audit | `tradeId`, `marketId`, `userId`, `side`, `sharesMicro`, `costMicro`, `averagePriceMicro`, `lastPriceMicro`, `yesPriceMicro`, `tradeSequence`, `executedAt`, optional `kind` (`buy` or `sale`, UC-08; a sale is described as the buy of the other side it makes, so price and volume read it as that buy) |
| `MarketFunded` | audit | `marketId`, `creatorId`, `amount`, `fundedAt` |
| `MarketSettled` | audit | `marketId`, `outcome` (`YES`, `NO` or `INVALID`), `creatorId`, `payoutTotalMicro`, `payoutCount`, `returnedToCreatorMicro`, `settledAt`; for `INVALID` the payout fields are the traders' refunds and `returnedToCreatorMicro` the rest of the market |
| `WithdrawalRefunded` | payments (marks the withdrawal `refunded`), audit | `withdrawalId`, `userId`, `amount`, `refundedAt` (payments' proposal, unchanged plus `refundedAt`) |

## For the callers of the internal port

- Port 8081 of the Kubernetes service `trading` (`http://trading:8081`); the NetworkPolicy admits only the pods of
  markets, payments and market-maker. A client-credentials token of the identity provider with audience `chance`; the
  client id (`azp`) must be the endpoint's caller: `markets` for `/v1/internal/market-funding`, `payments` for
  `/v1/internal/debits`, `market-maker` for `/v1/internal/markets...`.
- **markets.** As markets' `contracts/outgoing/trading-market-funding.openapi.yaml` expects: `201` funded, `200` a
  repeat, `409 insufficient_credits` (not stored, decided anew later), `409 market_closed`, `422
  idempotency_key_reused`. A concurrent repeat waits for the first call; `idempotency_in_progress` is never sent. A
  tenant trading has not seen yet is provisioned on this call, so `503 tenant_not_ready` (allowed by markets' contract)
  is not sent.
- **payments.** As payments' `contracts/trading-debit.openapi.yaml` proposes: `200 {withdrawalId, status: "debited"}` or
  `409 insufficient_credits`, both definitive and stored under `withdrawalId`; everything else that is not definitive
  is `503`. The refund is not a call: trading consumes `WithdrawalFailed` and publishes `WithdrawalRefunded`. The same
  debit is also offered over gRPC (REQ-17, ADR-023): see the next section; the two transports share one idempotency
  store, so a client may use either, and may even repeat over the one what it started over the other.

## For the callers of the gRPC debit (payments)

`trading-debit.proto` is the contract; the server loads that file (`src/web/grpc/`), and the contract tests compare it
with the REST `DebitRequest` above. It is written for payments' client, which only has to load the file.

- **Where.** `trading:8082` (the Service port `grpc`, `GRPC_PORT`), plain HTTP/2 without TLS, like the internal REST
  port. The NetworkPolicy admits only the pods of payments to it (`networkPolicy.grpc.allowedApps`). Package
  `chance.trading.v1`, service `Debits`, call `DebitCredits(DebitRequest) returns (DebitReply)`.
- **Load the proto** with `@grpc/proto-loader` (`keepCase: true` keeps the field names as the proto writes them,
  `withdrawal_id`; without it they arrive as `withdrawalId`; `enums: String` gives the status as the name
  `DEBIT_STATUS_DEBITED`, `defaults: true` fills absent fields) and `grpc.loadPackageDefinition(...)`; the client class is
  `chance.trading.v1.Debits`. The Dockerfile of payments needs `trading-debit.proto` beside its code (copy it from here,
  the way the other contract copies are kept, with its hash).
- **Metadata.** `authorization: Bearer <token>`, the client-credentials token of the client `payments` (audience `chance`,
  the same token as for REST: payments may reuse its cached token). Optional `x-correlation-id` (same rule as the REST
  header; trading answers with it in the trailing metadata). There is no `idempotency-key`: `withdrawal_id` is the key.
- **Deadline.** Set one on every call (suggested 3 seconds, as for the REST client's timeout). trading honours it: it
  starts no work for a call that is already past it or cancelled, and ends the call with `DEADLINE_EXCEEDED` when it
  passes. A debit that had begun is finished and committed anyway, so after `DEADLINE_EXCEEDED`, or any other status
  that is not definitive, repeat the call with the same `withdrawal_id`: it returns the stored result and debits nothing
  twice.
- **Fields.** `withdrawal_id` (UUID), `tenant_id` (UUID), `user_id` (1 to 255 characters), `amount` (whole credits, 1 to
  1 000 000, an `int32`), the same as the REST body. An absent field reads as an empty text or 0 and is refused like an
  invalid one. Unknown fields are ignored (protobuf's rule), where the REST body answers 400.
- **Reply.** `DebitReply {withdrawal_id, status: DEBIT_STATUS_DEBITED, amount}`: the REST answer plus the debited amount
  (which a repeat must match exactly, so it is also the amount of the first call). The balance after the debit is
  returned by neither transport.
- **Statuses.** The answers that trading itself sends carry the trailing metadata `chance-problem-code` (the stable machine-readable
  code, the same as `code` in the REST problem) and `x-correlation-id`; the status message is for people. The statuses
  that the gRPC library makes carry none of `chance-problem-code`, `retry-after` and `x-correlation-id`: `UNAVAILABLE` without a
  connection or from a server that is shutting down (also on a connection that was open before the close began), a
  `DEADLINE_EXCEEDED` or `CANCELLED` made by the client's library, and `RESOURCE_EXHAUSTED`. Branch on `chance-problem-code` and read
  `retry-after` only when they are present; with an `UNAVAILABLE` that has neither, repeat with a backoff of your own and
  the same `withdrawal_id`. In the table, "definitive" means that payments settles the withdrawal and does not repeat the
  call.

| gRPC status | `chance-problem-code` | REST | Definitive | Meaning and what payments does |
|---|---|---|---|---|
| `OK` | | 200 | yes | Debited now, or by an earlier call with the same `withdrawal_id` (also one made over REST) |
| `FAILED_PRECONDITION` | `insufficient_credits` | 409 | yes | The user's credits are too few; stored under `withdrawal_id`, so a repeat answers the same, also after a deposit |
| `ALREADY_EXISTS` | `idempotency_key_reused` | 422 | no | The `withdrawal_id` was debited or refused before for another user, tenant or amount; never a second debit; needs a person to look at it |
| `INVALID_ARGUMENT` | `validation_failed` | 400 | no | A field is missing or out of bounds; the message names it in the proto's field names; a bug on the caller's side |
| `UNAUTHENTICATED` | `unauthorized` | 401 | no | No, malformed, expired or untrusted token; fetch a new token and repeat once |
| `PERMISSION_DENIED` | `forbidden` | 403 | no | A valid token of another client than `payments`, or a user's token; a configuration mistake |
| `UNAVAILABLE` | `concurrent_update`, `identity_provider_unavailable` | 503 | no | Not definitive: repeat the same call. With a `chance-problem-code`, trading sent it: repeat after the trailing metadata `retry-after` seconds. Without `chance-problem-code`, `retry-after` and `x-correlation-id` it comes from the library: no connection, the server is shutting down; repeat with a backoff of your own |
| `DEADLINE_EXCEEDED` | `deadline_exceeded` only when the call reached trading's handler already past its deadline | | no | The deadline passed; the debit may or may not have been made: repeat |
| `INTERNAL` | `internal_error` | 500 | no | A bug or a failure that is not transient; the message says nothing of the cause (it is in trading's log) |
| `RESOURCE_EXHAUSTED` | | | no | A message above 16 KiB, refused by the library; a debit is a few dozen bytes |

- **Health.** trading has no gRPC health service: the probes are the HTTP ones on port 8080. The gRPC port is bound at
  start (a Pod that cannot bind it exits), and the drain on SIGTERM turns readiness to 503 for both ports at once.
- **Load balancing.** A gRPC connection is long-lived, so a ClusterIP Service pins a client to one trading Pod; with
  `replicaCount` above 1 the calls of one payments Pod still all reach one Pod until the connection is renewed. That is
  correct (the debit is idempotent in the database, not in the Pod), only not balanced.
- **market-maker.** `GET /v1/internal/markets?status=open` (every tenant), `GET .../{marketId}/bot-book` and
  `PUT .../{marketId}/bot-orders {basedOnSequence, offers}` with `basedOnSequence` = the book's `tradeSequence` (not
  its `offersPricedOnSequence`): `409 stale_sequence` means a trade happened since; read the book again and retry
  (ADR-041). Offers are accepted on a `funded` or `open` copy (the first ones may arrive before trading has processed
  MarketOpened); `409 market_not_open` means stop quoting. The tenant comes from the market, never from the token. Offers per side may
  not exceed the bot account's holding plus its credits (each credit can become a pair); the cheapest YES plus the
  cheapest NO must cost at least 1 credit.
