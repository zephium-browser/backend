-- Read-only projections for revenue, activity, job health, budgets, per-user billing and audit.
-- Explicit columns only: no tokens, OTPs, provider payloads, checkout URLs or avatar bytes.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';

ALTER TABLE admin_audit_event DROP CONSTRAINT admin_audit_event_action_check;
ALTER TABLE admin_audit_event ADD CONSTRAINT admin_audit_event_action_check CHECK(action IN (
 'overview','users','user','search','activity','revenue','jobs','waitlist','waitlist_export','audit'));

-- Cheap account projection for counts and daily signups (admin_report_users resolves plans per row).
CREATE VIEW admin_report_accounts AS
 SELECT id,created_at,email_verified,lifecycle FROM auth_user;

-- Active policy fields an operator needs to interpret reports. Policy holds no credentials.
CREATE VIEW admin_report_policy AS
 SELECT p.revision,p.configuration->>'freePlan' AS free_plan,
 coalesce(p.configuration->'subscriptions','[]'::jsonb) AS subscriptions,
 coalesce(p.configuration->'topups','[]'::jsonb) AS topups,
 p.configuration->'limits'->'budgets' AS budgets,
 (p.configuration->>'enabled')::boolean AS cloud_enabled
 FROM cloud_policy p JOIN cloud_active_policy a ON a.revision=p.revision WHERE a.singleton=true;

CREATE VIEW admin_report_billing_state AS
 SELECT user_id,status,product_id,paid_until,period_start,subscription_start,cancel_at_period_end,
 reconciled_at,attempts,next_attempt,provider_touched,requested>processed AS refresh_pending,
 (status='active' AND paid_until>now()) AS paying
 FROM billing_customer;

CREATE VIEW admin_report_plan_changes AS
 SELECT id,user_id,state,error_code,attempts,created_at,dispatched_at,finished_at,
 quote->>'current_plan' AS current_plan,quote->>'target_plan' AS target_plan,quote->>'direction' AS direction,
 (quote->>'estimated_prorated_amount_minor')::bigint AS estimated_amount_minor,quote->>'currency' AS currency
 FROM billing_plan_change WHERE state<>'quoted';

CREATE VIEW admin_report_checkouts AS
 SELECT user_id,kind,product_id,created_at,expires_at FROM billing_checkout;

CREATE VIEW admin_report_grant_detail AS
 SELECT id,user_id,kind,plan_id,amount,spent,held,revoked,period_start,expires_at,created_at FROM credit_grant;

-- Current deployment exposure per budget key (scope:total, scope:day:D, scope:free:D).
CREATE VIEW admin_report_spend AS SELECT key,amount FROM cloud_spend_bucket;

-- One row per durable queue. "exhausted" rows keep retrying hourly and raise worker alerts.
CREATE VIEW admin_report_jobs AS
 SELECT 'subscription_sync'::text AS queue,
  count(*) FILTER(WHERE requested>processed) AS pending,
  count(*) FILTER(WHERE attempts BETWEEN 1 AND 9) AS retrying,
  count(*) FILTER(WHERE attempts>=10) AS exhausted,
  min(next_attempt) FILTER(WHERE requested>processed OR attempts>0) AS oldest_due
 FROM billing_customer
 UNION ALL
 SELECT 'orders',count(*) FILTER(WHERE requested>processed),
  count(*) FILTER(WHERE requested>processed AND attempts BETWEEN 1 AND 9),
  count(*) FILTER(WHERE requested>processed AND attempts>=10),
  min(next_attempt) FILTER(WHERE requested>processed)
 FROM billing_order_job
 UNION ALL
 SELECT 'billing_contacts',count(*) FILTER(WHERE requested>processed),
  count(*) FILTER(WHERE requested>processed AND attempts BETWEEN 1 AND 9),
  count(*) FILTER(WHERE requested>processed AND attempts>=10),
  min(next_attempt) FILTER(WHERE requested>processed)
 FROM billing_contact_job
 UNION ALL
 SELECT 'plan_changes',count(*),count(*) FILTER(WHERE attempts BETWEEN 1 AND 9),
  count(*) FILTER(WHERE attempts>=10),min(next_attempt)
 FROM billing_plan_change WHERE state IN ('queued','executing','uncertain')
 UNION ALL
 SELECT 'usage_export',count(*),count(*) FILTER(WHERE attempts BETWEEN 1 AND 9),
  count(*) FILTER(WHERE attempts>=10),min(next_attempt)
 FROM cloud_outbox WHERE delivered_at IS NULL
 UNION ALL
 SELECT 'unconfirmed_usage',count(*),0,0,min(hold_until)
 FROM cloud_request WHERE state='usage_unknown'
 UNION ALL
 SELECT 'account_deletion',count(*),0,0,min(d.requested_at)
 FROM auth_user u LEFT JOIN account_deletion d ON d.user_id=u.id WHERE u.lifecycle='deleting';

CREATE VIEW admin_report_audit AS
 SELECT e.id,e.action,e.target_id,e.created_at,o.email AS operator_email
 FROM admin_audit_event e LEFT JOIN admin_auth_user o ON o.id=e.operator_id;

REVOKE ALL ON admin_report_accounts,admin_report_policy,admin_report_billing_state,admin_report_plan_changes,
 admin_report_checkouts,admin_report_grant_detail,admin_report_spend,admin_report_jobs,admin_report_audit FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zephium_app') THEN
  REVOKE ALL ON admin_report_accounts,admin_report_policy,admin_report_billing_state,admin_report_plan_changes,
   admin_report_checkouts,admin_report_grant_detail,admin_report_spend,admin_report_jobs,admin_report_audit FROM zephium_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zephium_admin_report') THEN
  GRANT SELECT ON admin_report_accounts,admin_report_policy,admin_report_billing_state,admin_report_plan_changes,
   admin_report_checkouts,admin_report_grant_detail,admin_report_spend,admin_report_jobs,admin_report_audit
   TO zephium_admin_report;
 END IF;
END $$;
