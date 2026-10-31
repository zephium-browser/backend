import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { paidStateMaxAgeMs } from "../credits";
import type { BillingOrder, CustomerState } from "./provider";

/** A refunded or charged-back subscription order. */
export interface SubscriptionReversal {
  subscriptionId: string;
  orderCreatedAt: Date;
}
// The order paying a period can be created moments before the period Polar reports.
const periodOrderSlackMs = 3600_000;

/** A reversal ends the period its order paid for; a later renewal restores access. */
function reversed(
  subscription: CustomerState["subscriptions"][number],
  reversals: readonly SubscriptionReversal[],
) {
  return reversals.some(
    (r) =>
      r.subscriptionId === subscription.id &&
      (!subscription.periodStart ||
        r.orderCreatedAt.getTime() >= subscription.periodStart.getTime() - periodOrderSlackMs),
  );
}

export function subscriptionDecision(
  state: CustomerState | null,
  products: string[],
  now = new Date(),
  ranks: Record<string, number> = {},
  reversals: readonly SubscriptionReversal[] = [],
) {
  const eligible = state?.subscriptions
    .filter(
      (s) =>
        products.includes(s.productId) &&
        s.status === "active" &&
        s.paidUntil > now &&
        !reversed(s, reversals),
    )
    .sort(
      (a, b) =>
        (ranks[b.productId] ?? 0) - (ranks[a.productId] ?? 0) ||
        b.paidUntil.getTime() - a.paidUntil.getTime(),
    )[0];
  return {
    status: eligible ? "active" : "inactive",
    paidUntil: eligible?.paidUntil ?? null,
    cancelAtPeriodEnd: eligible?.cancelAtPeriodEnd ?? false,
    subscriptionId: eligible?.id ?? null,
    productId: eligible?.productId ?? null,
    periodStart: eligible?.periodStart ?? null,
    subscriptionStart: eligible?.subscriptionStart ?? null,
  };
}
export async function subscriptionReversals(
  tx: TransactionSql,
  userId: string,
): Promise<SubscriptionReversal[]> {
  const rows = await tx<{ subscription_id: string; order_created_at: Date }[]>`
    SELECT subscription_id,order_created_at FROM billing_order_reversal
    WHERE user_id=${userId} AND subscription_id IS NOT NULL AND order_created_at IS NOT NULL`;
  return rows.map((r) => ({
    subscriptionId: r.subscription_id,
    orderCreatedAt: new Date(r.order_created_at),
  }));
}

/** Records a reversed subscription order; returns whether paid access must be re-evaluated. */
export async function recordSubscriptionReversal(tx: TransactionSql, order: BillingOrder) {
  if (!order.refunded || !order.subscriptionId) return false;
  const rows =
    await tx`INSERT INTO billing_order_reversal(order_id,user_id,product_id,subscription_id,order_created_at)
    VALUES (${order.id},${order.userId},${order.productId},${order.subscriptionId},${order.createdAt.toISOString()})
    ON CONFLICT(order_id) DO UPDATE SET subscription_id=excluded.subscription_id,order_created_at=excluded.order_created_at
    WHERE billing_order_reversal.user_id=excluded.user_id AND billing_order_reversal.product_id=excluded.product_id
      AND billing_order_reversal.subscription_id IS NULL
    RETURNING order_id`;
  const [owner] =
    await tx`SELECT user_id,product_id FROM billing_order_reversal WHERE order_id=${order.id}`;
  if (owner?.user_id !== order.userId || owner.product_id !== order.productId)
    throw new AppError("provider_order_identity_invalid", 502);
  return rows.length > 0;
}

export async function acceptEvent(
  db: Database,
  id: string,
  body: string,
  verifiedAccountId: string | null,
  orderId: string | null = null,
  polarCustomerId: string | null = null,
) {
  const digest = createHash("sha256").update(body).digest("hex");
  await db.sql.begin(async (tx) => {
    // Refund events carry only Polar's customer id; map it through the reconciled link.
    const accountId =
      verifiedAccountId ??
      (polarCustomerId
        ? ((await tx`SELECT user_id FROM billing_customer WHERE polar_id=${polarCustomerId}`)[0]
            ?.user_id ?? null)
        : null);
    const inserted =
      await tx`INSERT INTO billing_event (id,digest) VALUES (${id},${digest}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!inserted.length) {
      const [old] = await tx`SELECT digest FROM billing_event WHERE id=${id}`;
      if (old?.digest !== digest) throw new AppError("event_identity_conflict", 409);
      return;
    }
    if (accountId)
      await tx`INSERT INTO billing_customer (user_id)
      SELECT id FROM auth_user WHERE id=${accountId}
      ON CONFLICT (user_id) DO UPDATE SET provider_touched=true,requested=billing_customer.requested+1, next_attempt=now(), attempts=0`;
    if (accountId && orderId)
      await tx`INSERT INTO billing_order_job(order_id,user_id) SELECT ${orderId},id FROM auth_user WHERE id=${accountId}
      ON CONFLICT(order_id) DO UPDATE SET requested=billing_order_job.requested+1,next_attempt=now(),attempts=0`;
  });
}
export async function accountAccess(
  db: Database,
  id: string,
  products: readonly { productId: string; plan: string; interval: "monthly" | "yearly" }[] = [],
) {
  const [row] =
    await db.sql`SELECT provider_touched,status,paid_until,cancel_at_period_end,reconciled_at,product_id FROM billing_customer WHERE user_id=${id}`;
  const fresh =
    row?.reconciled_at && new Date(row.reconciled_at).getTime() > Date.now() - paidStateMaxAgeMs;
  const paid = !!(
    fresh &&
    row?.status === "active" &&
    row.paid_until &&
    new Date(row.paid_until) > new Date()
  );
  const product = paid ? products.find((item) => item.productId === row?.product_id) : undefined;
  return {
    subscription: {
      plan: product?.plan ?? null,
      interval: product?.interval ?? null,
      status:
        row?.provider_touched === false
          ? "inactive"
          : fresh
            ? (row?.status ?? "unknown")
            : "unknown",
      paidUntil: row?.paid_until ? new Date(row.paid_until).toISOString() : null,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
    },
    paid,
    capabilities: { hostedAI: false, synchronization: false },
  };
}
