-- Run as the database owner AFTER scripts/admin-migrate.ts. No passwords in this file.
-- Set fresh passwords with concealed psql \password prompts, then store them in the secret store.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zephium_admin_auth') THEN
 CREATE ROLE zephium_admin_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zephium_admin_report') THEN
 CREATE ROLE zephium_admin_report LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO zephium_admin_auth,zephium_admin_report',current_database()); END $$;
GRANT USAGE ON SCHEMA public TO zephium_admin_auth,zephium_admin_report;
GRANT SELECT,INSERT,UPDATE,DELETE ON admin_auth_user,admin_auth_session,admin_auth_account,admin_auth_verification,admin_auth_two_factor,admin_auth_throttle,admin_audit_event TO zephium_admin_auth;
GRANT SELECT ON admin_report_users,admin_report_sessions,admin_report_wallets,admin_report_grants,admin_report_requests,admin_report_billing,admin_report_budget TO zephium_admin_report;
ALTER ROLE zephium_admin_report SET default_transaction_read_only=on;
ALTER ROLE zephium_admin_report SET statement_timeout='2s';
ALTER ROLE zephium_admin_report SET lock_timeout='500ms';
ALTER ROLE zephium_admin_report CONNECTION LIMIT 4;
ALTER ROLE zephium_admin_auth CONNECTION LIMIT 4;
DO $$ BEGIN
 IF to_regclass('public.admin_report_linux_waitlist') IS NOT NULL THEN
  GRANT SELECT ON admin_report_linux_waitlist TO zephium_admin_report;
 END IF;
END $$;
