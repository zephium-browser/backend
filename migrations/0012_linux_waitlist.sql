-- Independent opt-in list: no auth account, credits, provider content or raw IP.
CREATE TABLE linux_waitlist (
 id uuid PRIMARY KEY,
 email text NOT NULL UNIQUE CHECK (length(email) <= 254),
 created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 confirmation_hash text NOT NULL UNIQUE CHECK (length(confirmation_hash)=64),
 expires_at timestamptz NOT NULL,
 consent_version text NOT NULL CHECK (consent_version='linux-release-v1')
);
CREATE INDEX linux_waitlist_expiry_idx ON linux_waitlist(expires_at) WHERE confirmed_at IS NULL;
CREATE INDEX linux_waitlist_confirmed_idx ON linux_waitlist(confirmed_at,id) WHERE confirmed_at IS NOT NULL;
REVOKE ALL ON linux_waitlist FROM PUBLIC;
-- Admin access is granted separately after upgrading its explicit view allowlist.
CREATE VIEW admin_report_linux_waitlist AS
 SELECT id,email,created_at,confirmed_at FROM linux_waitlist;
REVOKE ALL ON admin_report_linux_waitlist FROM PUBLIC;
