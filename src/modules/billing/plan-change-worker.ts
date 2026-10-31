import type { Database } from "../../platform/db";
import { AppError, operationalEvent } from "../../platform/errors";
import { applyPaidUpgrade, assertPurchaseAllowed } from "../credits";
import { assertMutationSession } from "../identity";
import type { CloudPolicy } from "../policy";
import { assertPlanChangeSubscription } from "./plan-change-policy";
import { assertBillingPolicy, type PlanChangeRow } from "./plan-changes";
import {
  type BillingProvider,
  type BillingSubscription,
  SubscriptionChangeRejected,
} from "./provider";

/** One durable mutation attempt. Lost responses are reconciled by GET, never repeated PATCH. */
export async function processPlanChange(
  db: Database,
  provider: BillingProvider,
  policy: CloudPolicy,
): Promise<boolean> {
  if (!provider.subscription || !provider.changeSubscription || !provider.productOffer)
    return false;
  const claimed = await db.sql.begin(async (tx) => {
    const [row] = await tx<
      PlanChangeRow[]
    >`SELECT c.* FROM billing_plan_change c JOIN billing_customer b ON b.user_id=c.user_id
      WHERE c.state IN ('queued','executing','uncertain') AND c.next_attempt<=clock_timestamp()
      ORDER BY c.next_attempt FOR UPDATE OF b,c SKIP LOCKED LIMIT 1`;
    if (!row) return null;
    const attempt = crypto.randomUUID();
    await tx`UPDATE billing_plan_change SET state='executing',attempt_id=${attempt},attempts=attempts+1,
      next_attempt=clock_timestamp()+interval '30 seconds' WHERE id=${row.id}`;
    return { ...row, attempt_id: attempt, attempts: row.attempts + 1 };
  });
  if (!claimed) return false;
  const row = claimed;
  const quote = row.quote;

  async function finishFailure(code: string, uncertain = false) {
    await db.sql.begin(async (tx) => {
      await tx`SELECT user_id FROM billing_customer WHERE user_id=${row.user_id} FOR UPDATE`;
      const updated =
        await tx`UPDATE billing_plan_change SET state=${uncertain ? "uncertain" : "failed"},error_code=${code},
        finished_at=${uncertain ? null : new Date().toISOString()}::timestamptz,
        next_attempt=clock_timestamp()+${Math.min(3600, 15 * 2 ** row.attempts)}*interval '1 second'
        WHERE id=${row.id} AND attempt_id=${row.attempt_id} AND state='executing' RETURNING id`;
      if (updated.length)
        await tx`UPDATE billing_customer SET requested=requested+1,next_attempt=now() WHERE user_id=${row.user_id}`;
    });
    if (uncertain)
      operationalEvent(
        row.attempts >= 10 ? "billing_plan_change_exhausted" : "billing_plan_change_pending",
      );
  }
  async function apply(subscription: BillingSubscription) {
    if (
      subscription.id !== quote.subscription_id ||
      subscription.accountId !== row.user_id ||
      subscription.customerId !== quote.customer_id
    )
      throw new AppError("provider_identity_mismatch", 503);
    const active = subscription.status === "active" && subscription.paidUntil > new Date();
    const target =
      subscription.productId === quote.target_product_id &&
      active &&
      subscription.amountMinor === quote.target_amount_minor &&
      subscription.currency.toUpperCase() === quote.currency &&
      subscription.recurringInterval === quote.prior_recurring_interval &&
      subscription.recurringIntervalCount === 1;
    const scheduled =
      quote.direction === "downgrade" &&
      active &&
      subscription.productId === quote.current_product_id &&
      subscription.pendingChange?.productId === quote.target_product_id &&
      subscription.pendingChange.appliesAt.toISOString() === quote.period_end;
    if (!target && !scheduled) throw new AppError("billing_update_pending", 503);
    await db.sql.begin(async (tx) => {
      const [billing] =
        await tx`SELECT b.*,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id
        WHERE b.user_id=${row.user_id} FOR UPDATE OF b`;
      const [operation] = await tx<
        PlanChangeRow[]
      >`SELECT * FROM billing_plan_change WHERE id=${row.id} AND attempt_id=${row.attempt_id} AND state='executing' FOR UPDATE`;
      if (!operation) return;
      if (
        billing?.subscription_id !== quote.subscription_id ||
        billing.product_id !== quote.current_product_id
      )
        throw new AppError("billing_review_required", 403);
      if (target && quote.direction === "upgrade" && billing.lifecycle === "active") {
        if (!operation.dispatched_at) throw new AppError("billing_review_required", 403);
        await applyPaidUpgrade(tx, row.user_id, {
          fromPlan: quote.current_plan,
          toPlan: quote.target_plan,
          fromAllowance: quote.current_allowance_units,
          toAllowance: quote.target_allowance_units,
          policyRevision: quote.policy_revision,
          subscriptionStart: new Date(quote.subscription_start ?? quote.period_start),
          paidUntil: new Date(quote.period_end),
          effectiveAt: new Date(operation.dispatched_at),
        });
      }
      await tx`UPDATE billing_customer SET status=${subscription.status},product_id=${subscription.productId},
        paid_until=${subscription.paidUntil.toISOString()},period_start=${subscription.periodStart.toISOString()},
        subscription_start=${subscription.subscriptionStart?.toISOString() ?? null},cancel_at_period_end=${subscription.cancelAtPeriodEnd},
        reconciled_at=clock_timestamp(),requested=requested+1,next_attempt=now(),attempts=0 WHERE user_id=${row.user_id}`;
      await tx`UPDATE billing_plan_change SET state=${scheduled ? "scheduled" : "applied"},error_code=NULL,
        finished_at=clock_timestamp() WHERE id=${row.id}`;
    });
  }

  if (row.state !== "queued") {
    if (!row.dispatched_at) {
      // A process died before the dispatch marker; the stale owner cannot pass its lease CAS.
      await finishFailure("plan_change_expired");
    } else {
      try {
        await apply(await provider.subscription(quote.subscription_id));
      } catch {
        await finishFailure("billing_update_pending", true);
      }
    }
    return true;
  }

  try {
    const [current, offer] = await Promise.all([
      provider.subscription(quote.subscription_id),
      provider.productOffer(
        quote.target_product_id,
        { kind: "subscription", interval: quote.interval },
        { fresh: true },
      ),
    ]);
    assertPlanChangeSubscription(quote, current);
    if (
      offer.productId !== quote.target_product_id ||
      offer.price.amount_minor !== quote.target_amount_minor ||
      offer.price.currency.toUpperCase() !== quote.currency
    )
      throw new AppError("plan_change_expired", 409);
    await db.sql.begin(async (tx) => {
      const [billing] =
        await tx`SELECT b.*,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id
        WHERE b.user_id=${row.user_id} FOR UPDATE OF b`;
      if (billing?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      await assertMutationSession(tx, row.user_id, row.session_id, true);
      if (quote.direction === "upgrade") await assertPurchaseAllowed(tx, row.user_id);
      await assertBillingPolicy(tx, policy.revision);
      if (policy.revision !== quote.policy_revision)
        throw new AppError("cloud_policy_changed", 503);
      if (
        billing.subscription_id !== quote.subscription_id ||
        billing.product_id !== quote.current_product_id ||
        billing.polar_id !== quote.customer_id
      )
        throw new AppError("subscription_change_unavailable", 409);
      const rows =
        await tx`UPDATE billing_plan_change SET dispatched_at=clock_timestamp(),next_attempt=clock_timestamp()+interval '30 seconds'
        WHERE id=${row.id} AND attempt_id=${row.attempt_id} AND state='executing' AND dispatched_at IS NULL
          AND next_attempt>clock_timestamp() AND ${quote.expires_at}::timestamptz>clock_timestamp() RETURNING id`;
      if (!rows.length) throw new AppError("plan_change_expired", 409);
    });
  } catch (error) {
    await finishFailure(error instanceof AppError ? error.code : "billing_unavailable");
    return true;
  }
  try {
    const result = await provider.changeSubscription(
      quote.subscription_id,
      quote.target_product_id,
      quote.behavior,
    );
    await apply(result);
  } catch (error) {
    await finishFailure(
      error instanceof SubscriptionChangeRejected ? error.code : "billing_update_pending",
      !(error instanceof SubscriptionChangeRejected),
    );
  }
  return true;
}
