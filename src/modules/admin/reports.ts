import { Buffer } from "node:buffer";
import type postgres from "postgres";
import { AppError } from "../../platform/errors";

import { reportLinuxWaitlist } from "./waitlist";

const CREDIT_UNITS = "10000";
const PAGE_SIZE = 50;
type Cursor = { created_at: string; id: string };

/** Monthly-equivalent subscription prices in minor units, keyed `plan:interval`. */
export type PlanPrices = Map<string, number>;
export type UserFilter = "" | "paying" | "deleting" | "unverified";
type PolicySubscription = { productId: string; plan: string; interval: "monthly" | "yearly" };
type Budgets = {
  scope: string;
  dailyUsdMicros?: string | null;
  totalUsdMicros?: string | null;
  freeDailyUsdMicros?: string | null;
} | null;

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

function encodeCursor(row: { created_at: string; id: string }) {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString(
    "base64url",
  );
}

/** Parses `pro:monthly=2000,max:monthly=10000` (minor units per billing interval). */
export function parsePlanPrices(value: string): PlanPrices {
  const prices: PlanPrices = new Map();
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const match = /^([a-z0-9_-]{1,40}):(monthly|yearly)=(\d{1,9})$/.exec(entry);
    if (!match) throw new Error("ADMIN_PLAN_PRICES entries must look like plan:monthly=2000");
    prices.set(`${match[1]}:${match[2]}`, Number(match[3]));
  }
  return prices;
}

