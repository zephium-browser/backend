import { Buffer } from "node:buffer";
import type postgres from "postgres";
import { AppError } from "../../platform/errors";

import { reportLinuxWaitlist } from "./waitlist";

const CREDIT_UNITS = "10000";
const PAGE_SIZE = 50;
type Cursor = { created_at: string; id: string };

function hasControl(value: string) {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !hasControl(value);
}

function decodeCursor(value: unknown): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const pair = JSON.parse(bytes.toString("utf8"));
    if (
      Object.keys(pair).sort().join(",") !== "created_at,id" ||
      !validId(pair.id) ||
      typeof pair.created_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(pair.created_at) ||
      pair.created_at.startsWith("0000-") ||
      !Number.isFinite(Date.parse(pair.created_at)) ||
      new Date(pair.created_at).toISOString().slice(0, 19) !== pair.created_at.slice(0, 19)
    )
      throw new Error();
    return pair;
  } catch {
    throw new AppError("invalid_request");
  }
}

/** Only safe reporting views are available to this connection's database role. */
export function createAdminReports(sql: postgres.Sql) {
  async function snapshot<T>(read: (tx: postgres.TransactionSql) => Promise<T>) {
    return sql.begin("read only isolation level repeatable read", async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`;
      await tx`SET LOCAL lock_timeout = '500ms'`;
      return read(tx);
    });
  }

  return {
    linuxWaitlist: (cursor?: string) => reportLinuxWaitlist(sql, cursor),
    async overview(days: 1 | 7 | 30) {
      if (days !== 1 && days !== 7 && days !== 30) throw new AppError("invalid_request");
      return snapshot(async (tx) => {
        const [users] = await tx`SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE email_verified)::integer AS verified,
          count(*) FILTER (WHERE created_at >= now() - ${days} * interval '1 day')::integer AS new
          FROM admin_report_users`;
        const [usage] = await tx`SELECT count(*)::integer AS calls,
          count(*) FILTER (WHERE dispatched_at IS NOT NULL)::integer AS dispatched,
          count(*) FILTER (WHERE state = 'settled')::integer AS settled,
          count(*) FILTER (WHERE error_code IS NOT NULL)::integer AS failed,
          count(DISTINCT user_id)::integer AS active_users,
          coalesce(sum(charged),0)::text AS charged_units,
          coalesce(sum(provider_cost_usd_micros),0)::text AS provider_cost_usd_micros,
          count(*) FILTER (WHERE dispatched_at IS NOT NULL AND provider_cost_usd_micros IS NULL)::integer AS unknown_cost_calls
          FROM admin_report_requests WHERE created_at >= now() - ${days} * interval '1 day'`;
        const [billing] =
          await tx`SELECT active_subscriptions::integer,open_checkouts::integer,pending_jobs::integer
          FROM admin_report_billing`;
        const models = await tx`SELECT model_id,count(*)::integer AS calls,
          coalesce(sum(charged),0)::text AS charged_units,
          coalesce(sum(provider_cost_usd_micros),0)::text AS provider_cost_usd_micros
          FROM admin_report_requests WHERE created_at >= now() - ${days} * interval '1 day'
          GROUP BY model_id ORDER BY calls DESC,model_id LIMIT 20`;
        const errors = await tx`SELECT error_code AS code,count(*)::integer AS count
          FROM admin_report_requests WHERE created_at >= now() - ${days} * interval '1 day' AND error_code IS NOT NULL
          GROUP BY error_code ORDER BY count DESC,error_code LIMIT 20`;
        const budget =
          await tx`SELECT key,spent::text,reserved::text FROM admin_report_budget ORDER BY key LIMIT 100`;
        const [clock] =
          await tx`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`;
        if (!users || !usage || !billing || !clock) throw new Error("admin_report_unavailable");
        return {
          as_of: String(clock?.as_of),
          days,
          users,
          usage,
          billing,
          models: [...models],
          errors: [...errors],
          budget: [...budget],
          credit_units: CREDIT_UNITS,
        };
      });
    },

    async users(q: string, cursor?: string) {
      if (typeof q !== "string" || q.length > 320 || hasControl(q))
        throw new AppError("invalid_request");
      const query = q.trim();
      const after = decodeCursor(cursor);
      return snapshot(async (tx) => {
        const rows = await tx`SELECT id,email,name,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          email_verified,lifecycle,subscription_status,product_id,plan,
          to_char(paid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_until
          FROM admin_report_users
          WHERE (${query} = '' OR lower(email) = ${query.toLowerCase()} OR id = ${query})
          ${after ? tx`AND (created_at,id) < (${after.created_at}::timestamptz,${after.id})` : tx``}
          ORDER BY admin_report_users.created_at DESC,id DESC LIMIT ${PAGE_SIZE + 1}`;
        const items = [...rows.slice(0, PAGE_SIZE)];
        const last = items.at(-1);
        return {
          items,
          next_cursor:
            rows.length > PAGE_SIZE && last
              ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString(
                  "base64url",
                )
              : null,
        };
      });
    },

    async user(id: string) {
      if (!validId(id)) throw new AppError("invalid_request");
      return snapshot(async (tx) => {
        const [user] = await tx`SELECT id,email,name,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          email_verified,lifecycle,subscription_status,product_id,plan,
          to_char(paid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_until
          FROM admin_report_users WHERE id=${id}`;
        if (!user) throw new AppError("not_found", 404);
        const sessions = await tx`SELECT id,device,created_at,expires_at FROM admin_report_sessions
          WHERE user_id=${id} AND expires_at > now() ORDER BY created_at DESC,id DESC LIMIT 50`;
        const [balance] = await tx`SELECT
          coalesce((SELECT sum(amount-spent-held) FROM admin_report_grants
            WHERE user_id=${id} AND NOT revoked AND (expires_at IS NULL OR expires_at > now())),0)::text AS remaining_units,
          coalesce((SELECT sum(held) FROM admin_report_grants
            WHERE user_id=${id}),0)::text AS reserved_units,
          coalesce((SELECT suspended FROM admin_report_wallets WHERE user_id=${id}),false) AS suspended`;
        const [usage] =
          await tx`SELECT count(*)::integer AS calls,coalesce(sum(charged),0)::text AS charged_units,
          coalesce(sum(provider_cost_usd_micros),0)::text AS provider_cost_usd_micros,
          count(*) FILTER (WHERE dispatched_at IS NOT NULL AND provider_cost_usd_micros IS NULL)::integer AS unknown_cost_calls
          FROM admin_report_requests WHERE user_id=${id} AND created_at >= now()-interval '30 days'`;
        const requests = await tx`SELECT id,model_id,state,error_code,charged::text,created_at
          FROM admin_report_requests WHERE user_id=${id} AND created_at >= now()-interval '30 days'
          ORDER BY created_at DESC,id DESC LIMIT 50`;
        if (!balance || !usage) throw new Error("admin_report_unavailable");
        return {
          user,
          sessions: [...sessions],
          balance,
          usage,
          requests: [...requests],
          credit_units: CREDIT_UNITS,
        };
      });
    },
  };
}
