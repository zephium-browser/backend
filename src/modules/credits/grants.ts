import type { TransactionSql } from "postgres";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import {
  type GrantEligibility,
  lockGrantEligibility,
  markFreePeriod,
  markSignupClaimed,
  markWelcomeClaimed,
  setFreeAnchor,
} from "../identity";
import { type CloudPolicy, cycleAt } from "../policy";
export type Tx = TransactionSql;

/**
 * Paid access needs a recent provider reconciliation. The window tolerates a
 * multi-hour Polar or worker outage (which alerts) without silently moving every
 * paying customer to the free plan, while still expiring unverifiable access.
 */
export const paidStateMaxAgeMs = 72 * 3600_000;
export async function accountContext(
  tx: Tx,
  userId: string,
  policy: CloudPolicy,
  sessionId?: string,
  readOnly = false,
) {
  const [active] = await tx`SELECT revision FROM cloud_active_policy WHERE singleton=true`;
  if (active?.revision !== policy.revision) throw new AppError("cloud_policy_changed", 503);
  const [account] =
    await tx`SELECT u.email_verified,u.lifecycle,u.created_at,u.eligibility_key,b.status,b.paid_until,b.period_start,b.subscription_start,b.product_id,b.subscription_id,b.reconciled_at
    FROM auth_user u JOIN billing_customer b ON b.user_id=u.id WHERE u.id=${userId} FOR SHARE OF b,u`;
  if (account?.lifecycle !== "active" || !account.email_verified)
    throw new AppError("account_unavailable", 403);
  await tx`INSERT INTO credit_wallet(user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  const [wallet] = await tx`SELECT * FROM credit_wallet WHERE user_id=${userId} FOR UPDATE`;
  if (!wallet || (wallet.suspended && !readOnly))
    throw new AppError("billing_review_required", 403);
  // PostgreSQL now() is fixed at BEGIN; eligibility must use the clock after lock waits.
  const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
  const now = new Date(clock?.db_now);
  if (sessionId) {
    const [session] =
      await tx`SELECT id FROM auth_session WHERE id=${sessionId} AND user_id=${userId} AND expires_at>${now.toISOString()}::timestamptz`;
    if (!session) throw new AppError("unauthorized", 401);
  }
  const product = policy.subscriptions.find((p) => p.productId === account.product_id);
  const paid =
    account.status === "active" &&
    account.paid_until &&
    new Date(account.paid_until) > now &&
    account.reconciled_at &&
    new Date(account.reconciled_at).getTime() > now.getTime() - paidStateMaxAgeMs;
  const plan = policy.plans.find(
    (p) => p.id === (policy.selfHostedPlan ?? (paid && product ? product.plan : policy.freePlan)),
  );
  if (!plan) throw new AppError("plan_not_configured", 503);
  let eligibility: GrantEligibility | undefined;
  if (account.eligibility_key)
    eligibility = await lockGrantEligibility(tx, account.eligibility_key);
  if (policy.enabled && !readOnly && !wallet.welcomed_at) {
    wallet.anchor = eligibility?.free_anchor ?? now.toISOString();
    if (BigInt(policy.welcomeUnits) > 0n && !eligibility?.welcome_claimed_at) {
      await grant(
        tx,
        userId,
        "welcome",
        "welcome",
        policy.revision,
        null,
        policy.welcomeUnits,
        policy.welcomeExpiresDays === null
          ? null
          : new Date(now.getTime() + policy.welcomeExpiresDays * 86400000),
      );
      if (eligibility) {
        await markWelcomeClaimed(tx, account.eligibility_key, now);
        eligibility.welcome_claimed_at = now.toISOString();
      }
    }
    await tx`UPDATE credit_wallet SET welcomed_at=${now.toISOString()}::timestamptz,anchor=${new Date(wallet.anchor).toISOString()}::timestamptz WHERE user_id=${userId}`;
    if (eligibility && !eligibility.free_anchor) {
      await setFreeAnchor(tx, account.eligibility_key, now);
      eligibility.free_anchor = now.toISOString();
    }
  }
  if (plan.cycle.kind === "once") {
    const [existing] =
      await tx`SELECT * FROM credit_grant WHERE user_id=${userId} AND grant_key=${`signup:${plan.id}`}`;
    const sharedSignup = plan.id === policy.freePlan;
    if (
      policy.enabled &&
      !readOnly &&
      !existing &&
      (!sharedSignup || !eligibility?.signup_claimed_at)
    ) {
      await grant(
        tx,
        userId,
        `signup:${plan.id}`,
        "included",
        policy.revision,
        plan.id,
        plan.allowanceUnits,
        null,
        now,
      );
      if (sharedSignup && eligibility) await markSignupClaimed(tx, account.eligibility_key, now);
    }
    return {
      plan,
      now,
      period: {
        start: existing?.period_start ? new Date(existing.period_start) : new Date(wallet.anchor),
        end: null,
      },
      wallet,
      account,
    };
  }
  // An already granted period survives a policy change, with its original amount and end.
  const [existing] =
    await tx`SELECT * FROM credit_grant WHERE user_id=${userId} AND kind='included' AND plan_id=${plan.id} AND expires_at>clock_timestamp() AND NOT revoked ORDER BY expires_at DESC LIMIT 1`;
  let period: { start: Date; end: Date };
  if (existing) {
    period = { start: new Date(existing.period_start), end: new Date(existing.expires_at) };
  } else {
    const anchor =
      paid && product && account.subscription_start
        ? new Date(account.subscription_start)
        : new Date(wallet.anchor);
    period = cycleAt(anchor, now, plan.cycle);
    if (paid && product)
      period.end = new Date(Math.min(period.end.getTime(), new Date(account.paid_until).getTime()));
    const freeAlreadyClaimed =
      plan.id === policy.freePlan &&
      eligibility?.free_period_end &&
      new Date(eligibility.free_period_end) > now;
    if (freeAlreadyClaimed) period.end = new Date(eligibility?.free_period_end as string);
    if (policy.enabled && !readOnly && !freeAlreadyClaimed) {
      await grant(
        tx,
        userId,
        `included:${plan.id}:${period.start.toISOString()}`,
        "included",
        policy.revision,
        plan.id,
        plan.allowanceUnits,
        period.end,
        period.start,
      );
      if (plan.id === policy.freePlan && eligibility)
        await markFreePeriod(tx, account.eligibility_key, period.end);
    }
  }
  return { plan, now, period, wallet, account };
}
export async function grant(
  tx: Tx,
  userId: string,
  key: string,
  kind: "welcome" | "included" | "topup",
  revision: number,
  planId: string | null,
  amount: string,
  expires: Date | null,
  periodStart: Date | null = null,
) {
  await tx`INSERT INTO credit_grant(id,user_id,grant_key,kind,policy_revision,plan_id,amount,expires_at,period_start,allowance_basis)
    VALUES (${crypto.randomUUID()},${userId},${key},${kind},${revision},${planId},${amount},${expires?.toISOString() ?? null},${periodStart?.toISOString() ?? null},${kind === "included" ? amount : null}) ON CONFLICT(user_id,grant_key) DO NOTHING`;
}
export async function availableGrants(tx: Tx, userId: string, planId: string) {
  const rows =
    await tx`SELECT * FROM credit_grant WHERE user_id=${userId} AND NOT revoked AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (kind<>'included' OR plan_id=${planId}) ORDER BY expires_at ASC NULLS LAST,created_at,id FOR UPDATE`;
  // A grant may expire while this SELECT waits for another transaction's row lock.
  const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
  const now = new Date(clock?.db_now);
  return rows.filter((g) => !g.expires_at || new Date(g.expires_at) > now);
}
export async function applyTopup(
  db: Database,
  policy: CloudPolicy,
  order: {
    id: string;
    userId: string;
    productId: string;
    paid: boolean;
    refunded: boolean;
    createdAt: Date;
    policyRevision?: number;
    refundRequiresReview?: boolean;
  },
) {
  await db.sql.begin(async (tx) => {
    // Share the registration fence without granting runtime roles policy-table writes.
    // Concurrent settlements coexist; registration waits before checking legacy balances.
    await tx`SELECT pg_advisory_xact_lock_shared(91843722)`;
    const [activePolicy] = await tx`SELECT p.configuration FROM cloud_active_policy a
      JOIN cloud_policy p ON p.revision=a.revision WHERE a.singleton=true`;
    const [account] = await tx`SELECT lifecycle FROM auth_user WHERE id=${order.userId} FOR SHARE`;
    if (!account) return;
    await tx`INSERT INTO credit_wallet(user_id) VALUES (${order.userId}) ON CONFLICT DO NOTHING`;
    await tx`SELECT user_id FROM credit_wallet WHERE user_id=${order.userId} FOR UPDATE`;
    const key = `polar-order:${order.id}`;
    const [prior] =
      await tx`SELECT id,spent,held FROM credit_grant WHERE user_id=${order.userId} AND grant_key=${key} FOR UPDATE`;
    // Refund observations are terminal even when the paid snapshot has not arrived yet.
    // Both refresh and webhook jobs serialize through the wallet and share this tombstone.
    if (order.refunded) {
      await tx`INSERT INTO billing_order_reversal(order_id,user_id,product_id)
        VALUES (${order.id},${order.userId},${order.productId}) ON CONFLICT DO NOTHING`;
    }
    const [reversal] =
      await tx`SELECT user_id,product_id FROM billing_order_reversal WHERE order_id=${order.id}`;
    if (reversal && (reversal.user_id !== order.userId || reversal.product_id !== order.productId))
      throw new AppError("provider_order_identity_invalid", 502);
    if (reversal || !order.paid) {
      if (prior) {
        await tx`UPDATE credit_grant SET revoked=true WHERE id=${prior.id}`;
        if (order.refundRequiresReview || BigInt(prior.spent) > 0n || BigInt(prior.held) > 0n)
          await tx`UPDATE credit_wallet SET suspended=true WHERE user_id=${order.userId}`;
      }
      return;
    }
    if (prior || account.lifecycle !== "active") return;
    // Select the product rules active when the order was created, not a later edited grant size.
    const [record] = order.policyRevision
      ? await tx`SELECT revision,configuration FROM cloud_policy WHERE revision=${order.policyRevision}`
      : await tx`SELECT revision,configuration FROM cloud_policy WHERE created_at<=${order.createdAt.toISOString()} ORDER BY revision DESC LIMIT 1`;
    if (!record) {
      if (order.policyRevision || policy.topups.some((p) => p.productId === order.productId))
        throw new AppError("purchase_policy_unavailable", 503);
      return;
    }
    const historical = record.configuration as CloudPolicy;
    const product = historical.topups.find((p) => p.productId === order.productId);
    if (!product) return;
    if (
      (activePolicy?.configuration as CloudPolicy | undefined)?.creditCurrency === "USD" &&
      historical.creditCurrency !== "USD"
    )
      throw new AppError("purchase_policy_unavailable", 503);
    const expiry =
      product.expiresDays === null
        ? null
        : new Date(order.createdAt.getTime() + product.expiresDays * 86400000);
    await grant(tx, order.userId, key, "topup", record.revision, null, product.units, expiry);
  });
}
