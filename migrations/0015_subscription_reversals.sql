-- Refunds and lost disputes on a subscription order end that paid period's access.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
ALTER TABLE billing_order_reversal ADD COLUMN subscription_id text, ADD COLUMN order_created_at timestamptz;