/** Only safe reporting views are available to this connection's database role. */
export function createAdminReports(sql: postgres.Sql, prices: PlanPrices = new Map()) {
  async function snapshot<T>(read: (tx: postgres.TransactionSql) => Promise<T>) {
    return sql.begin("read only isolation level repeatable read", async (tx) => {
      await tx`SET LOCAL statement_timeout = '2000ms'`;
      await tx`SET LOCAL lock_timeout = '500ms'`;
      return read(tx);
    });
  }
  async function activePolicy(tx: postgres.TransactionSql) {
    const [policy] = await tx`SELECT revision,free_plan,subscriptions,budgets,cloud_enabled
      FROM admin_report_policy LIMIT 1`;
    return {
      revision: policy ? Number(policy.revision) : null,
      freePlan: (policy?.free_plan as string | null) ?? null,
      subscriptions: (policy?.subscriptions ?? []) as PolicySubscription[],
      budgets: (policy?.budgets ?? null) as Budgets,
    };
  }

  return {
    linuxWaitlist: (cursor?: string, pageSize = 200) => reportLinuxWaitlist(sql, cursor, pageSize),

    async overview(days: 1 | 7 | 30) {
      if (days !== 1 && days !== 7 && days !== 30) throw new AppError("invalid_request");
      return snapshot(async (tx) => {
        const [users] = await tx`SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE email_verified)::integer AS verified,
          count(*) FILTER (WHERE created_at >= now() - ${days} * interval '1 day')::integer AS new,
          count(*) FILTER (WHERE lifecycle = 'deleting')::integer AS deleting
          FROM admin_report_accounts`;
        const [usage] = await tx`SELECT count(*)::integer AS calls,
          count(*) FILTER (WHERE dispatched_at IS NOT NULL)::integer AS dispatched,
          count(*) FILTER (WHERE state = 'settled')::integer AS settled,
          count(*) FILTER (WHERE error_code IS NOT NULL AND state <> 'settled')::integer AS failed,
          count(*) FILTER (WHERE error_code = 'client_disconnected')::integer AS stopped,
          count(DISTINCT user_id)::integer AS active_users,
          coalesce(sum(charged),0)::text AS charged_units,
          coalesce(sum(provider_cost_usd_micros),0)::text AS provider_cost_usd_micros,
          count(*) FILTER (WHERE dispatched_at IS NOT NULL AND provider_cost_usd_micros IS NULL)::integer AS unknown_cost_calls
          FROM admin_report_requests WHERE created_at >= now() - ${days} * interval '1 day'`;
        const [billing] =
          await tx`SELECT active_subscriptions::integer,open_checkouts::integer,pending_jobs::integer
          FROM admin_report_billing`;
        const models = await tx`SELECT model_id,count(*)::integer AS calls,
          count(DISTINCT user_id)::integer AS users,
          count(*) FILTER (WHERE error_code IS NOT NULL AND state <> 'settled')::integer AS failed,
          coalesce(sum(charged),0)::text AS charged_units,
          coalesce(sum(provider_cost_usd_micros),0)::text AS provider_cost_usd_micros
          FROM admin_report_requests WHERE created_at >= now() - ${days} * interval '1 day'
          GROUP BY model_id ORDER BY calls DESC,model_id LIMIT 20`;
        const errors = await tx`SELECT error_code AS code,count(*)::integer AS count
          FROM admin_report_requests WHERE created_at >= now() - ${days} * interval '1 day'
          AND error_code IS NOT NULL AND error_code <> 'client_disconnected'
          GROUP BY error_code ORDER BY count DESC,error_code LIMIT 20`;
        const policy = await activePolicy(tx);
        const [clock] =
          await tx`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of,
          to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day`;
        if (!users || !usage || !billing || !clock) throw new Error("admin_report_unavailable");
        let budget = null;
        if (policy.budgets) {
          const scope = policy.budgets.scope;
          const keys = [
            `${scope}:total`,
            `${scope}:day:${clock.day}`,
            `${scope}:free:${clock.day}`,
          ];
          const rows = await tx`SELECT key,amount::text FROM admin_report_spend
            WHERE key IN ${tx(keys)}`;
          const spent = (key: string) => String(rows.find((row) => row.key === key)?.amount ?? "0");
          budget = {
            scope,
            day: String(clock.day),
            total: { spent: spent(keys[0] ?? ""), cap: policy.budgets.totalUsdMicros ?? null },
            daily: { spent: spent(keys[1] ?? ""), cap: policy.budgets.dailyUsdMicros ?? null },
            free_daily: {
              spent: spent(keys[2] ?? ""),
              cap: policy.budgets.freeDailyUsdMicros ?? null,
            },
          };
        }
        return {
          as_of: String(clock.as_of),
          days,
          policy_revision: policy.revision,
          users,
          usage,
          billing,
          models: [...models],
          errors: [...errors],
          budget,
          credit_units: CREDIT_UNITS,
        };
      });
    },

    /** Daily UTC series; empty days are present with zeros so charts keep their scale. */
    async activity(days: 30 | 90) {
      if (days !== 30 && days !== 90) throw new AppError("invalid_request");
      return snapshot(async (tx) => {
        const rows = await tx`WITH bounds AS (
            SELECT ((now() AT TIME ZONE 'UTC')::date - ${days - 1}::integer) AS first_day),
          start AS (SELECT (first_day::timestamp AT TIME ZONE 'UTC') AS at, first_day FROM bounds),
          series AS (SELECT generate_series(first_day::timestamp, (first_day + ${days - 1}::integer)::timestamp,
            interval '1 day')::date AS day FROM bounds),
          signups AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) AS n
            FROM admin_report_accounts WHERE created_at >= (SELECT at FROM start) GROUP BY 1),
          paid AS (SELECT (subscription_start AT TIME ZONE 'UTC')::date AS day,count(*) AS n
            FROM admin_report_billing_state WHERE subscription_start >= (SELECT at FROM start) GROUP BY 1),
          requests AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) AS calls,
            count(DISTINCT user_id) AS active_users,
            count(*) FILTER (WHERE error_code IS NOT NULL AND state <> 'settled') AS failed,
            count(*) FILTER (WHERE error_code = 'client_disconnected') AS stopped,
            coalesce(sum(charged),0) AS charged,coalesce(sum(provider_cost_usd_micros),0) AS cost
            FROM admin_report_requests WHERE created_at >= (SELECT at FROM start) GROUP BY 1)
          SELECT to_char(s.day,'YYYY-MM-DD') AS day,
            coalesce(g.n,0)::integer AS signups,coalesce(p.n,0)::integer AS new_paid,
            coalesce(r.calls,0)::integer AS calls,coalesce(r.active_users,0)::integer AS active_users,
            coalesce(r.failed,0)::integer AS failed,coalesce(r.stopped,0)::integer AS stopped,
            coalesce(r.charged,0)::text AS charged_units,coalesce(r.cost,0)::text AS provider_cost_usd_micros
          FROM series s LEFT JOIN signups g ON g.day=s.day LEFT JOIN paid p ON p.day=s.day
          LEFT JOIN requests r ON r.day=s.day ORDER BY s.day`;
        return { days, series: [...rows], credit_units: CREDIT_UNITS };
      });
    },

    /** Current paying state from reconciled subscriptions; not an accounting ledger. */
    async revenue() {
      return snapshot(async (tx) => {
        const policy = await activePolicy(tx);
        const products = await tx`SELECT product_id,
          count(*) FILTER (WHERE paying)::integer AS active,
          count(*) FILTER (WHERE paying AND cancel_at_period_end)::integer AS cancelling,
          count(*) FILTER (WHERE paying AND subscription_start >= now()-interval '30 days')::integer AS new_30d,
          count(*) FILTER (WHERE NOT paying AND paid_until >= now()-interval '30 days')::integer AS lapsed_30d
          FROM admin_report_billing_state WHERE product_id IS NOT NULL GROUP BY product_id`;
        const plans = new Map<
          string,
          {
            plan: string;
            interval: string;
            active: number;
            cancelling: number;
            new_30d: number;
            lapsed_30d: number;
            price_minor: number | null;
            mrr_minor: number | null;
          }
        >();
        for (const row of products) {
          const mapping = policy.subscriptions.find((item) => item.productId === row.product_id);
          const plan = mapping?.plan ?? "unknown";
          const interval = mapping?.interval ?? "unknown";
          const key = `${plan}:${interval}`;
          const current = plans.get(key) ?? {
            plan,
            interval,
            active: 0,
            cancelling: 0,
            new_30d: 0,
            lapsed_30d: 0,
            price_minor: prices.get(key) ?? null,
            mrr_minor: null,
          };
          current.active += Number(row.active);
          current.cancelling += Number(row.cancelling);
          current.new_30d += Number(row.new_30d);
          current.lapsed_30d += Number(row.lapsed_30d);
          plans.set(key, current);
        }
        let mrr: number | null = 0;
        for (const item of plans.values()) {
          if (item.price_minor === null) {
            if (item.active > 0) mrr = null;
            continue;
          }
          item.mrr_minor = Math.round(
            (item.active * item.price_minor) / (item.interval === "yearly" ? 12 : 1),
          );
          if (mrr !== null) mrr += item.mrr_minor;
        }
        const [topups] = await tx`SELECT count(*)::integer AS purchases,
          count(DISTINCT user_id)::integer AS buyers,coalesce(sum(amount),0)::text AS units
          FROM admin_report_grant_detail WHERE kind='topup' AND NOT revoked
          AND created_at >= now()-interval '30 days'`;
        const changes = await tx`SELECT direction,state,count(*)::integer AS count
          FROM admin_report_plan_changes WHERE created_at >= now()-interval '30 days'
          GROUP BY direction,state ORDER BY direction,state`;
        const items = [...plans.values()].sort((a, b) => b.active - a.active);
        const paying = items.reduce((sum, item) => sum + item.active, 0);
        return {
          currency: "USD",
          prices_configured: prices.size > 0,
          paying,
          mrr_minor: mrr,
          plans: items,
          topups_30d: topups,
          plan_changes_30d: [...changes],
          credit_units: CREDIT_UNITS,
        };
      });
    },

    async jobs() {
      return snapshot(async (tx) => {
        const rows = await tx`SELECT queue,pending::integer,retrying::integer,exhausted::integer,
          CASE WHEN oldest_due IS NULL THEN NULL
            ELSE greatest(0,extract(epoch FROM now()-oldest_due))::integer END AS oldest_due_seconds
          FROM admin_report_jobs`;
        return { queues: [...rows] };
      });
    },

    async users(q: string, cursor?: string, filter: UserFilter = "") {
      if (typeof q !== "string" || q.length > 320 || hasControl(q))
        throw new AppError("invalid_request");
      if (!["", "paying", "deleting", "unverified"].includes(filter))
        throw new AppError("invalid_request");
      const query = q.trim();
      const after = decodeCursor(cursor);
      return snapshot(async (tx) => {
        // Separate exact-match statements keep each on its index under generic plans.
        const match =
          query === ""
            ? tx``
            : query.includes("@")
              ? tx`AND lower(email) = ${query.toLowerCase()}`
              : tx`AND id = ${query}`;
        const filtered =
          filter === "paying"
            ? tx`AND subscription_status='active' AND paid_until > now()`
            : filter === "deleting"
              ? tx`AND lifecycle='deleting'`
              : filter === "unverified"
                ? tx`AND NOT email_verified`
                : tx``;
        const rows = await tx`SELECT id,email,name,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          email_verified,lifecycle,subscription_status,product_id,plan,
          to_char(paid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_until
          FROM admin_report_users WHERE true ${match} ${filtered}
          ${after ? tx`AND (created_at,id) < (${after.created_at}::timestamptz,${after.id})` : tx``}
          ORDER BY admin_report_users.created_at DESC,id DESC LIMIT ${PAGE_SIZE + 1}`;
        const items = [...rows.slice(0, PAGE_SIZE)];
        const last = items.at(-1);
        return {
          items,
          next_cursor:
            rows.length > PAGE_SIZE && last
              ? encodeCursor({ created_at: String(last.created_at), id: String(last.id) })
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
        // Session identifiers are not needed for read-only support and stay out of the console.
        const sessions = await tx`SELECT device,created_at,expires_at FROM admin_report_sessions
          WHERE user_id=${id} AND expires_at > now() ORDER BY created_at DESC LIMIT 50`;
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
        const [billing] =
          await tx`SELECT status,product_id,paid_until,period_start,subscription_start,
          cancel_at_period_end,reconciled_at,attempts,next_attempt,provider_touched,refresh_pending,paying
          FROM admin_report_billing_state WHERE user_id=${id}`;
        const grants = await tx`SELECT id,kind,plan_id,amount::text,spent::text,held::text,revoked,
          period_start,expires_at,created_at FROM admin_report_grant_detail
          WHERE user_id=${id} ORDER BY created_at DESC,id DESC LIMIT 100`;
        const planChanges = await tx`SELECT id,state,error_code,attempts,current_plan,target_plan,
          direction,estimated_amount_minor::text,currency,created_at,dispatched_at,finished_at
          FROM admin_report_plan_changes WHERE user_id=${id} ORDER BY created_at DESC LIMIT 20`;
        const checkouts = await tx`SELECT kind,product_id,created_at,expires_at
          FROM admin_report_checkouts WHERE user_id=${id} ORDER BY created_at DESC LIMIT 20`;
        if (!balance || !usage) throw new Error("admin_report_unavailable");
        const policy = await activePolicy(tx);
        const productName = (product: unknown) => {
          const mapping = policy.subscriptions.find((item) => item.productId === product);
          return mapping ? `${mapping.plan} ${mapping.interval}` : null;
        };
        return {
          user,
          sessions: [...sessions],
          balance,
          usage,
          requests: [...requests],
          billing: billing ? { ...billing, product: productName(billing.product_id) } : null,
          grants: [...grants],
          plan_changes: [...planChanges],
          checkouts: checkouts.map((row) => ({ ...row, product: productName(row.product_id) })),
          credit_units: CREDIT_UNITS,
        };
      });
    },

    async audit(cursor?: string) {
      const after = decodeCursor(cursor);
      return snapshot(async (tx) => {
        const rows = await tx`SELECT id::text,action,target_id,operator_email,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
          FROM admin_report_audit
          ${after ? tx`WHERE (created_at,id::text) < (${after.created_at}::timestamptz,${after.id})` : tx``}
          ORDER BY admin_report_audit.created_at DESC,id::text DESC LIMIT ${PAGE_SIZE + 1}`;
        const items = [...rows.slice(0, PAGE_SIZE)];
        const last = items.at(-1);
        return {
          items,
          next_cursor:
            rows.length > PAGE_SIZE && last
              ? encodeCursor({ created_at: String(last.created_at), id: String(last.id) })
              : null,
        };
      });
    },
  };
}
export type AdminReports = ReturnType<typeof createAdminReports>;
