-- UC-08: a trader sells shares before the market closes. trading buys as many shares of the other side from the bot's
-- offers and redeems the pairs for 1 microcredit each, in one transaction (plan 6.2). The trader's stream records it as
-- one internal event, SharesSold (DM-08, never published; the bot's stream records BotSharesSold of the other side, as
-- for a buy). The constraints keep their names; only the list of allowed types grows, so every stored row passes.

ALTER TABLE ledger_events DROP CONSTRAINT ledger_events_type_values;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_type_values CHECK (type IN (
    'CreditsGranted', 'DepositCredited', 'WithdrawalDebited', 'WithdrawalRefunded', 'MarketFundingPaid',
    'SharesBought', 'SharesSold', 'PositionSettled', 'PositionRefunded', 'HoldingsReturned',
    'BotFunded', 'BotSharesSold', 'BotSettled', 'BotVoided', 'BotHoldingsReturned',
    'PairsRedeemed'));

-- ledger_events_type_matches_stream needs no change: SharesSold is not a bot type and not PairsRedeemed, so its ELSE
-- branch already requires a user stream ('account:%'). Its business key is the trade id (UNIQUE (type, business_key)).

-- The INVALID settlement (UC-16) sums each user's net payment into a market, sales included (SharesSold: the other
-- side's cost paid, the pairs' value returned). The partial index of 002 now also holds SharesSold rows.
DROP INDEX ledger_events_market_payments_idx;
CREATE INDEX ledger_events_market_payments_idx ON ledger_events ((data ->> 'marketId'), stream_id)
    WHERE type IN ('SharesBought', 'SharesSold', 'PairsRedeemed');
