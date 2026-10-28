import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./auth-schema";

export function createAdminDatabase(config: { ADMIN_AUTH_DATABASE_URL: string }) {
  const sql = postgres(config.ADMIN_AUTH_DATABASE_URL, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    max_lifetime: 1800,
    connection: {
      statement_timeout: 3000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
    },
    onnotice: () => {},
  });
  return { sql, orm: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
export function createReportDatabase(url: string) {
  return postgres(url, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    max_lifetime: 1800,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: 2000,
      lock_timeout: 500,
      idle_in_transaction_session_timeout: 5000,
    },
    onnotice: () => {},
  });
}

/** Refuse powerful or mixed credentials before exposing the admin listener. */
export async function assertAdminDatabasePrivileges(
  auth: postgres.Sql,
  reports: postgres.Sql,
): Promise<void> {
  const probe = (sql: postgres.Sql) => sql`SELECT current_user AS name,
    r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls AS powerful,
    has_schema_privilege(current_user,'public','CREATE') AS schema_write,
    has_table_privilege(current_user,'auth_session','SELECT') AS customer_tokens,
    has_table_privilege(current_user,'auth_verification','SELECT') AS customer_codes,
    has_table_privilege(current_user,'admin_auth_session','SELECT') AS admin_tokens,
    has_table_privilege(current_user,'admin_auth_user','INSERT') AS auth_write,
    has_table_privilege(current_user,'admin_report_users','SELECT') AS reports_read,
    has_table_privilege(current_user,'auth_user','UPDATE') AS customer_write
    FROM pg_roles r WHERE r.rolname=current_user`;
  const [[a], [b]] = await Promise.all([probe(auth), probe(reports)]);
  if (
    !a ||
    !b ||
    a.name === b.name ||
    [a, b].some(
      (x) =>
        x.powerful || x.schema_write || x.customer_tokens || x.customer_codes || x.customer_write,
    ) ||
    !a.admin_tokens ||
    !a.auth_write ||
    a.reports_read ||
    b.admin_tokens ||
    b.auth_write ||
    !b.reports_read
  )
    throw new Error("Admin database roles do not meet least-privilege requirements");
  const allowedAuth = [
    "admin_auth_user",
    "admin_auth_session",
    "admin_auth_account",
    "admin_auth_verification",
    "admin_auth_two_factor",
    "admin_auth_throttle",
    "admin_audit_event",
  ];
  const allowedReports = [
    "admin_report_users",
    "admin_report_sessions",
    "admin_report_wallets",
    "admin_report_grants",
    "admin_report_requests",
    "admin_report_billing",
    "admin_report_budget",
    "admin_report_linux_waitlist",
  ];
  for (const [connection, allowed] of [
    [auth, allowedAuth],
    [reports, allowedReports],
  ] as const) {
    const [extra] =
      await connection`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p') AND NOT(c.relname=ANY(${connection.array(allowed)}::text[]))
      AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS allowed`;
    if (extra?.allowed)
      throw new Error("Admin role can access tables outside its approved projection");
  }
  const [write] =
    await reports`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(${reports.array(allowedReports)}::text[])
      AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS allowed`;
  if (write?.allowed) throw new Error("Admin report role must have SELECT-only grants");
}
