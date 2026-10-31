import type { TransactionSql } from "postgres";
import { cleanupBatchSize, type Database, deleteInBatches } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";
import {
  cleanupExpiredActionCodes,
  cleanupExpiredAuthCodes,
  cleanupExpiredSessions,
  purgeAccount,
} from "../identity";
import { pendingPlanChange } from "./plan-changes";
import type { BillingProvider } from "./provider";
import { subscriptionDecision } from "./service";

type ClaimedCustomer = {
  user_id: string;
  requested: number;
  provider_touched: boolean;
  checkout_until: Date | null;
  lifecycle: string;
  claimed_at: Date;
};

/**
 * Claims one customer with a short lease, then performs Polar I/O outside any
 * transaction so customer requests never wait on the provider while holding
 * the billing row. A crashed worker's lease expires and another worker resumes.
 * Exhausted rows keep retrying at the capped backoff; health reports them.
 */
export async function workOnce(
  db: Database,
  provider: BillingProvider,
  products: string[],
  ranks: Record<string, number> = {},
): Promise<boolean> {
  const claimed = await db.sql.begin(async (tx) => {
    const [row] = await tx<Omit<ClaimedCustomer, "claimed_at">[]>`
      SELECT b.user_id,b.requested,b.provider_touched,b.checkout_until,u.lifecycle
      FROM billing_customer b JOIN auth_user u ON u.id=b.user_id
      WHERE b.next_attempt <= now() AND
      NOT EXISTS(SELECT 1 FROM billing_plan_change c WHERE c.user_id=b.user_id AND c.state IN ('queued','executing','uncertain')) AND
      (b.provider_touched OR u.lifecycle='deleting') AND
      (u.lifecycle='deleting' OR b.requested > b.processed OR b.reconciled_at IS NULL OR b.reconciled_at < now()-interval '15 minutes')
      ORDER BY b.next_attempt FOR UPDATE OF b SKIP LOCKED LIMIT 1`;
    if (!row) return null;
    // Recheck using a new READ COMMITTED snapshot after acquiring the billing lock.
    if (await pendingPlanChange(tx, row.user_id)) return null;
    const [lease] = await tx<{ claimed_at: Date }[]>`
      UPDATE billing_customer SET next_attempt=now()+interval '5 minutes'
      WHERE user_id=${row.user_id} RETURNING clock_timestamp() AS claimed_at`;
    return { ...row, claimed_at: new Date(lease?.claimed_at ?? Date.now()) } as ClaimedCustomer;
  });
  if (!claimed) return false;
  try {
    if (claimed.lifecycle === "deleting") await finishDeletion(db, provider, claimed);
    else await reconcile(db, provider, claimed, products, ranks);
  } catch {
    // Runs outside the failed work so a database error cannot discard the backoff.
    const [row] = await db.sql<{ attempts: number }[]>`
      UPDATE billing_customer SET attempts=attempts+1,
        next_attempt=now()+least(3600, 15*power(2, attempts+1))*interval '1 second'
      WHERE user_id=${claimed.user_id} RETURNING attempts`;
    operationalEvent(Number(row?.attempts) >= 10 ? "billing_work_exhausted" : "billing_work_retry");
  }
  return true;
}

async function reconcile(
  db: Database,
  provider: BillingProvider,
  claimed: ClaimedCustomer,
  products: string[],
  ranks: Record<string, number>,
) {
  const userId = claimed.user_id;
  const state = await provider.state(userId);
  if (state && state.accountId !== userId) throw new Error("Identity mismatch");
  const decision = subscriptionDecision(state, products, new Date(), ranks);
  await db.sql.begin(async (tx) => {
    const [current] = await tx`SELECT b.reconciled_at,u.lifecycle
      FROM billing_customer b JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId} FOR UPDATE OF b`;
    if (!current) return;
    if (current.lifecycle === "deleting" || (await pendingPlanChange(tx, userId))) {
      // Deletion or a managed plan change now owns this row; let it run promptly.
      await tx`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${userId}`;
      return;
    }
    // A customer refresh that committed during our provider read has priority.
    if (current.reconciled_at && new Date(current.reconciled_at) >= claimed.claimed_at) {
      await tx`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${userId} AND requested>processed`;
      return;
    }
    await tx`UPDATE billing_customer SET polar_id=${state?.customerId ?? null}, status=${decision.status}, paid_until=${decision.paidUntil?.toISOString() ?? null},
      subscription_id=${decision.subscriptionId},product_id=${decision.productId},period_start=${decision.periodStart?.toISOString() ?? null},subscription_start=${decision.subscriptionStart?.toISOString() ?? null},
      cancel_at_period_end=${decision.cancelAtPeriodEnd}, reconciled_at=now(), processed=${claimed.requested}, attempts=0,
      next_attempt=CASE WHEN requested>${claimed.requested} THEN now() ELSE now()+interval '15 minutes' END
      WHERE user_id=${userId}`;
  });
}

