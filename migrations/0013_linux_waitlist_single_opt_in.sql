-- Submission consent is distinct from verified mailbox ownership.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
ALTER TABLE linux_waitlist ADD COLUMN subscribed_at timestamptz;
ALTER TABLE linux_waitlist ALTER COLUMN confirmation_hash DROP NOT NULL;
ALTER TABLE linux_waitlist ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE linux_waitlist DROP CONSTRAINT linux_waitlist_consent_version_check;
ALTER TABLE linux_waitlist ADD CONSTRAINT linux_waitlist_consent_version_check
 CHECK(consent_version IN ('linux-release-v1','linux-release-single-opt-in-v1'));
-- Do not silently enroll addresses that only requested the old confirmation email.
UPDATE linux_waitlist SET subscribed_at=confirmed_at WHERE confirmed_at IS NOT NULL;
CREATE INDEX linux_waitlist_subscribed_idx ON linux_waitlist(subscribed_at,id)
 WHERE subscribed_at IS NOT NULL;
CREATE OR REPLACE VIEW admin_report_linux_waitlist AS
 SELECT id,email,created_at,confirmed_at,subscribed_at FROM linux_waitlist;
