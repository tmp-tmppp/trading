# trading

The credits, positions and trades of **Chance**. Inside one tenant (an organization), a trader buys YES or NO shares of
an open market with credits, against the offers that the market's bot account (run by the market maker) rests in the
order book, and sells them back before the market closes (UC-08). This service keeps every user's credit balance and share positions on an **event-sourced ledger**: it
credits deposits, debits withdrawals (and refunds the ones that fail), funds a new market from its creator's credits,
executes orders and sales and, when a market is resolved, pays the winners out. Every account, market and trade belongs to exactly
one tenant, and a user's tenant always comes from the token.

Trading calls no other service. The services around it call **it**: the gateway (public API), markets (funding),
payments (debits) and the market maker (the bot's book); it also consumes events (see "Events").

## Units

- **`amount` is whole credits**, exactly as payments and markets carry it (1 credit = 1 EUR cent, 1 to 1 000 000):
  deposits, withdrawals, funding, the amount of an order, `MarketFunded` and `WithdrawalRefunded`.
- **Every other quantity is an exact integer in micro-units**, and its JSON field ends in `Micro`: microcredits
  (1 credit = 1 000 000), microshares (1 share = 1 000 000; a winning share pays exactly 1 credit) and prices in
  microcredits per share, `10000` (0.01) to `990000` (0.99) in steps of `10000`. All of them fit in a JSON safe integer;
  divide by 1 000 000 to show credits, shares or a price. Money and shares inside the service are exact integers, never
  floating point (proposed ADR-055).
- A buy **spends exactly its `amount`**. A conversion that cannot be exact rounds in favour of the market's bot account
  (whose holdings return to the market's creator), never in favour of the person asking, by less than one microunit per
  fill. Withdrawals take whole credits; `withdrawableCredits` in the portfolio says how many.

## API

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml) (public) and
[`contracts/internal.openapi.yaml`](contracts/internal.openapi.yaml) (internal), OpenAPI 3.1, and
[`contracts/trading-debit.proto`](contracts/trading-debit.proto) (the debit over gRPC); the code follows them and
the contract tests fail when they differ. Every endpoint except the health probes needs a bearer token from the
identity provider; errors are RFC 9457 problem details (`application/problem+json`) with a stable `code`; every API
answer carries `X-Correlation-Id`, and `/v1/` answers carry `Cache-Control: private, no-store`.

### Public API, port 8080 (`PORT`), gateway prefix `/v1/trading`

| Method and path | Who | What |
|---|---|---|
| `GET /v1/trading/quote?marketId=&side=&amount=` | trader, tenant admin | What `amount` credits would buy now: the shares, the cost, the average and worst price, the fills and the `tradeSequence` the quote was computed on. `409 market_not_open`, `409 insufficient_liquidity` (with the largest whole `maxAmount` the offers can absorb) |
| `POST /v1/trading/orders` | trader | Buy `side` (YES or NO) of `marketId` for exactly `amount` credits: a fill-or-kill market order at the cheapest offers. `Idempotency-Key` header required (8 to 128 visible ASCII characters). `201` executed, `200` a repeat of the same key (`replayed`) |
| `GET /v1/trading/sale-quote?marketId=&side=&sharesMicro=` | trader, tenant admin | UC-08: what a sale of `sharesMicro` of `side` would return now: the shares of the other side bought from the cheapest offers, their cost, the proceeds (`sharesMicro - costMicro`), the price per share sold and the `tradeSequence`. `409 market_not_open`, `409 insufficient_liquidity` (with `maxSharesMicro`, the most the other side's offers hold). The buy quote above is unchanged |
| `POST /v1/trading/sales` | trader | UC-08: sell `sharesMicro` of `side` held in `marketId`: buys as many shares of the other side from the bot's offers (fill or kill, cheapest first) and redeems the pairs for 1 credit each, in one transaction. Body `{marketId, side, sharesMicro, minProceedsMicro?}`; `Idempotency-Key` required and bound to the body (orders and sales share the caller's keys). `201` executed, `200` a repeat. `409 insufficient_shares` (with `heldMicro`), `insufficient_liquidity` (`maxSharesMicro`), `proceeds_below_minimum` (below `minProceedsMicro`, or nothing at all; with a fresh sale quote), `market_not_open`; `503 orders_paused` while `ORDERS_ENABLED` is off. The answer carries the new balance and position (DM-17) |
| `GET /v1/trading/portfolio?limit=` | trader, tenant admin | The caller's credits, positions, recent trades (buys and sales, `kind`) and payouts; a tenant admin also sees the markets they funded |
| `GET /health/startup`, `/health/ready`, `/health/live` | Kubernetes | Probes (public port only); readiness checks the database and answers `503` as soon as the process gets SIGTERM, liveness only the process |

The user token follows token contract v2 (a user may belong to several organizations, the tenants):

- **Tenant.** The claim `organization` holds exactly one organization alias, the tenant id (a UUID): the web signs in
  with the scope `organization:<alias>`. A token that names several organizations is `401 invalid_token`; one that names
  none, or an alias that is not a UUID, is `403`.
- **Role.** The tenant role is the caller's group in that organization, `organization.<alias>.groups`: exactly one
  entry, `/tenant-admin` or `/trader`. No group, both groups, a second or an unknown group, and an organization claim
  that is not an object with a `groups` list are `403` (fail closed). The realm roles `trader` and `tenant-admin` are
  no longer read: a token that carries only those is `403`.
- **Platform admin.** `platform-admin` stays a realm role (`realm_access.roles`); a platform admin gets `403` on every
  trading endpoint, also with an organization in the token.

A token without a valid tenant and role gets `403` on every trading endpoint; **orders need the group `/trader`** (a
tenant admin gets `403`). The service tokens of the internal port (client credentials) are unchanged.

An order's body is `{marketId, side, amount, maxAveragePriceMicro?}`; unknown fields are `400`. With
`maxAveragePriceMicro` the order is refused with `409 price_limit_exceeded` (carrying a fresh `quote`) when its average
price would be higher (DM-18). Status codes worth knowing:

- `401` means the token is wrong (expired, bad signature, wrong issuer or audience, unknown key id, malformed).
- `409` for an order: `market_not_open` (not open, not funded, or past its close time), `insufficient_credits`,
  `insufficient_liquidity`, `price_limit_exceeded`. A refused order is **not stored** under its key, so the key can be
  used again once the cause is gone.
- `422 idempotency_key_reused`: the same key with another body. The key's scope is the user.
- `503` with `Retry-After` means the request cannot be served right now and may simply be repeated: the signing keys
  cannot be fetched (`identity_provider_unavailable`), the caller's tenant is still being set up here
  (`tenant_not_ready`), a lost race on the ledger (`concurrent_update`, after three tries) or orders are paused
  (`orders_paused`, runtime key `ORDERS_ENABLED`).
- An amount above `ORDER_AMOUNT_MAX` is `400`. A retry of an order that already executed answers `200` with the stored
  result even after the maximum was lowered or orders were paused (REL-03).

### Internal API, port 8081 (`INTERNAL_PORT`, `8091` in a local run), never routed by the gateway

The NetworkPolicy admits only markets, payments and market-maker to this port. A call needs a client-credentials token
of the same identity provider (same keys, `exp` required) with the audience `INTERNAL_AUTH_AUDIENCE`; the claim
`INTERNAL_CLIENT_CLAIM` (Keycloak: `azp`) names the calling service, and **each endpoint admits exactly one client**:
any other client, and any user token, gets `403`. The tenant comes from the body (funding, debits) or from the market
(the bot's book), never from the token.

| Method and path | Client | What |
|---|---|---|
| `POST /v1/internal/market-funding` | `markets` | Fund a market from its creator's credits (`Idempotency-Key` = the market id). `201` funded, `200` a repeat, `409 insufficient_credits` (not stored: a later call after a top-up works) or `409 market_closed`, `422` the key reused for another tenant. An unknown tenant is provisioned on this call |
| `POST /v1/internal/debits` | `payments` | Take a withdrawal's credits: body `{withdrawalId, tenantId, userId, amount}`. `200 {withdrawalId, status: "debited"}` or `409 insufficient_credits`; both are definitive and stored under `withdrawalId`; anything else that is not definitive is `503`. The refund of a failed withdrawal is an event, not a call |
| `GET /v1/internal/markets?status=open&limit=&cursor=` | `market-maker` | The open markets of every tenant, by tenant and market id (cursor pagination, limit 100, at most 500) |
| `GET /v1/internal/markets/{marketId}/bot-book` | `market-maker` | The bot's holdings, its resting offers, `tradeSequence`, `offersPricedOnSequence` and `maxOffersPerSide` (the runtime `MAX_OFFERS_PER_SIDE` in force, so the bot never posts more levels than trading accepts) |
| `PUT /v1/internal/markets/{marketId}/bot-orders` | `market-maker` | Replace the bot's offers: `{basedOnSequence, offers}`. `409 stale_sequence` when a trade happened since (read the book again and retry), `409 market_not_open` (stop quoting), `409 insufficient_holdings`, `400` for an invalid book or `crossed_offers` |

`basedOnSequence` is the book's `tradeSequence` (the number of trades of the market); `offersPricedOnSequence` is
information only, because a fill keeps it. Offers are accepted on a market that is `funded` or `open`: the market maker
reacts to its own copy of `MarketOpened` and may be faster than this service, so its first offers wait until the market
opens here (plan section 7). The offers of one side must be backed: offered shares of a side are at most the bot's
holding of that side plus its credits (each credit can become a pair), and the cheapest YES offer plus the cheapest NO
offer must cost at least one credit.

With `APP_ENV=local` and no NATS there is one more route, `POST /v1/internal/local/events`, which takes one CloudEvent
(`TenantCreated`, the three market events, `DepositSucceeded`, `WithdrawalFailed`) and runs the same use case as the
consumer. It is not in the contract and is never deployed.

### gRPC debit, port 8082 (`GRPC_PORT`), for payments only

REQ-17 (ADR-023): the debit of a withdrawal is also offered over gRPC. The contract is
[`contracts/trading-debit.proto`](contracts/trading-debit.proto) (package `chance.trading.v1`, service `Debits`, call
`DebitCredits(DebitRequest) returns (DebitReply)`), written first; the server loads that file at start, and how payments
calls it (address, metadata, deadline, status codes) is in [`contracts/README.md`](contracts/README.md).

- **One use case, two transports.** The gRPC handler and `POST /v1/internal/debits` call the same `DebitWithdrawal` object,
  so there is one idempotency store keyed by `withdrawalId`: a debit made over REST answers a repeat over gRPC with the
  stored result, a refusal stays a refusal on both, and the same id with another body is refused on both. The credits are
  debited once. The tests prove it with a real gRPC client and the REST port against one store.
- **Authentication is the REST port's.** The bearer token in the metadata key `authorization` goes through the same
  `serviceVerifier` (signature, issuer, audience `INTERNAL_AUTH_AUDIENCE`, `exp` required, client id from the claim
  `INTERNAL_CLIENT_CLAIM`) and the same client check as the REST endpoints: only the client `payments` (`PAYMENTS_CLIENT_ID`)
  may call; any other client or a user's token gets `PERMISSION_DENIED`, no or a bad token `UNAUTHENTICATED`, and keys that
  cannot be fetched `UNAVAILABLE`. The order is the REST one: authentication, client, then the input. The tenant comes from
  `tenant_id`, never from the token. The transport is plain HTTP/2, like the internal port: the NetworkPolicy is its boundary.
- **Status mapping** (`src/web/grpc/failure.ts`, tested in `tests/web/grpc-failure.test.ts` and against a real server in
  `tests/web/grpc-debits.test.ts`; every error that trading's own code answers carries the trailing metadata `chance-problem-code` and
  `x-correlation-id`, the statuses made by the gRPC library carry none of them, see "Shutdown" below):

  | gRPC status | `chance-problem-code` | REST | When |
  |---|---|---|---|
  | `OK` | | 200 | Debited now, or by an earlier call with the same `withdrawal_id` |
  | `FAILED_PRECONDITION` | `insufficient_credits` | 409 | Too few credits; definitive, stored like REST's 409 |
  | `ALREADY_EXISTS` | `idempotency_key_reused` | 422 | The `withdrawal_id` was used before with another user, tenant or amount |
  | `INVALID_ARGUMENT` | `validation_failed` | 400 | A field is missing or out of bounds (the message names it by its proto name) |
  | `UNAUTHENTICATED` | `unauthorized` | 401 | No, malformed, expired or untrusted token |
  | `PERMISSION_DENIED` | `forbidden` | 403 | A valid token of another client, or a user's token |
  | `UNAVAILABLE` | `concurrent_update`, `identity_provider_unavailable` | 503 | Transient; trailing metadata `retry-after` in seconds |
  | `DEADLINE_EXCEEDED` | `deadline_exceeded` | | The deadline passed |
  | `INTERNAL` | `internal_error` | 500 | A bug; the message says nothing of the cause, the log has it |
  | `RESOURCE_EXHAUSTED` | | | A message above 16 KiB, refused by the library |

- **Deadlines.** The library ends a call with `DEADLINE_EXCEEDED` when the deadline from the client's `grpc-timeout` passes.
  The handler starts no work for a call that is already cancelled or past its deadline. A debit that has begun is finished
  and committed even when the client has given up (a transaction is never torn off half way, and the debit is idempotent:
  the repeat returns it); the handler logs that the debit finished after the call had ended.
- **Shutdown.** The gRPC server closes with the HTTP servers, in the existing shutdown order (step "Close", first): no new
  calls, the calls in flight finish and are answered, and after 5 seconds the connections are cut. A call that still
  arrives once the close has begun (also on a connection that was already open) gets `UNAVAILABLE` from the gRPC library,
  not from trading's code, so without `chance-problem-code`, `retry-after` and `x-correlation-id` (tested in
  `tests/web/grpc-debits.test.ts`); payments repeats it with a backoff of its own and the same `withdrawal_id`.
- **Health.** The gRPC server's state is **not** a separate part of readiness; the spec has no such line, so the decision is
  that the public port's `/health/ready` stands for it: the port is bound before the service reports started (a Pod that
  cannot bind `GRPC_PORT` exits, so a running Pod always has it), the drain on SIGTERM turns readiness to 503 for all
  three ports at once, and the server holds no dependency of its own (the database is what readiness already checks).
  There is no `grpc.health.v1` service (it would need one more package for a probe that Kubernetes does not use here).
