import { createHash } from "node:crypto";
import type { Database } from "../../platform/db";
import { AppError, operationalEvent } from "../../platform/errors";
import { type CloudPolicy, type Model, type Rates, requestDuration } from "../policy";
import { reserveBudget, settleBudget } from "./budget";
import { creditUnits, unitsPerUsd } from "./denomination";
import { accountContext, availableGrants, paidStateMaxAgeMs, type Tx } from "./grants";
import { charge, type Usage } from "./pricing";

const liveStates = ["preflight", "reserved", "running"];
const available = (grants: Record<string, unknown>[]) =>
  grants.reduce(
    (n, g) => n + BigInt(String(g.amount)) - BigInt(String(g.spent)) - BigInt(String(g.held)),
    0n,
  );
/** Wallet/grant locks must already be held. A temporary hold is not exhaustion. */
async function requireCredit(
  tx: Tx,
  userId: string,
  grants: Record<string, unknown>[],
  cost: bigint,
) {
  const spendable = available(grants);
  if (spendable >= cost) return;
  const held = grants.reduce((sum, grant) => sum + BigInt(String(grant.held)), 0n);
  if (held > 0n && spendable + held >= cost) {
    const [clock] = await tx`SELECT greatest(1,least(60,ceil(extract(epoch FROM
      min(CASE WHEN state='usage_unknown' THEN hold_until ELSE lease_until END)-clock_timestamp()))))::integer AS retry
      FROM cloud_request WHERE user_id=${userId} AND state IN ('reserved','running','usage_unknown')`;
    throw new AppError("credit_reservation_pending", 429, Number(clock?.retry ?? 30));
  }
  throw new AppError("insufficient_credits", 402);
}
async function bucket(
  tx: Tx,
  policy: CloudPolicy,
  provider: string,
  inputTokens: number,
  request: boolean,
) {
  const limits = policy.limits.providers[provider as Model["provider"]];
  if (!limits) throw new AppError("provider_not_configured", 503);
  await tx`INSERT INTO provider_bucket(provider,requests,tokens,updated_at) VALUES (${provider},${limits.requestsPerMinute},${limits.tokensPerSecond},now()) ON CONFLICT DO NOTHING`;
  const [row] = await tx`SELECT * FROM provider_bucket WHERE provider=${provider} FOR UPDATE`;
  const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
  const now = new Date(clock?.db_now);
  const seconds = Math.max(0, (now.getTime() - new Date(row?.updated_at).getTime()) / 1000);
  const requests = Math.min(
    limits.requestsPerMinute,
    Number(row?.requests) + (seconds * limits.requestsPerMinute) / 60,
  );
  const tokens = Math.min(
    limits.tokensPerSecond,
    Number(row?.tokens) + seconds * limits.tokensPerSecond,
  );
  if (requests < (request ? 1 : 0) || tokens < inputTokens)
    throw new AppError(
      "provider_rate_limited",
      429,
      Math.max(
        1,
        Math.ceil(
          Math.max(
            request ? ((1 - requests) * 60) / limits.requestsPerMinute : 0,
            (inputTokens - tokens) / limits.tokensPerSecond,
          ),
        ),
      ),
    );
  await tx`UPDATE provider_bucket SET requests=${requests - (request ? 1 : 0)},tokens=${tokens - inputTokens},updated_at=${now.toISOString()} WHERE provider=${provider}`;
}
export async function openRequest(
  db: Database,
  p: CloudPolicy,
  m: Model,
  userId: string,
  sessionId: string,
  clientKey: string,
  route: string,
) {
  if (!p.enabled) throw new AppError("cloud_disabled", 503);
  return await db.sql.begin(async (tx) => {
    const context = await accountContext(tx, userId, p, sessionId);
    if (!m.plans.includes(context.plan.id)) throw new AppError("plan_required", 403);
    const [old] =
      await tx`SELECT id,state,error_class,dispatched_at,reserved,charged,provider,model_id,route
      FROM cloud_request WHERE user_id=${userId} AND client_key=${clientKey}`;
    const retryable =
      old?.state === "released" &&
      old.dispatched_at === null &&
      BigInt(old.reserved) === 0n &&
      BigInt(old.charged) === 0n &&
      old.provider === m.provider &&
      old.model_id === m.id &&
      old.route === route &&
      ["credit_reservation_pending", "token_count_unavailable", "provider_rate_limited"].includes(
        old.error_class,
      );
    if (old && !retryable)
      throw new AppError(
        liveStates.includes(old.state) ? "request_in_progress" : "request_already_recorded",
        409,
      );
    await requireCredit(tx, userId, await availableGrants(tx, userId, context.plan.id), 1n);
    const key = createHash("sha256").update(`cloud-rpm:${userId}`).digest("hex");
    const [rate] =
      await tx`INSERT INTO abuse_bucket(key,count,expires_at) VALUES (${key},1,clock_timestamp()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN abuse_bucket.expires_at<=clock_timestamp() THEN 1 ELSE abuse_bucket.count+1 END,expires_at=CASE WHEN abuse_bucket.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '1 minute' ELSE abuse_bucket.expires_at END RETURNING count,expires_at`;
    if (Number(rate?.count) > context.plan.requestsPerMinute)
      throw new AppError(
        "rate_limited",
        429,
        Math.max(1, Math.ceil((new Date(rate?.expires_at).getTime() - Date.now()) / 1000)),
      );
    await bucket(tx, p, m.provider, 0, true);
    const [risk] =
      await tx`SELECT count(*)::integer AS total FROM cloud_request WHERE user_id=${userId} AND (state='usage_unknown' OR error_class='unconfirmed_usage_refunded') AND coalesce(reserved_at,started_at)>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    if (Number(risk?.total) >= p.limits.unconfirmedRequestsPerUserDay) {
      const retry = Math.ceil(
        (Date.UTC(
          new Date().getUTCFullYear(),
          new Date().getUTCMonth(),
          new Date().getUTCDate() + 1,
        ) -
          Date.now()) /
          1000,
      );
      throw new AppError("usage_confirmation_limited", 429, Math.max(1, retry));
    }
    // Per-account and provider waits happen before the brief global admission lock.
    await tx`SELECT pg_advisory_xact_lock(91843723)`;
    const [counts] =
      await tx`SELECT count(*)::integer AS total,count(*) FILTER(WHERE user_id=${userId})::integer AS own,count(*) FILTER(WHERE plan_id=${p.freePlan})::integer AS free FROM cloud_request WHERE state IN ('preflight','reserved','running') AND lease_until>clock_timestamp()`;
    if (
      Number(counts?.total) >= p.limits.globalConcurrent ||
      Number(counts?.own) >= context.plan.maxConcurrent ||
      (context.plan.id === p.freePlan &&
        p.limits.maxFreeConcurrent !== undefined &&
        Number(counts?.free) >= p.limits.maxFreeConcurrent)
    )
      throw new AppError("concurrency_limited", 429, 1);
    const id = crypto.randomUUID();
    const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
    const lease = new Date(new Date(clock?.db_now).getTime() + requestDuration(p, m) + 5000);
    if (retryable) {
      // Keep the rejected receipt and give the next attempt a new request ID. Reusing
      // an ID would let a delayed recovery task act on the newly admitted attempt.
      const [residue] =
        await tx`SELECT EXISTS(SELECT 1 FROM credit_allocation WHERE request_id=${old.id})
        OR EXISTS(SELECT 1 FROM cloud_cost_record WHERE request_id=${old.id}) AS present`;
      if (residue?.present) throw new AppError("request_already_recorded", 409);
      await tx`UPDATE cloud_request SET client_key=${`${clientKey}:${old.id}`} WHERE id=${old.id}`;
    }
    await tx`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,plan_id,policy_revision,price_snapshot,cost_rates,state,lease_until,hold_until)
      VALUES (${id},${userId},${sessionId},${clientKey},${m.provider},${m.id},${route},${context.plan.id},${p.revision},${JSON.stringify(m.rates)}::jsonb,${m.costRates ? JSON.stringify(m.costRates) : null}::jsonb,'preflight',${lease.toISOString()},${new Date(lease.getTime() + p.limits.unknownHoldSeconds * 1000).toISOString()})`;
    return { id, leaseUntil: lease, plan: context.plan.id };
  });
}
export async function reserveRequest(
  db: Database,
  p: CloudPolicy,
  m: Model,
  id: string,
  userId: string,
  sessionId: string,
  cost: bigint,
  inputTokens: number,
  providerCost?: bigint,
) {
  if (cost < 0n || cost > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppError("request_cost_limit", 400);
  await db.sql.begin(async (tx) => {
    const ctx = await accountContext(tx, userId, p, sessionId);
    if (!m.plans.includes(ctx.plan.id)) throw new AppError("plan_required", 403);
    const [request] =
      await tx`SELECT * FROM cloud_request WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
    if (request?.state !== "preflight" || new Date(request.lease_until) <= ctx.now)
      throw new AppError("request_expired", 409);
    const grants = await availableGrants(tx, userId, ctx.plan.id);
    await requireCredit(tx, userId, grants, cost);
    await bucket(tx, p, m.provider, inputTokens, false);
    // Provider bucket locking can cross a grant, subscription, or request expiry.
    const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
    const fresh = new Date(clock?.db_now);
    if (new Date(request.lease_until) <= fresh) throw new AppError("request_expired", 409);
    if (
      !p.selfHostedPlan &&
      ctx.plan.id !== p.freePlan &&
      (!ctx.account.paid_until ||
        new Date(ctx.account.paid_until) <= fresh ||
        !ctx.account.reconciled_at ||
        new Date(ctx.account.reconciled_at).getTime() <= fresh.getTime() - paidStateMaxAgeMs)
    )
      throw new AppError("request_expired", 409);
    let validGrants = grants.filter(
      (g) => !g.revoked && (!g.expires_at || new Date(g.expires_at) > fresh),
    );
    await requireCredit(tx, userId, validGrants, cost);
    if (p.limits.budgets) {
      if (
        providerCost === undefined ||
        providerCost < 0n ||
        providerCost > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new AppError("invalid_model_configuration", 503);
      let left = cost,
        freeUnits = 0n;
      for (const g of validGrants) {
        const spare = BigInt(g.amount) - BigInt(g.spent) - BigInt(g.held);
        const take = spare < left ? spare : left;
        if (take > 0n && ctx.plan.id === p.freePlan && g.kind !== "topup") freeUnits += take;
        left -= take;
        if (left === 0n) break;
      }
      const freeCost = cost === 0n ? 0n : (providerCost * freeUnits + cost - 1n) / cost;
      if (!(await reserveBudget(tx, p, id, providerCost, freeCost))) {
        validGrants = validGrants.filter((g) => g.kind === "topup");
        if (available(validGrants) < cost) {
          const [clock] =
            await tx`SELECT ceil(extract(epoch FROM ((date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC')-clock_timestamp()))::integer AS retry`;
          throw new AppError("free_usage_limit_reached", 429, Math.max(1, Number(clock?.retry)));
        }
        await reserveBudget(tx, p, id, providerCost, 0n);
      }
    }
    // Attribute spend to the UTC day after provider/budget waits, not preflight start.
    const [reservationClock] = await tx`SELECT clock_timestamp() AS db_now`;
    const reservationAt = new Date(reservationClock?.db_now).toISOString();
    const caps = [ctx.plan.dailyLimitUnits, ctx.wallet.daily_limit_units]
      .filter((x) => x !== null)
      .map((x) => BigInt(String(x)));
    if (caps.length) {
      const limit = caps.reduce((a, b) => (a < b ? a : b));
      const [day] =
        await tx`SELECT coalesce(sum(CASE WHEN state IN ('reserved','running','usage_unknown') OR error_class='unconfirmed_usage_refunded' THEN reserved ELSE charged END),0)::text AS total FROM cloud_request WHERE user_id=${userId} AND coalesce(reserved_at,started_at)>=date_trunc('day',${reservationAt}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      if (BigInt(day?.total ?? "0") + cost > limit) throw new AppError("daily_limit_reached", 402);
    }
    let remaining = cost;
    let purchased = 0n;
    for (const g of validGrants) {
      if (remaining === 0n) break;
      const spare = BigInt(g.amount) - BigInt(g.spent) - BigInt(g.held);
      const take = spare < remaining ? spare : remaining;
      if (take <= 0n) continue;
      await tx`UPDATE credit_grant SET held=held+${take.toString()} WHERE id=${g.id}`;
      await tx`INSERT INTO credit_allocation(request_id,grant_id,amount) VALUES (${id},${g.id},${take.toString()})`;
      remaining -= take;
      if (g.kind === "topup") purchased += take;
    }
    if (remaining !== 0n) throw new AppError("insufficient_credits", 402);
    await tx`UPDATE cloud_request SET state='reserved',funding_source=${purchased === 0n ? "allowance" : purchased === cost ? "purchased" : "mixed"},reserved=${cost.toString()},reserved_at=${reservationAt}::timestamptz WHERE id=${id}`;
  });
}
export async function markDispatched(db: Database, id: string, userId: string, sessionId: string) {
  await db.sql.begin(async (tx) => {
    // Follow account -> wallet -> request -> grants order used for admission/refunds.
    const [account] =
      await tx`SELECT u.lifecycle,u.email_verified,b.status,b.paid_until,b.reconciled_at,b.product_id
      FROM auth_user u JOIN billing_customer b ON b.user_id=u.id
      WHERE u.id=${userId} FOR SHARE OF u,b`;
    const [wallet] =
      await tx`SELECT suspended FROM credit_wallet WHERE user_id=${userId} FOR UPDATE`;
    const [request] =
      await tx`SELECT state,session_id,lease_until,reserved,policy_revision,model_id,provider
      FROM cloud_request WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
    if (request?.state !== "reserved" || request.session_id !== sessionId)
      throw new AppError("request_expired", 409);
    const allocations = await tx`SELECT a.amount,g.revoked,g.expires_at,g.kind,g.plan_id
      FROM credit_allocation a JOIN credit_grant g ON g.id=a.grant_id
      WHERE a.request_id=${id} AND g.user_id=${userId}
      ORDER BY g.expires_at ASC NULLS LAST,g.created_at,g.id FOR UPDATE OF g`;
    const [session] = await tx`SELECT expires_at FROM auth_session
      WHERE id=${sessionId} AND user_id=${userId} FOR SHARE`;
    // Shared activation lock needs no write privilege on policy tables.
    await tx`SELECT pg_advisory_xact_lock_shared(91843722)`;
    const [policyRow] = await tx`SELECT p.configuration,a.revision AS active_revision
      FROM cloud_policy p JOIN cloud_active_policy a ON a.singleton=true
      WHERE p.revision=${request.policy_revision}`;
    // Check the clock after every potentially blocking row lock.
    const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
    const now = new Date(clock?.db_now);
    const covered = allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount), 0n);
    const policy = policyRow?.configuration as CloudPolicy | undefined;
    const product = policy?.subscriptions.find(
      (subscription) => subscription.productId === account?.product_id,
    );
    const hasPaidGrant = allocations.some(
      (allocation) =>
        allocation.kind === "included" &&
        allocation.plan_id !== policy?.freePlan &&
        !policy?.selfHostedPlan,
    );
    const paidValid =
      !!product &&
      account?.status === "active" &&
      account.paid_until &&
      new Date(account.paid_until) > now &&
      account.reconciled_at &&
      new Date(account.reconciled_at).getTime() > now.getTime() - paidStateMaxAgeMs;
    const currentPlan =
      policy?.selfHostedPlan ?? (paidValid && product ? product.plan : policy?.freePlan);
    const model = policy?.models.find(
      (candidate) =>
        candidate.id === request.model_id &&
        candidate.provider === request.provider &&
        candidate.enabled,
    );
    if (
      account?.lifecycle !== "active" ||
      !account.email_verified ||
      !wallet ||
      wallet.suspended ||
      !session ||
      new Date(session.expires_at) <= now ||
      new Date(request.lease_until) <= now ||
      !policy ||
      policyRow?.active_revision !== request.policy_revision ||
      !currentPlan ||
      !model?.plans.includes(currentPlan) ||
      covered !== BigInt(request.reserved) ||
      allocations.some(
        (allocation) =>
          allocation.revoked ||
          (allocation.kind === "included" && allocation.plan_id !== currentPlan) ||
          (allocation.expires_at && new Date(allocation.expires_at) <= now),
      ) ||
      (hasPaidGrant && !paidValid)
    )
      throw new AppError("request_expired", 409);
    await tx`UPDATE cloud_request SET state='running',dispatched_at=clock_timestamp() WHERE id=${id} AND user_id=${userId}`;
  });
}
async function lockRequest(tx: Tx, id: string, userId: string) {
  // Same wallet -> request -> grants order for settlement, recovery and top-up reversal.
  const [wallet] = await tx`SELECT user_id FROM credit_wallet WHERE user_id=${userId} FOR UPDATE`;
  if (!wallet) return null;
  const [request] =
    await tx`SELECT * FROM cloud_request WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
  return request ?? null;
}
async function settleAllocations(tx: Tx, id: string, amount: bigint) {
  const allocations =
    await tx`SELECT a.amount,g.id,g.revoked FROM credit_allocation a JOIN credit_grant g ON g.id=a.grant_id WHERE a.request_id=${id} ORDER BY g.expires_at ASC NULLS LAST,g.created_at,g.id FOR UPDATE OF g`;
  let remaining = amount,
    charged = 0n;
  for (const a of allocations) {
    const held = BigInt(a.amount);
    const debit = a.revoked ? 0n : held < remaining ? held : remaining;
    await tx`UPDATE credit_grant SET held=held-${held.toString()},spent=spent+${debit.toString()} WHERE id=${a.id}`;
    charged += debit;
    remaining -= debit;
  }
  await tx`DELETE FROM credit_allocation WHERE request_id=${id}`;
  return charged;
}
export async function settleRequest(
  db: Database,
  id: string,
  userId: string,
  usage: Usage,
  status: number,
  upstreamId: string | null,
  estimate?: { errorClass: string },
) {
  await db.sql.begin(async (tx) => {
    const r = await lockRequest(tx, id, userId);
    if (!r || !["running", "usage_unknown"].includes(r.state)) return;
    const actual = charge(usage, r.price_snapshot as Rates);
    // A successful duration tariff bills the customer, but is not authoritative provider token cost.
    if (r.cost_rates && usage.audioMilliseconds === undefined)
      await settleBudget(
        tx,
        id,
        // Estimates keep a 2x output margin for unstreamed reasoning, bounded by the hold.
        charge(estimate ? { ...usage, output: usage.output * 2 } : usage, r.cost_rates as Rates),
        !!estimate,
      );
    const reserved = BigInt(r.reserved);
    const charged = await settleAllocations(tx, id, actual < reserved ? actual : reserved);
    const upstream = upstreamId && /^[A-Za-z0-9._:-]{1,200}$/.test(upstreamId) ? upstreamId : null;
    const errorClass = estimate?.errorClass ?? (actual > reserved ? "reservation_exceeded" : null);
    await tx`UPDATE cloud_request SET state='settled',charged=${charged.toString()},actual_cost=${actual.toString()},usage=${JSON.stringify(usage)}::jsonb,upstream_status=${status},upstream_request_id=${upstream},finished_at=now(),error_class=${errorClass} WHERE id=${id}`;
    if (actual > reserved && !estimate) operationalEvent("cloud_reservation_exceeded");
    const [customer] = await tx`SELECT polar_id FROM billing_customer WHERE user_id=${userId}`;
    if (customer?.polar_id) {
      const payload = {
        externalId: id,
        name: "zephium_ai_usage",
        externalCustomerId: userId,
        timestamp: new Date(r.started_at).toISOString(),
        metadata: {
          model: r.model_id,
          provider: r.provider,
          policy_revision: r.policy_revision,
          charged_units: Number(charged),
          ...usage,
        },
      };
      await tx`INSERT INTO cloud_outbox(request_id,payload) VALUES (${id},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING`;
    }
  });
}
export async function releaseRequest(db: Database, id: string, userId: string, errorClass: string) {
  await db.sql.begin(async (tx) => {
    const r = await lockRequest(tx, id, userId);
    if (!r || ["settled", "released"].includes(r.state)) return;
    await settleAllocations(tx, id, 0n);
    if (!r.dispatched_at || errorClass === "provider_rejected") await settleBudget(tx, id, 0n);
    await tx`UPDATE cloud_request SET state='released',error_class=${errorClass},finished_at=now() WHERE id=${id}`;
  });
}
export async function unknownRequest(db: Database, id: string, userId: string, errorClass: string) {
  await db.sql`UPDATE cloud_request SET state='usage_unknown',error_class=${errorClass},finished_at=now() WHERE id=${id} AND user_id=${userId} AND state IN ('running','reserved')`;
}
export async function recoverRequests(db: Database) {
  const expired =
    await db.sql`SELECT id,user_id,state,hold_until FROM cloud_request WHERE (state IN ('preflight','reserved','running') AND lease_until<now()) OR (state='usage_unknown' AND hold_until<now()) ORDER BY started_at LIMIT 100`;
  // One request that cannot be recovered must not block recovery of the others.
  let failed = 0;
  for (const r of expired) {
    try {
      if (r.state === "preflight" || r.state === "reserved")
        await releaseRequest(db, r.id, r.user_id, "not_dispatched");
      else if (r.state === "running" && new Date(r.hold_until) > new Date())
        await unknownRequest(db, r.id, r.user_id, "worker_recovery");
      else await releaseRequest(db, r.id, r.user_id, "unconfirmed_usage_refunded");
    } catch {
      failed++;
    }
  }
  if (failed) throw new Error("Request recovery incomplete");
}
export async function usageSummary(db: Database, p: CloudPolicy, userId: string, readOnly = false) {
  return await db.sql.begin(async (tx) => {
    const ctx = await accountContext(tx, userId, p, undefined, readOnly);
    const grants = await availableGrants(tx, userId, ctx.plan.id);
    const total = grants.reduce((n, g) => n + BigInt(g.amount) - BigInt(g.spent), 0n);
    const free = available(grants);
    const [today] =
      await tx`SELECT coalesce(sum(charged),0)::text AS amount FROM cloud_request WHERE user_id=${userId} AND coalesce(reserved_at,started_at)>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const byModel =
      await tx`SELECT model_id,coalesce(sum(charged),0)::text AS units,count(*)::integer AS requests FROM cloud_request WHERE user_id=${userId} AND started_at>=${ctx.period.start.toISOString()} GROUP BY model_id ORDER BY model_id LIMIT 100`;
    const included = grants.find((g) => g.kind === "included");
    const budget = p.limits.budgets;
    let freePaused = false;
    if (budget?.freeDailyUsdMicros !== null && budget?.freeDailyUsdMicros !== undefined) {
      const [bucket] =
        await tx`SELECT amount FROM cloud_spend_bucket WHERE key=${budget.scope} || ':free:' || to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD')`;
      freePaused = BigInt(bucket?.amount ?? "0") >= BigInt(budget.freeDailyUsdMicros);
    }
    const purchased = grants
      .filter((g) => g.kind === "topup")
      .reduce((n, g) => n + BigInt(g.amount) - BigInt(g.spent) - BigInt(g.held), 0n);
    return {
      schema_version: 1,
      cloud_enabled: p.enabled,
      policy_revision: p.revision,
      plan: ctx.plan.id,
      unit_scale: 1000000,
      credit_units: creditUnits,
      credits_remaining: free.toString(),
      reserved_units: (total - free).toString(),
      period_end: ctx.period.end?.toISOString() ?? null,
      free_usage_paused: ctx.plan.id === p.freePlan && freePaused,
      purchased_usage_available: grants.some(
        (g) => g.kind === "topup" && BigInt(g.amount) > BigInt(g.spent) + BigInt(g.held),
      ),
      spent_today: String(today?.amount ?? "0"),
      daily_limit_units:
        [ctx.wallet.daily_limit_units, ctx.plan.dailyLimitUnits]
          .filter((v) => v !== null)
          .map((v) => BigInt(String(v)))
          .reduce<bigint | null>((a, b) => (a === null || b < a ? b : a), null)
          ?.toString() ?? null,
      by_model: byModel,
      allowance: {
        renews: ctx.plan.cycle.kind !== "once",
        expires_at: included?.expires_at ? new Date(included.expires_at).toISOString() : null,
        total_units: String(included?.amount ?? "0"),
        used_units: String(included?.spent ?? "0"),
        reserved_units: String(included?.held ?? "0"),
      },
      bonus_remaining: grants
        .filter((g) => g.kind === "welcome")
        .reduce((n, g) => n + BigInt(g.amount) - BigInt(g.spent) - BigInt(g.held), 0n)
        .toString(),
      bonus_expires_at: grants.find((g) => g.kind === "welcome")?.expires_at
        ? new Date(grants.find((g) => g.kind === "welcome")?.expires_at).toISOString()
        : null,
      purchased_remaining: purchased.toString(),
      purchased_balance:
        p.creditCurrency === "USD"
          ? {
              currency: "USD",
              amount: `${purchased / unitsPerUsd}.${(purchased % unitsPerUsd).toString().padStart(6, "0")}`,
            }
          : null,
    };
  });
}
export async function setDailyLimit(
  db: Database,
  p: CloudPolicy,
  userId: string,
  limit: string | null,
) {
  await db.sql.begin(async (tx) => {
    const ctx = await accountContext(tx, userId, p);
    if (
      limit !== null &&
      ctx.plan.dailyLimitUnits !== null &&
      BigInt(limit) > BigInt(ctx.plan.dailyLimitUnits)
    )
      throw new AppError("limit_exceeds_plan");
    await tx`UPDATE credit_wallet SET daily_limit_units=${limit} WHERE user_id=${userId}`;
  });
}
