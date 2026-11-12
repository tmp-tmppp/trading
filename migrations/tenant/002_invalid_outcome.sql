-- UC-16: a market resolved INVALID. markets' MarketResolved gains the outcome INVALID; trading voids every share of the
-- market, refunds each trader's net payment (its buys minus what its sales returned, never below zero) and returns the
-- rest to the creator (src/domain/settlement.ts, decideRefundSettlement). Two internal ledger event types record it
-- (DM-08, never published): PositionRefunded on a user stream, BotVoided on the market's bot stream. The constraints keep
-- their names; only the lists of allowed values grow, so every stored row passes the new checks.

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_values;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_values CHECK (type IN (
    'CreditsGranted', 'DepositCredited', 'WithdrawalDebited', 'WithdrawalRefunded', 'MarketFundingPaid',
    'SharesBought', 'PositionSettled', 'PositionRefunded', 'HoldingsReturned',
    'BotFunded', 'BotSharesSold', 'BotSettled', 'BotVoided', 'BotHoldingsReturned',
    'PairsRedeemed'));

-- The same rule as evolve() in src/domain/ledger.ts: bot events on bot streams, PairsRedeemed on either, the rest on
-- user streams. PositionRefunded's business key is "<marketId>/<streamId>", BotVoided's the market id, so UNIQUE (type,
-- business_key) refuses a second INVALID settlement of a market (DM-10).
ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_matches_stream;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_matches_stream CHECK (
    CASE
        WHEN type IN ('BotFunded', 'BotSharesSold', 'BotSettled', 'BotVoided', 'BotHoldingsReturned') THEN stream_id LIKE 'bot:%'
        WHEN type = 'PairsRedeemed' THEN true
        ELSE stream_id LIKE 'account:%'
    END);

ALTER TABLE market_state DROP CONSTRAINT market_state_outcome_values;
ALTER TABLE market_state ADD CONSTRAINT market_state_outcome_values CHECK (outcome IN ('YES', 'NO', 'INVALID'));

-- The INVALID settlement sums every user's buys and redemptions of one market (LedgerRepository.marketPayments). This
-- partial index holds only those two event types, keyed by the market, so the sum reads the market's trades and not
-- the whole ledger of the tenant.
CREATE INDEX ledger_events_market_payments_idx ON ledger_events ((data ->> 'marketId'), stream_id)
    WHERE type IN ('SharesBought', 'PairsRedeemed');