- **Load balancing.** A gRPC connection is long-lived, so a ClusterIP Service keeps a client on one Pod; with
  `replicaCount` above 1 a payments Pod still talks to one trading Pod until the connection is renewed. The debit is
  idempotent in the database, so this is correct and only unbalanced.

## Metrics

Rate, errors and duration of the HTTP APIs (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), one listener per process, of its own: any other path
  there answers `404`, and none of the API ports (`PORT`, `INTERNAL_PORT`, `GRPC_PORT`) ever serves `/metrics`, so the
  gateway can never route it. The listener starts after the three API listeners and closes with them on shutdown. Services
  started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod has its own address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`, for the public application and the internal one on one
  registry. Errors are the `status_code` values 4xx and 5xx; the duration runs from the arrival of the request to the
  end of its response. The gRPC debit is not an HTTP request and is not counted here.
- **`route`** is the route template (`/v1/trading/orders`, `/v1/internal/markets/:marketId/bot-book`), or `unmatched` for a
  request that matched no route (a 404, or the 400 of a malformed URL that Fastify cannot route, counted by
  `recordFrameworkError` because that answer bypasses the hooks), so a raw URL or an id never becomes a label value.
- **`tenant`** is the tenant id in the token the service verified, `none` when the request has no verified token or the
  token names no tenant. It is never read from a header or the body. Every request of the internal API is `none`: its
  service tokens name no tenant (the tenant of a call is in its path or body, which is not a label).
- **`trading_trades_total{kind}`** counts executed trades: `buy` (`POST /v1/trading/orders`) and `sale`
  (`POST /v1/trading/sales`). A replay of a completed Idempotency-Key trades nothing and is not counted.
- **`trading_orders_refused_total{kind, reason, market_status}`** counts refused orders and sales: `reason` is the error
  code of the answer (`market_not_open`, `insufficient_credits`, `price_limit_exceeded`, `orders_paused`, ...; `internal_error`
  for a bug), and `market_status` is the status of the market (`funded`, `open` when its close time has passed, `closed`,
  `resolved`) for `market_not_open` and `none` for every other refusal. All three labels have a fixed set of values.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port, and only on that port.

## Events

Contract: [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml) (AsyncAPI 3.0); notes for consumers:
[`contracts/README.md`](contracts/README.md).

Published, as CloudEvents 1.0 on NATS JetStream (stream `TRADING`, subjects `chance.trading.<Event>.<tenantId>`, type
`si.chance.trading.<Event>.v1`, source `/chance/trading`):

| Event | When |
|---|---|
| `TradeExecuted` | An order or a sale was executed: the trade's shares, cost, average and last price, the YES price (`yesPriceMicro`, for market-data), the market's `tradeSequence` and `kind` (`buy` or `sale`, optional in the contract). A sale is described as the buy of the other side it makes (`side` = the side bought), so the price and the volume move as for that buy and a reader that ignores `kind` stays right |
| `MarketFunded` | A market was funded from its creator's credits |
| `MarketSettled` | A resolved market was settled: how many users were paid, the total and what returned to the creator. `outcome` `INVALID` (UC-16): the payout fields are the traders' refunds |
| `WithdrawalRefunded` | A failed withdrawal's credits went back to the user (for payments) |

Events carry ids and numbers only, never names or e-mails (DM-14). They are written to an outbox table in the same
transaction as the change and published by a relay inside the service (transactional outbox), so a change is never
stored without its event or published without being stored. Only one instance publishes at a time (an advisory lock for
the length of the claim), so the events of a market keep their order with several replicas: the relay publishes in the
order of writing (the table's identity column `seq`, never the application's `created_at`, which may differ between Pods
and is read after the market lock), and the rows of one market are written one after another under that market's row
lock. Published rows are deleted after the max age of the stream (`STREAM_MAX_AGE_DAYS`, 30 days by default).

Consumed, with one durable pull consumer `trading` per stream (explicit ack, deliver all, ack wait 30 seconds, at most 10
unacknowledged messages, no delivery limit) and an inbox row in the same transaction as the change, so a repeat changes
nothing:

| Stream and subjects | Inbox consumer | What it does |
|---|---|---|
| `TENANTS`: `chance.tenants.TenantCreated.*` | `tenant-created` | Creates the tenant's schema `tenant_<32 hex digits of the tenant id>` (the same naming rule as markets and payments) and registers the tenant |
| `MARKETS`: `chance.markets.>` | `market-events` | `MarketOpened`, `MarketClosed` and `MarketResolved` update trading's copy of the market (below); other types are acknowledged and ignored. `MarketResolved` settles the market |
| `PAYMENTS`: `chance.payments.DepositSucceeded.*`, `chance.payments.WithdrawalFailed.*` | `payment-events` | A deposit credits the user once per `depositId`; a failed withdrawal refunds exactly the debited amount once per `withdrawalId` and publishes `WithdrawalRefunded` |

A malformed event or an unknown type is logged as a warning and acknowledged, so one poison message never blocks a
consumer; an error is negatively acknowledged with a delay of 5 seconds and the message comes again. After **20 failed
deliveries** the consumer writes the message to `shared.parked_events` (consumer, stream sequence, subject, payload,
reason, deliveries) and acknowledges it, so one failing event never holds back the other markets and tenants; if parking
fails too, it is negatively acknowledged. A parked row is never overwritten by another message: stream sequences restart
when a stream is created again, so a different message that arrives under the key of a parked one fails to park, is
negatively acknowledged and is logged, until the parked one is handled. `npm run parked` lists the parked events and, with `--retry`, runs them again
through the same handler and deletes each that is then acknowledged (the inbox and the ledger keys make a repeat
harmless).

Services whose events or calls name a tenant that this service has not seen yet (funding, debits, market and payment
events) cause that tenant to be provisioned on the spot, the same work as `TenantCreated` (idempotent), so a tenant created
before this service existed is never stuck. User requests do not: they answer `503 tenant_not_ready` until the tenant
exists.

## How the ledger works

- **Streams.** `account:<userId>` holds a user's credits and positions; `bot:<marketId>` is the market's bot account
  (its owner is the market's creator). Every change is an event appended to `ledger_events` with the stream's expected
  version (DM-07, ADR-056), together with the correlation id, causation id and actor. The balance and the positions
  tables are projections of the events, saved in the same transaction.
- **Event types.** User: `CreditsGranted` (seed data only), `DepositCredited`, `WithdrawalDebited`,
  `WithdrawalRefunded`, `MarketFundingPaid`, `SharesBought`, `SharesSold` (UC-08), `PositionSettled`,
  `HoldingsReturned`. Bot: `BotFunded`, `BotSharesSold`, `BotSettled`, `BotHoldingsReturned`. INVALID resolution
  (UC-16): `PositionRefunded` (user) and `BotVoided` (bot). Both: `PairsRedeemed` (a redemption without a trade;
  reserved, never decided in this build).
- **No double booking.** `UNIQUE (stream_id, version)` and `UNIQUE (type, business_key)` (a grant id, deposit id,
  withdrawal id, trade id, market id) make a lost race or a repeated message fail instead of booking twice (DM-10); a lost
  race re-runs the whole transaction, up to three times, then answers `503 concurrent_update`.
- **Append-only.** A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` on `ledger_events`. DM-07 wants the role to have
  only `INSERT` and `SELECT`; with the single database role `trading` (DM-01) that role owns the table, so grants cannot
  limit it. The rule therefore holds for the code paths (no statement that updates or deletes exists, the trigger
  catches a mistake) and not against someone who holds the credentials; see the follow-ups.
