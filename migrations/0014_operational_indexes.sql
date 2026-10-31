-- Hot-path indexes for reconciliation polling and bounded expiry cleanup.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='120s';
CREATE INDEX billing_customer_due_idx ON billing_customer(next_attempt)
 WHERE provider_touched;
CREATE INDEX auth_session_expiry_idx ON auth_session(expires_at);
CREATE INDEX auth_verification_expiry_idx ON auth_verification(expires_at);
