-- Shared schema of trading (plan sections 6.2 and 9): everything that no single tenant owns. The ledger, the accounts,
-- the market copies and the order book are in migrations/tenant and exist once per tenant schema (DM-01).
-- Timestamps come from the service clock. Constraints are the last guard (DM-10); foreign keys exist only inside this
-- database (DM-02).
--
-- shared.schema_migrations (version, checksum, applied_at) is created by the migration runner itself, before the
-- first file runs, because it records which files ran; every tenant schema has its own copy of it.

CREATE SCHEMA IF NOT EXISTS shared;

-- The tenants this service has a schema for. A row is written in the same transaction that creates and migrates the
-- schema (the TenantCreated inbox, or ensureTenant for a tenant a trusted service names first), so a registered tenant
-- always has its schema, and the startup migration applies every tenant migration to every registered schema:
-- schemas never drift apart.
CREATE TABLE shared.tenant_registry (
    tenant_id   uuid        PRIMARY KEY,
    schema_name text        NOT NULL CONSTRAINT tenant_registry_schema_format CHECK (schema_name ~ '^tenant_[0-9a-f]{32}$'),
    created_at  timestamptz NOT NULL,
    CONSTRAINT tenant_registry_schema_key UNIQUE (schema_name),
    -- The schema name is derived from the id and from nothing else.
    CONSTRAINT tenant_registry_schema_matches_id CHECK (schema_name = 'tenant_' || replace(tenant_id::text, '-', ''))
);

-- Transactional outbox (REL-01): written in the same transaction as the data change, published by the relay.
CREATE TABLE shared.outbox (
    id           uuid        PRIMARY KEY,
    -- The order of writing: the relay publishes by it. The rows of one market are written under that market's row
    -- lock, so seq follows the trade sequence; created_at is the time the application stamped and may differ.
    seq          bigint      GENERATED ALWAYS AS IDENTITY,
    aggregate_id text        NOT NULL,
    -- NATS subject, for example chance.trading.TradeExecuted.<tenantId>.
    subject      text        NOT NULL,
    type         text        NOT NULL,
    -- The whole CloudEvent.
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL,
    published_at timestamptz,
    attempts     integer     NOT NULL DEFAULT 0,
    last_error   text
);

CREATE INDEX outbox_unpublished_idx ON shared.outbox (seq) WHERE published_at IS NULL;

-- Inbox of consumed events (ADR-053, DM-06): the id of a processed event is stored in the same transaction as its
-- change, so a redelivered event changes nothing. One consumer per kind of event ("tenant-created", "market-events",
-- "payment-events"), because the same id never repeats across kinds. The entries are purged after the retention of the
-- streams plus a margin (INBOX_RETENTION_MS).
CREATE TABLE shared.inbox (
    consumer     text        NOT NULL CONSTRAINT inbox_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    event_id     text        NOT NULL CONSTRAINT inbox_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type   text        NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

CREATE INDEX inbox_processed_idx ON shared.inbox (processed_at);

-- Which tenant a market belongs to. The market maker's internal endpoints name only a market; trading takes the tenant
-- from this table and never from a token (plan section 9, ADR-019). It is written by the funding call and by
-- MarketOpened, always after the market_state row of the tenant (TRD-08: one lock order).
CREATE TABLE shared.market_directory (
    market_id  uuid        PRIMARY KEY,
    tenant_id  uuid        NOT NULL REFERENCES shared.tenant_registry (tenant_id),
    created_at timestamptz NOT NULL
);

CREATE INDEX market_directory_tenant_idx ON shared.market_directory (tenant_id);

-- Which tenant a withdrawal was debited in. The debit's idempotency key and ledger key live in the tenant's schema, so a
-- withdrawal id repeated with another tenant is caught only here (422). First registration wins.
CREATE TABLE shared.withdrawal_directory (
    withdrawal_id uuid        PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES shared.tenant_registry (tenant_id),
    created_at    timestamptz NOT NULL
);

-- Consumed events that failed PARK_AFTER_DELIVERIES deliveries in a row. The consumer writes the message here and
-- acknowledges it, so one failing event cannot hold back the rest of its stream; "npm run parked" lists these rows and
-- runs them again through the same handler. The stream sequence identifies a message even when its body is not JSON.
CREATE TABLE shared.parked_events (
    consumer        text        NOT NULL CONSTRAINT parked_events_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    stream_sequence bigint      NOT NULL CONSTRAINT parked_events_stream_sequence_positive CHECK (stream_sequence >= 1),
    subject         text        NOT NULL,
    -- The raw message body as UTF-8 text.
    payload         text        NOT NULL,
    -- The last error (message and code), never a token.
    reason          text        NOT NULL,
    deliveries      integer     NOT NULL CONSTRAINT parked_events_deliveries_positive CHECK (deliveries >= 1),
    parked_at       timestamptz NOT NULL,
    PRIMARY KEY (consumer, stream_sequence)
);

CREATE INDEX parked_events_parked_idx ON shared.parked_events (parked_at);