- **Buying.** A buy takes the cheapest offers up to exactly `amount` credits (fill-or-kill), creating the pairs the bot
  lacks from its credits first. One order is one trade: one `SharesBought`, one `BotSharesSold`, the market's trade
  sequence plus one, one `TradeExecuted`. The locks are taken in one order (the market's row, the bot account, then
  user accounts by stream id), so concurrent orders on one market never sell one offer twice or overdraw an account.
- **Selling (UC-08).** One YES and one NO share always pay 1 credit together, so selling S shares of a side buys S
  shares of the other side from the bot's offers (fill or kill, cheapest first, the backing and pair-creation rules of
  a buy, each fill rounded up in the bot account's favour by less than one microcredit) and redeems the S pairs for S
  microcredits; the proceeds are S minus that cost, never negative, and a sale that would return nothing is refused.
  It is one trade in the same transaction shape and lock order as an order: on the trader's stream one `SharesSold`
  (the shares leave, the proceeds arrive in one step, so a trader with fewer credits than the other side's cost can
  still sell and no recorded state goes below zero; `SharesBought` followed by `PairsRedeemed` would take the balance
  below zero in between), on the bot's stream one `BotSharesSold` of the other side, the trade sequence plus one and one
  `TradeExecuted` with `kind: "sale"`. The runtime switch `ORDERS_ENABLED` pauses sales too; `ORDER_AMOUNT_MAX` is about
  credits spent and does not apply.
