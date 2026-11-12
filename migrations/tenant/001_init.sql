-- Tables of one tenant (plan sections 6.2 and 9). This file is applied once to every tenant schema, with the schema as
-- the only entry of the search path: the names below are therefore not qualified. A tenant schema holds nothing that
-- belongs to another tenant, so a forgotten tenant filter cannot reach another tenant's rows (DM-01).
-- Quantities are micro-units in bigint columns (1 credit = 10^6 microcredits, 1 share = 10^6 microshares; ADR-055);
-- prices are microcredits per share on the grid 10 000 .. 990 000 in steps of 10 000. Constraints are the last guard
-- (DM-10): the domain refuses the same things first, and a bug in a use case stops here instead of corrupting a balance.

-- The ledger (DM-07, ADR-056): an append-only event store, one stream per user account ("account:<userId>") and one per
-- market's bot account ("bot:<marketId>"). Balances and positions below are projections of it, written in the same
-- transaction as the append and rebuildable by replay.
CREATE TABLE ledger_events (
    -- Global order of appends in this schema; the replay reads by it.
    position     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The last characters of a user id are free text (the identity provider's subject), so only control characters are
    -- refused here; the domain checks the rest (isUserId).
    stream_id    text        NOT NULL CONSTRAINT ledger_events_stream_id_format CHECK (
                                 stream_id ~ '^account:[^\x01-\x1f\x7f]{1,255}$'
                                 OR stream_id ~ '^bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- 1, 2, ... per stream. The append states the version it expects; UNIQUE (stream_id, version) is the optimistic lock.
    version      integer     NOT NULL CONSTRAINT ledger_events_version_positive CHECK (version >= 1),
    type         text        NOT NULL CONSTRAINT ledger_events_type_values CHECK (type IN (
                                 'CreditsGranted', 'DepositCredited', 'WithdrawalDebited', 'WithdrawalRefunded', 'MarketFundingPaid',
                                 'SharesBought', 'PositionSettled', 'HoldingsReturned',
                                 'BotFunded', 'BotSharesSold', 'BotSettled', 'BotHoldingsReturned',
                                 'PairsRedeemed')),
    -- grantId, depositId, withdrawalId, tradeId or marketId; "<marketId>/<streamId>" for PositionSettled, and
    -- "<redemptionId>/<streamId>" for PairsRedeemed (businessKeyOf in src/domain/ledger.ts).
    business_key text        NOT NULL CONSTRAINT ledger_events_business_key_length CHECK (char_length(business_key) BETWEEN 1 AND 512),
    data         jsonb       NOT NULL CONSTRAINT ledger_events_data_object CHECK (jsonb_typeof(data) = 'object'),
    -- Who and what caused the event (ids only, DM-14): correlationId, causationId and actor.
    meta         jsonb       NOT NULL CONSTRAINT ledger_events_meta_keys CHECK (
                                 jsonb_typeof(meta) = 'object' AND meta ?& ARRAY['correlationId', 'causationId', 'actor']),
    recorded_at  timestamptz NOT NULL,
    CONSTRAINT ledger_events_stream_version_key UNIQUE (stream_id, version),
    -- DM-10's last guard: a deposit is credited once, a withdrawal debited and refunded once, a market funded and
    -- settled once, a trade recorded once, whatever the code above does.
    CONSTRAINT ledger_events_type_business_key_key UNIQUE (type, business_key),
    -- Bot events belong to bot streams, the other user events to user streams (PairsRedeemed to either): the same rule
    -- as evolve() in src/domain/ledger.ts.
    CONSTRAINT ledger_events_type_matches_stream CHECK (
        CASE
            WHEN type IN ('BotFunded', 'BotSharesSold', 'BotSettled', 'BotHoldingsReturned') THEN stream_id LIKE 'bot:%'
            WHEN type = 'PairsRedeemed' THEN true
            ELSE stream_id LIKE 'account:%'
        END)
);

-- Append-only (DM-07): an UPDATE, DELETE or TRUNCATE of the ledger is refused, whatever statement or tool sends it.
-- Gap, recorded in ADR-056, the README and the follow-ups: the single database role "trading" (DM-01) owns this table,
-- so grants cannot limit it, and its owner could disable the trigger. DM-07's "may only INSERT and SELECT" therefore
-- holds for the code paths (no UPDATE or DELETE statement exists in the service and the trigger catches a mistake), not
-- against someone who holds the credentials. A migration owner role and a login role with SELECT and INSERT would close
-- it (a DM-01 amendment and the infrastructure's role setup).
CREATE FUNCTION ledger_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'ledger_events is append-only: % is refused', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_events_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_events
    FOR EACH ROW EXECUTE FUNCTION ledger_events_append_only();

CREATE TRIGGER ledger_events_no_truncate
    BEFORE TRUNCATE ON ledger_events
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_events_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON ledger_events FROM PUBLIC;

-- Projection: one row per stream with its balance. The replay rebuilds it from the ledger (DM-07).
CREATE TABLE accounts (
    stream_id     text        PRIMARY KEY CONSTRAINT accounts_stream_id_format CHECK (
                                  stream_id ~ '^account:[^\x01-\x1f\x7f]{1,255}$'
                                  OR stream_id ~ '^bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    kind          text        NOT NULL CONSTRAINT accounts_kind_values CHECK (kind IN ('user', 'bot')),
    -- The user of a user account; the market's creator for a bot account (who gets its holdings back at settlement).
    owner_id      text        CONSTRAINT accounts_owner_id_length CHECK (char_length(owner_id) BETWEEN 1 AND 255),
    -- The market of a bot account; null for a user account.
    market_id     uuid,
    balance_micro bigint      NOT NULL CONSTRAINT accounts_balance_not_negative CHECK (balance_micro >= 0),
    -- The version of the last event folded in: at least 1, because an account row exists only after its first event.
    version       integer     NOT NULL CONSTRAINT accounts_version_positive CHECK (version >= 1),
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT accounts_bot_iff_market CHECK ((kind = 'bot') = (market_id IS NOT NULL)),
    CONSTRAINT accounts_user_stream_matches_owner CHECK (kind <> 'user' OR (owner_id IS NOT NULL AND stream_id = 'account:' || owner_id)),
    CONSTRAINT accounts_bot_stream_matches_market CHECK (kind <> 'bot' OR stream_id = 'bot:' || market_id::text)
);

-- The portfolio of a tenant admin lists the markets whose bot accounts the admin owns.
CREATE INDEX accounts_bot_owner_idx ON accounts (owner_id) WHERE kind = 'bot';

-- Projection: the shares an account holds per market. A row exists only while the account holds some of either side
-- (the code deletes a position that reaches zero). The bot account has rows here too: a settlement never treats it as a
-- holder (holdersOf filters on accounts.kind).
CREATE TABLE positions (
    stream_id  text        NOT NULL REFERENCES accounts (stream_id),
    market_id  uuid        NOT NULL,
    yes_micro  bigint      NOT NULL CONSTRAINT positions_yes_not_negative CHECK (yes_micro >= 0),
    no_micro   bigint      NOT NULL CONSTRAINT positions_no_not_negative CHECK (no_micro >= 0),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (stream_id, market_id),
    CONSTRAINT positions_not_empty CHECK (yes_micro > 0 OR no_micro > 0)
);

-- The settlement finds the holders of one market.
CREATE INDEX positions_market_idx ON positions (market_id);

-- trading's copy of the market (EP-2, DM-04, DM-12): status and close time to accept or refuse orders without calling
-- markets, the question for the portfolio, and the trade sequence. Written by the funding call and by markets' lifecycle
-- events; a lifecycle event changes status and version only when its version is higher (DM-04).
CREATE TABLE market_state (
    market_id           uuid        PRIMARY KEY,
    -- markets' version of the last lifecycle event applied; 0 while only the funding call is known.
    version             integer     NOT NULL DEFAULT 0 CONSTRAINT market_state_version_not_negative CHECK (version >= 0),
    -- "funded": the funding call arrived, MarketOpened not yet.
    status              text        NOT NULL CONSTRAINT market_state_status_values CHECK (status IN ('funded', 'open', 'closed', 'resolved')),
    question            text        CONSTRAINT market_state_question_length CHECK (char_length(question) BETWEEN 1 AND 200),
    close_time          timestamptz,
    starting_price_micro bigint     CONSTRAINT market_state_starting_price_grid CHECK (
                                        starting_price_micro BETWEEN 10000 AND 990000 AND starting_price_micro % 10000 = 0),
    creator_id          text        CONSTRAINT market_state_creator_id_length CHECK (char_length(creator_id) BETWEEN 1 AND 255),
    -- Null until the funding call.
    funding_micro       bigint      CONSTRAINT market_state_funding_positive CHECK (funding_micro > 0),
    outcome             text        CONSTRAINT market_state_outcome_values CHECK (outcome IN ('YES', 'NO')),
    -- +1 for every trade: the bot replaces its offers based on it (ADR-041).
    trade_sequence      bigint      NOT NULL DEFAULT 0 CONSTRAINT market_state_trade_sequence_not_negative CHECK (trade_sequence >= 0),
    funded_at           timestamptz,
    opened_at           timestamptz,
    closed_at           timestamptz,
    resolved_at         timestamptz,
    settled_at          timestamptz,
    payout_total_micro  bigint      CONSTRAINT market_state_payout_not_negative CHECK (payout_total_micro >= 0),
    returned_micro      bigint      CONSTRAINT market_state_returned_not_negative CHECK (returned_micro >= 0),
    updated_at          timestamptz NOT NULL,
    -- The outcome exists exactly when the market is resolved.
    CONSTRAINT market_state_outcome_iff_resolved CHECK ((outcome IS NOT NULL) = (status = 'resolved')),
    -- Only a resolved market is settled (once: settled_at is set by the settlement and never cleared).
    CONSTRAINT market_state_settled_only_resolved CHECK (settled_at IS NULL OR status = 'resolved')
);

-- The market maker's list of open markets reads by status, ordered by id.
CREATE INDEX market_state_status_idx ON market_state (status, market_id);

-- The bot's resting offers (ADR-019, ADR-041): the whole book of a market is replaced at once, so it holds the rows of
-- the latest PUT, less what trades consumed. One offer per side and price.
CREATE TABLE bot_orders (
    market_id          uuid        NOT NULL REFERENCES market_state (market_id),
    side               text        NOT NULL CONSTRAINT bot_orders_side_values CHECK (side IN ('YES', 'NO')),
    price_micro        integer     NOT NULL CONSTRAINT bot_orders_price_grid CHECK (price_micro BETWEEN 10000 AND 990000 AND price_micro % 10000 = 0),
    shares_micro       bigint      NOT NULL CONSTRAINT bot_orders_shares_positive CHECK (shares_micro > 0),
    -- The trade sequence the bot priced the offers on; a fill keeps it (information only).
    priced_on_sequence bigint      CONSTRAINT bot_orders_priced_on_sequence_not_negative CHECK (priced_on_sequence >= 0),
    placed_at          timestamptz NOT NULL,
    PRIMARY KEY (market_id, side, price_micro)
);

-- Idempotency keys (REL-03). The scope separates the uses: "order:<userId>" (a key belongs to its user), "funding" (key =
-- market id) and "debit" (key = withdrawal id). A key row is inserted by the transaction that does the work and
-- completed in it, so a rolled-back request leaves no key and a repeat of it is decided anew. Order keys are purged
-- after ORDER_KEY_RETENTION_MS; funding and debit keys are business keys and stay.
CREATE TABLE idempotency_keys (
    scope        text        NOT NULL CONSTRAINT idempotency_keys_scope_length CHECK (char_length(scope) BETWEEN 1 AND 300),
    key          text        NOT NULL CONSTRAINT idempotency_keys_key_length CHECK (char_length(key) BETWEEN 1 AND 255),
    -- Fingerprint of the request: the same key with another request is refused (422 idempotency_key_reused).
    request_hash text        NOT NULL CONSTRAINT idempotency_keys_request_hash_length CHECK (char_length(request_hash) BETWEEN 1 AND 128),
    -- The answer to replay; null only while the claiming transaction is still running.
    result       jsonb,
    created_at   timestamptz NOT NULL,
    PRIMARY KEY (scope, key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