/** Returns a later retry time while local work still needs this account, otherwise null. */
async function deletionDeferral(tx: TransactionSql, userId: string): Promise<Date | null> {
  // Exhausted jobs keep retrying for active accounts, but must not hold personal data forever.
  const [pending] = await tx`SELECT
    EXISTS(SELECT 1 FROM cloud_request WHERE user_id=${userId} AND state IN ('preflight','reserved','running','usage_unknown'))
    OR EXISTS(SELECT 1 FROM cloud_outbox o JOIN cloud_request r ON r.id=o.request_id
      WHERE r.user_id=${userId} AND o.delivered_at IS NULL AND o.attempts<10)
    OR EXISTS(SELECT 1 FROM billing_order_job WHERE user_id=${userId} AND requested>processed AND attempts<10) AS waiting,
    (SELECT checkout_until FROM billing_customer WHERE user_id=${userId}) AS checkout_until,
    clock_timestamp() AS db_now`;
  if (pending?.waiting) return new Date(new Date(pending.db_now).getTime() + 60_000);
  if (pending?.checkout_until && new Date(pending.checkout_until) > new Date(pending.db_now))
    return new Date(pending.checkout_until);
  return null;
}

async function finishDeletion(db: Database, provider: BillingProvider, claimed: ClaimedCustomer) {
  const userId = claimed.user_id;
  const deferUntil = (until: Date) =>
    db.sql`UPDATE billing_customer SET next_attempt=${until.toISOString()} WHERE user_id=${userId}`;
  const deferral = await db.sql.begin((tx) => deletionDeferral(tx, userId));
  if (deferral) return void (await deferUntil(deferral));
  if (claimed.provider_touched) {
    // Sealed accounts cannot open checkouts. Listing on every retry also recovers a
    // checkout whose create response was lost before it was recorded locally.
    const openUntil = await provider.openCheckoutUntil(userId);
    if (openUntil && openUntil > new Date()) return void (await deferUntil(openUntil));
    await provider.deleteCustomer(userId);
    if (await provider.state(userId)) throw new Error("Provider deletion not confirmed");
  }
  const deferred = await db.sql.begin(async (tx) => {
    const [current] = await tx`SELECT u.lifecycle,u.email FROM billing_customer b
      JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId} FOR UPDATE OF b`;
    if (current?.lifecycle !== "deleting") return null;
    const late = await deletionDeferral(tx, userId);
    if (late) return late;
    await purgeAccount(tx, userId, String(current.email));
    return null;
  });
  if (deferred) await deferUntil(deferred);
}

/** Each step is independent: one failing table must not stop the others or billing work. */
export async function cleanup(db: Database): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    [
      "plan_quotes",
      () =>
        db.sql`DELETE FROM billing_plan_change WHERE state='quoted' AND created_at<now()-interval '1 day'`,
    ],
    ["action_codes", () => cleanupExpiredActionCodes(db.sql)],
    [
      "abuse_buckets",
      () =>
        deleteInBatches(
          () => db.sql`DELETE FROM abuse_bucket WHERE key IN (
            SELECT key FROM abuse_bucket WHERE expires_at < now()-interval '1 hour' LIMIT ${cleanupBatchSize})`,
        ),
    ],
    ["auth_codes", () => cleanupExpiredAuthCodes(db.sql)],
    ["sessions", () => cleanupExpiredSessions(db.sql)],
    [
      "billing_events",
      () =>
        deleteInBatches(
          () => db.sql`DELETE FROM billing_event WHERE id IN (
            SELECT id FROM billing_event WHERE received_at < now()-interval '90 days' LIMIT ${cleanupBatchSize})`,
        ),
    ],
  ];
  let failed = false;
  for (const [name, step] of steps) {
    try {
      await step();
    } catch {
      failed = true;
      operationalEvent(`cleanup_${name}_failed`);
    }
  }
  if (failed) throw new Error("Cleanup incomplete");
}