- **The market copy.** Trading keeps a copy of each market (`market_state`: `funded`, `open`, `closed` or `resolved`)
  from the three market events, which update it only when their version is higher, so a repeat or an event that arrives
  late is folded correctly. Like the market in `markets`, the copy only moves forward and a `resolved` copy is final: no
  event, whatever its version, moves it to an earlier status or changes the outcome its settlement used; a
  `MarketResolved` with another outcome is logged as an error and ignored. Both arrival orders work: funding first
  creates a `funded` copy, `MarketOpened` first creates an `open` one that the later funding call funds. A market can be
  traded while it is `open`, funded and before its close time. `MarketClosed` and `MarketResolved` delete the bot's
  offers.
- **Settlement.** On `MarketResolved`, in one transaction with the inbox row: the bot's holdings are settled, every user
  holding a position of that market is paid 1 credit per winning share (`PositionSettled`), and what the bot holds
  returns to the creator (`HoldingsReturned`). Credits are conserved exactly. A repeated event finds the market settled
  and changes nothing; a market that was never funded settles with no ledger events.
- **INVALID (UC-16).** On `MarketResolved` with `outcome` `INVALID`, in the same kind of transaction and exactly once:
  every share of the market is voided, and the credits behind its pairs plus the bot account's credits (which together
  are exactly what entered the market: the funding plus the traders' net payments) are paid out. Each trader gets back
  its net payment, summed from the ledger: what its buys cost (`SharesBought`, and the other side's shares of each
  sale, `SharesSold.costMicro`) minus what its sales returned (the pairs, `SharesSold.sharesMicro`; `PairsRedeemed`
  counts the same way), never below zero (`PositionRefunded`, also for a trader who sold everything and holds nothing). The
  bot account (`BotVoided`) returns the rest to the creator (`BotHoldingsReturned`, `HoldingsReturned`); without sales
  that is the funding to the microcredit. A trader who sold at a profit keeps it and gets no refund; that profit came
  out of the bot account and lowers the creator's part. When sellers' profits exceed the funding, the market holds less
  than the refunds: each refund is then cut pro rata (rounded down) and the creator gets only the rounding remainder.
  The decision checks the conservation (what the market holds equals what entered it; YES shares equal NO shares) and
  refuses to settle otherwise. The portfolio lists a refund as a payout of kind `refund` with outcome `INVALID`.
- **Replay.** `npm run replay` folds every stream of the ledger and compares the result with the projections (see "Commands").

## Commands

All three need the built code (`npm run build`) and `DATABASE_URL`; in the cluster run them inside a Pod of the
deployment (`node dist/<command>.js`). They never touch NATS.

```bash
npm run seed:credits -- --tenant <tenantId> --user <sub> --amount <credits> [--grant-id <id>]
npm run replay -- [--tenant <tenantId>] [--rebuild]
npm run parked -- [--consumer <name>] [--retry]
```

- `seed:credits` grants test credits (`CreditsGranted`); the grant id defaults to a new UUIDv7, and the same grant id twice
  grants once. It applies the migrations and creates the tenant's schema when the tenant is not registered yet. Credits are
  seed data only: in production they come from deposits (plan 6.2).
- `replay` reads every ledger event under a lock, folds each stream and reports every difference against the projections
  (balance, version, positions). It exits `0` only when they are equal. `--rebuild` rewrites the projections from the ledger.
  A stream whose events break an invariant (for example an order or debit that was decided on a projection that had
  drifted, so the ledger would go negative) cannot be folded: it is reported as an `unfoldable` difference with the
  error, the other streams are still compared, and a rebuild is refused (nothing is rewritten, `rebuilt` is false) until
  that stream is settled by a compensating event. A tenant whose replay fails is reported (`replay failed: ...`) and the
  next tenant still runs; the exit code is then `1`.
  Both modes run in one transaction that first takes `LOCK TABLE accounts, positions, ledger_events IN EXCLUSIVE MODE`:
  appends wait meanwhile (the demo's ledger replays in seconds), no append can commit between the read and the rewrite,
  and the comparison reports no false differences under load. Without `--tenant` it covers every tenant.
- `parked` lists the parked events (see "Events"); with `--retry` it runs them again.

## Configuration

Settings come from environment variables; the service refuses to start with a clear message when a required one is
missing or invalid, and never prints a value. In Kubernetes the non-secret ones come from the chart's ConfigMap and the
secret one from the Secret `trading-env`. The rows marked **runtime** can also change while the service runs (see
"Runtime configuration"). The source of truth is [`src/config.ts`](src/config.ts) with `tests/config.test.ts`;
`APP_ENV=local` is the only mode that may leave out the settings marked "required" below (it then uses in-memory
replacements).

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `APP_ENV` | `production` | no | Lowercase letters, digits and dashes. `local` allows in-memory replacements for the database and NATS (see "Run locally"); tokens are still verified against `AUTH_JWKS_URL`. Any other value needs every required setting, and the chart refuses `local` |
| `PORT` | `8080` | no | Public API and health probes (1 to 65535) |
| `INTERNAL_PORT` | `8081` (`8091` when `APP_ENV=local`) | no | Internal API (1 to 65535); must differ from `PORT`, because the NetworkPolicy admits other callers to each. Locally 8091, because a local Keycloak listens on 8081 |
| `GRPC_PORT` | `8082` | no | The gRPC debit for payments (1 to 65535, `contracts/trading-debit.proto`); must differ from `PORT` and `INTERNAL_PORT`, because the NetworkPolicy admits other callers to each. The same default in a local run |
| `METRICS_PORT` | `9464` | no | Port of the separate listener that serves `GET /metrics` (1 to 65535); must differ from `PORT`, `INTERNAL_PORT` and `GRPC_PORT` (see "Metrics") |
| `LOG_LEVEL` | `info` | no | **runtime.** `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `RUNTIME_CONFIG_FILE` | none | no | Path of the watched runtime file (the chart sets `/etc/trading/runtime/runtime.env`); without it no file is watched |
| `RUNTIME_CONFIG_POLL_MS` | `10000` | no | How often that file is read again (1000 to 3600000) |
| `DATABASE_URL` | required | **yes** | PostgreSQL connection string of the service's own database `trading` (`postgres://` or `postgresql://`) |
| `DATABASE_POOL_MAX` | `5` | no | Maximum database connections (1 to 50) |
| `NATS_URL` | required | no | NATS server (`nats://` or `tls://`) |
| `AUTH_JWKS_URL` | required (local default) | no | Where the token signing keys are published |
| `AUTH_ISSUER` | required (local default) | no | Expected `iss` of the tokens |
| `AUTH_AUDIENCE` | required (local default) | no | Expected `aud` of the tokens of users |
| `AUTH_ROLES_CLAIM` | `realm_access.roles` | no | Claim path of the realm roles; only `platform-admin` is read from it |
| `AUTH_TENANT_CLAIM` | `organization` | no | Claim of the organizations, an object keyed by alias (the alias is the tenant id) whose entry holds the `groups`: the tenant role is its one group, `/tenant-admin` or `/trader` |
| `INTERNAL_AUTH_AUDIENCE` | the value of `AUTH_AUDIENCE` | no | Expected `aud` of the service tokens on the internal port and the gRPC port |
| `INTERNAL_CLIENT_CLAIM` | `azp` | no | The claim of a service token that names the calling client |
| `MARKETS_CLIENT_ID` | `markets` | no | Client id admitted to `/v1/internal/market-funding` |
| `PAYMENTS_CLIENT_ID` | `payments` | no | Client id admitted to `/v1/internal/debits` and to the gRPC debit |
| `MARKET_MAKER_CLIENT_ID` | `market-maker` | no | Client id admitted to the market and bot-book endpoints; the three client ids must differ |
| `OUTBOX_POLL_MS` | `300` | no | How often the relay looks for unpublished events (50 to 60000) |
| `STREAM_MAX_AGE_DAYS` | `30` | no | How long the `TRADING` stream keeps its messages, in days (1 to 365). The relay deletes its published outbox rows after the same time and the inbox entries a day later, so every Chance service runs with the same value. The service brings an existing stream to this value at every start, so **lowering it deletes the older messages from the stream at the next start**. It is long on purpose, so that a service started later still sees the older events: lower it back (for example to 7) once every consumer is live |
| `ORDER_AMOUNT_MAX` | `100000` | no | **runtime.** The largest amount of one order, in credits (1 to 1000000) |
| `MAX_OFFERS_PER_SIDE` | `10` | no | **runtime.** The most offers the bot may rest per side of a market (1 to 50) |
| `ORDERS_ENABLED` | `true` | no | **runtime.** `false` pauses new orders and sales (`503 orders_paused`); quotes, sale quotes, the portfolio and the internal API keep working |
| `SHUTDOWN_DELAY_MS` | `5000` (`0` when `APP_ENV=local`) | no | Drain delay after SIGTERM, 0 to 15000 (see "Shutdown") |
| `SEED_CREDITS` | none | no | **Local only** (an error otherwise): `<tenantId>/<userId>=<credits>,...`, each line granted once at startup (a UUID tenant id, 1 to 1000000 credits) |

With `APP_ENV=local` the token settings default to a Keycloak on port 8081 (`AUTH_JWKS_URL`, `AUTH_ISSUER` and
`AUTH_AUDIENCE` as in `src/config.ts`); tokens are always verified.

### Runtime configuration

Four keys (`LOG_LEVEL`, `ORDER_AMOUNT_MAX`, `MAX_OFFERS_PER_SIDE`, `ORDERS_ENABLED`) can change without a restart
(ADR-037). The order is: defaults, then the watched file `RUNTIME_CONFIG_FILE`, then environment variables, so a key
set in the environment always wins and the file's value for it is ignored (and logged); the chart therefore sets these
keys only in the file. The file's lines are `KEY=value` (blank lines and lines starting with `#` are skipped). The
service reads the file at start and then every `RUNTIME_CONFIG_POLL_MS`; a key that is missing from the file keeps its
startup value, so deleting a line undoes an override. A missing, unreadable or invalid file never stops the service: it
keeps what it has, and logs the problem. A key whose value is invalid (`ORDERS_ENABLED=flase`, `ORDER_AMOUNT_MAX=5O`)
keeps the value that is in force, not the startup value, so a typo never lifts a pause; a key name that is misspelled is
only logged and counts as a key that is missing.

In the chart the four keys are the `runtime` block of the values. They are rendered into a second ConfigMap,
`<release>-runtime` (key `runtime.env`), which the Pods mount as the directory `/etc/trading/runtime` (never as a
`subPath`, which would not update). That ConfigMap is left out of the Deployment's checksum annotation on purpose: a
change reaches the running Pods within about a minute (the kubelet refreshes the mount, then the poll) and does not
restart them. The four keys therefore live only there, not in the environment ConfigMap, so a value never has two
sources. Everything else in `env` is read at start, and a change restarts the Pods. `ORDERS_ENABLED=false` is the switch
to pause trading in an incident without a deploy.

## Shutdown

On SIGTERM (Kubernetes) or SIGINT the service shuts down in two steps, so that a rolling deploy does not fail
requests that were already on their way:

1. **Drain.** `GET /health/ready` answers `503` (code `shutting_down`) from this moment. The service keeps serving
   requests and keeps its loops running for `SHUTDOWN_DELAY_MS` (default 5 seconds), the time the load balancer needs to
   take the pod out of rotation.
2. **Close**, in this order: both HTTP servers and the gRPC server (an order or a debit in flight finishes; the gRPC
   connections are cut after 5 seconds if a call does not), the three consumers (a message being handled
   is finished and acknowledged, the rest stay on the stream), the outbox relay, the runtime-file watcher, NATS, the
   database pool. The loops stop before NATS and the pool close, because they use both. It exits with `0`; if closing
   takes more than 10 seconds after the delay, it exits with `1`.

The chart keeps `terminationGracePeriodSeconds: 30`: the delay is limited to 15 seconds, so delay plus close always ends
before Kubernetes sends SIGKILL.

## Run locally

Node.js 24 is required.

```bash
npm ci
npm run build
APP_ENV=local npm start          # everything in memory, events only logged
```

In local mode without a database the memory store provisions a tenant the first time it sees it, so any token with a
tenant claim works at once; there are no consumers without NATS, so market and payment events are posted to
`POST /v1/internal/local/events` (with a token whose client is one of the three services), and test credits come from
`SEED_CREDITS`, for example `SEED_CREDITS=<tenantId>/<userId>=5000`, granted once at startup. Tokens are always verified: point
`AUTH_JWKS_URL`, `AUTH_ISSUER` and `AUTH_AUDIENCE` at the identity provider (the realm of the `identity` repository) or at
a key set of your own. The public API listens on 8080, the internal one on 8091 and the gRPC debit on 8082.

With a real database and NATS (Docker needed): `docker compose up -d`, then start with `DATABASE_URL` and `NATS_URL` as
shown at the top of [`compose.yaml`](compose.yaml); `docker compose --profile app up --build` runs the service itself in
a container as well (public API on `localhost:8080`, internal API on `localhost:8091`, gRPC debit on `localhost:8092`). With a database a tenant is provisioned
by `TenantCreated` or by the first funding call, debit or market or payment event that names it, so run the tenants
service against the same NATS and create a tenant there, or call the internal funding endpoint; until then user requests
answer `503 tenant_not_ready`. Give a user credits with `npm run seed:credits` (see "Commands").

## Tests

```bash
npm run lint                     # ESLint, including the layer rules below
npm run typecheck
npm test                         # unit, web and contract tests; npm test -- --coverage for the coverage report (80 % threshold)
npm run test:integration         # PostgreSQL 18 in a container (Testcontainers); needs Docker
```

The domain is tested on its own, the use cases run against in-memory adapters (with a property-style test of
random buy and sale sequences, offer replacements and a YES, NO or INVALID resolution: conservation after every step,
replay equality, refunds on the net payments, `tests/usecases/sales-property.test.ts`), the web tests send real signed JWTs
(user tokens and service tokens), the gRPC tests run a real client (which loads `contracts/trading-debit.proto` by
itself) against a real server over HTTP/2 (every status, the idempotency shared with REST, deadlines, the graceful
close), and the contract tests fail when a route is missing from either OpenAPI file (or the
other way round), when the proto's fields, types or bounds differ from the REST debit's, when the documented statuses
are missing from the proto or `contracts/README.md`, when a response does not match its documented schema, when an event does not match
`contracts/asyncapi.yaml`, or when the funding and debit answers and the `WithdrawalRefunded` event do not match what
markets and payments expect (their files are kept as copies in `contracts/external`, see `contracts/README.md`). The
integration tests cover the migrations per tenant schema, the ledger constraints and the append-only trigger, the
projection checks, concurrent orders on one market (no negative balance, contiguous trade sequences), the idempotency
key under concurrency, the outbox, the inbox, the replay on real rows and the real use cases running concurrently on the
PostgreSQL store (`tests/integration/use-cases-concurrency.test.ts`: many orders on one market, funding racing
`MarketOpened` and `MarketClosed`, `MarketResolved` racing orders, a replay racing appends, the market maker's
replacement racing orders (applied or 409 `stale_sequence`, every order filled from the book in force at its trade),
sales racing buys and a replacement on one market (one execution per key, every fill from the book in force, then an
INVALID resolution that refunds each seller's net payment),
and one deposit, debit or failure delivered several times at once; each proves that no balance went negative, the credits are conserved and the
replay finds no difference, and all but the replay test also that the database ended no transaction for a deadlock).

The chart is checked the way the pipeline checks it: `helm lint helm -f helm/values-dev.yaml` (and the prod values),
and `helm template trading helm -f helm/values-prod.yaml | kubeconform -strict` (also with `--set networkPolicy.enabled=true`).

## Layout (Clean Architecture)

| Folder | Holds | May import |
|---|---|---|
| `src/domain` | Units, the ledger events and streams, accounts, the order book, settlement, the market copy, event builders, the tenant schema naming; no I/O | nothing outside the domain |
| `src/usecases` | One class per use case, the ports (interfaces), errors and shared helpers | the domain |
| `src/adapters` | PostgreSQL store and migrator, the outbox relay, the NATS publisher and the generic JetStream consumer with its message handlers, the runtime-file watcher, the metrics modules (HTTP metrics, the order counters), in-memory versions for local runs and tests | use cases and domain |
| `src/web` | Fastify apps and routes of both ports, token and service-client checks, problem details | use cases and domain |
| `src/web/grpc` | The gRPC debit: the loading of the proto, the server (authentication through the same service-token checks as REST, deadlines, graceful close) and the mapping of errors to statuses | use cases, domain and `src/web` |
| `src/main.ts` | Composition root: configuration, adapters, use cases, both HTTP servers and the gRPC server | everything |
| `src/seed-credits.ts`, `src/replay.ts`, `src/parked.ts` | The three commands | use cases and adapters |
| `src/config.ts`, `src/shutdown.ts` | Typed configuration and the shutdown sequence (its steps are passed in, so it is tested with fake timers) | the logger port |
| `migrations/shared`, `migrations/tenant` | Versioned SQL: the shared schema (tenant registry, outbox, inbox, market and withdrawal directories, parked events), and the tables of one tenant (ledger, accounts, positions, market copy, bot orders, idempotency keys), applied to every tenant schema | |
| `contracts` | The two OpenAPI files, the AsyncAPI file and the proto of the gRPC debit | |
| `helm` | Chart with dev and prod values, a watched runtime ConfigMap and a `helm test` smoke test | |

The lint fails when an inner layer imports an outer one.

## Delivery

Pull requests run lint, type check, tests with coverage, chart checks and an image build; a merge to `main` builds the
image once, pushes it to Docker Hub and deploys it to the prod namespace with Helm, followed by the smoke test and an
automatic rollback on failure. The steps live in the organization's shared workflow; see
[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml). That workflow does not run the integration tests, and the
coverage gate leaves out the PostgreSQL and NATS adapters, so this repository has its own workflow for them,
[`.github/workflows/integration.yml`](.github/workflows/integration.yml) (`npm run test:integration` on pull requests and
on `main`; make it a required check). The image holds `dist/`, the production dependencies and
the whole `migrations` tree and `contracts/trading-debit.proto` (the gRPC server loads it at start), exposes ports 8080,
8081 and 8082, and runs as a non-root user on a read-only file system.

The chart (`helm`) creates a Deployment, a Service with the three ports (`http` 8080, `internal` 8081 and `grpc` 8082), the environment
ConfigMap, the runtime ConfigMap, a `helm test` smoke test and, when `networkPolicy.enabled` is set, a NetworkPolicy. The
Secret `trading-env` (`DATABASE_URL`) is created by the pipeline from the organization secret `TRADING_ENV` and is never
part of the chart. The Pod also has a container port `metrics` (not on the Service), with the Prometheus annotations. The NetworkPolicy admits only the API gateway to the public port and only Pods labelled
`app.kubernetes.io/name` markets, payments or market-maker (`networkPolicy.internal.allowedApps`) to the internal port and
only payments (`networkPolicy.grpc.allowedApps`) to the gRPC port, only the namespace `networkPolicy.metrics.namespace` to the metrics port, and lets the Pods reach only PostgreSQL (5432), NATS (4222), the identity provider (8080) and DNS (53): trading calls no
other service. The probes and the smoke test use the public port. The readiness probe has its own `timeoutSeconds` (4,
below `periodSeconds`): the handler waits for a pool connection like any request, up to 3 seconds, and the kubelet's
default timeout of 1 second would take a busy Pod out of the Service while the database is fine. The schema of the chart
bounds the startup settings that the service checks at start (`DATABASE_POOL_MAX`, `SHUTDOWN_DELAY_MS`,
`OUTBOX_POLL_MS`, `STREAM_MAX_AGE_DAYS`, `RUNTIME_CONFIG_POLL_MS`), and the template refuses equal client ids and equal ports (`service.port`, `service.internalPort`, `service.grpcPort`, `metrics.port`), so a bad value fails `helm lint`
and not the rollout.

## What it needs

- **PostgreSQL 18**: the database `trading` and the login role `trading` on the shared server (DM-01, DM-10); one schema
  per tenant plus the schema `shared`.
- **NATS with JetStream**: the stream `TRADING` (created by this service), the stream `TENANTS` of the tenants service,
  the stream `MARKETS` of markets and the stream `PAYMENTS` of payments.
- **The identity provider**: the signing keys of the tokens, and client-credentials clients for the three callers
  (`markets`, `payments`, `market-maker`) with the audience `chance`.
- **markets**: calls the internal funding endpoint and publishes the market events.
- **payments**: calls the internal debit endpoint (or the same debit over gRPC), publishes `DepositSucceeded` and
  `WithdrawalFailed`, and may consume `WithdrawalRefunded`.
- **market-maker**: reads and replaces the bot's book through the internal API.
- **The API gateway**, which routes the prefix `/v1/trading` to the public port (the health paths and the internal API are
  not routed).

## Follow-ups

Recorded, not built here:

- **Keycloak clients.** The new client `market-maker`, and the audience `chance` on the service-account tokens of
  `markets` and `payments`, in the identity provider's realm; confirm that the `azp` claim names the client.
- **payments.** `TRADING_BASE_URL` has to become `http://trading:8081` (it defaults to port 8080), with a NetworkPolicy
  egress rule for port 8081, and a consumer of `WithdrawalRefunded` (its data now also has `refundedAt`).
- **markets.** The chart value `trading.port` has to be 8081 (its contract already says so).
- **The ledger's write protection (DM-07).** A migration owner role without login and a login role `trading` with
  `SELECT` and `INSERT` on `ledger_events` and DML on the projections (an amendment of DM-01 and the infrastructure's role
  setup); until then the append-only rule holds for the code and the trigger, not against someone with the credentials.
- **payments' gRPC client.** The server side of the debit over gRPC is built (REQ-17, ADR-023; "gRPC debit" above); payments
  needs a client of `contracts/trading-debit.proto` (address `trading:8082`, a copy of the proto beside its code), a
  NetworkPolicy egress rule for port 8082 and, where the Pods balance on it, a decision on connection reuse
  ("Load balancing" above).
- **The web front end** shows sales (`POST /v1/trading/sales`, `GET /v1/trading/sale-quote`, the portfolio's
  `kind` and `proceedsMicro`). **Snapshots** of long streams if they grow.
- **Chart.** `AUTH_ISSUER` is empty in `helm/values-prod.yaml`; the pipeline fills it in from the organization variable
  `PUBLIC_HOST` (`host-values` in `.github/workflows/ci-cd.yml`), and a deploy without it stops at start (INF-01). The NetworkPolicy is off by default: it needs a network policy engine in the cluster, and the labels in
  `networkPolicy` must match the Pods of the gateway, markets, payments, market-maker and the shared PostgreSQL, NATS and
  identity.
- **Delivery.** The repository secret `TRADING_ENV` has to exist before the first deploy, and the Docker image is not
  built locally (the pull-request pipeline builds it).
