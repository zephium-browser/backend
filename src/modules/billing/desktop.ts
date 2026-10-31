import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database, Tx } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { applyTopup, assertPurchaseAllowed, creditUnits, unitsPerUsd } from "../credits";
import type { CloudPolicy } from "../policy";
import { createPlanChangeService, pendingPlanChange } from "./plan-changes";
import type {
  BillingOrder,
  BillingProvider,
  CustomerState,
  ProductOffer,
  Purchase,
} from "./provider";
import { accountAccess, subscriptionDecision } from "./service";

type BillingConfig = Pick<
  Config,
  | "NODE_ENV"
  | "BILLING_ENABLED"
  | "ABUSE_SECRET"
  | "POLAR_MONTHLY_PRODUCT_ID"
  | "POLAR_YEARLY_PRODUCT_ID"
>;
export type BillingSelection =
  | { interval: "monthly" | "yearly"; plan?: string }
  | { topup: string };
type Checkout = { id?: string; expiresAt: Date };
type KnownCheckout = {
  checkout_id: string;
  user_id: string;
  product_id: string;
  policy_revision: number | null;
  kind: "subscription" | "topup";
};

const unavailable = () => new AppError("billing_unavailable", 503);
function providerFailure(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw unavailable();
}

/** Browser-free billing surface for the signed-in desktop account. */
export function createBillingService(
  config: BillingConfig,
  db: Database,
  provider: BillingProvider,
  policy: CloudPolicy | null,
) {
  const enabled = config.BILLING_ENABLED === "true";
  function assertTopupDenomination(productId: string, offer: ProductOffer) {
    if (policy?.creditCurrency !== "USD") return;
    const topup = policy.topups.find((item) => item.productId === productId);
    const minor = offer.price.amount_minor;
    if (
      !topup ||
      offer.productId !== productId ||
      offer.price.currency !== "USD" ||
      !Number.isSafeInteger(minor) ||
      minor <= 0 ||
      BigInt(topup.units) !== (BigInt(minor) * unitsPerUsd) / 100n
    )
      throw new AppError("product_configuration_invalid", 503);
  }

  async function offers() {
    if (!policy) throw new AppError("product_not_configured", 503);
    const offer = provider.productOffer;
    const selections: { productId: string; purchase: Purchase }[] = [
      ...policy.subscriptions
        .filter((s) => s.checkoutEnabled !== false)
        .map((s) => ({
          productId: s.productId,
          purchase: { kind: "subscription" as const, interval: s.interval },
        })),
      ...policy.topups.map((t) => ({
        productId: t.productId,
        purchase: { kind: "topup" as const },
      })),
    ];
    if (selections.length && !offer) throw unavailable();
    const readOffer = offer ?? (() => Promise.reject(unavailable()));
    const details: ProductOffer[] = [];
    try {
      // Policy bounds this to at most 40 products. Adapter single-flight coalesces
      // concurrent callers; one parallel batch keeps the response within provider deadlines.
      details.push(
        ...(await Promise.all(selections.map((s) => readOffer(s.productId, s.purchase)))),
      );
    } catch (error) {
      providerFailure(error);
    }
    let index = 0;
    return {
      subscriptions: policy.subscriptions
        .filter((s) => s.checkoutEnabled !== false)
        .map((s) => {
          const product = details[index++];
          if (!product || product.productId !== s.productId) throw unavailable();
          return {
            plan: s.plan,
            interval: s.interval,
            product_name: product.productName,
            price: product.price,
          };
        }),
      topups: policy.topups.map((t) => {
        const product = details[index++];
        if (!product || product.productId !== t.productId) throw unavailable();
        assertTopupDenomination(t.productId, product);
        return {
          id: t.id,
          units: t.units,
          expires_days: t.expiresDays,
          product_name: product.productName,
          price: product.price,
        };
      }),
      unit_scale: 1_000_000,
      credit_units: creditUnits,
    };
  }

  async function summary(userId: string) {
    const access = await accountAccess(db, userId, policy?.subscriptions);
    if (!enabled)
      return {
        ...access,
        subscription: {
          ...access.subscription,
          status: "not_applicable",
          plan: null,
          interval: null,
        },
        paid: false,
        capabilities: { ...access.capabilities, hostedAI: !!policy?.enabled },
      };
    return {
      ...access,
      capabilities: { ...access.capabilities, hostedAI: !!policy?.enabled },
    };
  }

  async function get(userId: string) {
    const access = await summary(userId);
    return { ...access, offers: enabled ? await offers() : null };
  }

  async function recordCheckout(
    userId: string,
    checkout: Checkout,
    productId: string,
    policyRevision: number | undefined,
    purchase: Purchase,
    tx: Database["sql"] | Tx = db.sql,
  ) {
    if (!enabled) throw new AppError("billing_not_enabled", 503);
    if (!checkout.id) {
      if (config.NODE_ENV === "test") return;
      throw new AppError("checkout_identity_missing", 503);
    }
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(checkout.id) ||
      !Number.isFinite(checkout.expiresAt.getTime())
    )
      throw new AppError("checkout_identity_invalid", 503);
    if (policy) {
      const configured =
        purchase.kind === "topup"
          ? policy.topups.some((t) => t.productId === productId)
          : policy.subscriptions.some(
              (s) =>
                s.productId === productId &&
                s.interval === purchase.interval &&
                s.checkoutEnabled !== false,
            );
      if (!configured || policyRevision !== policy.revision)
        throw new AppError("product_not_configured", 503);
    }
    const inserted =
      await tx`INSERT INTO billing_checkout(checkout_id,user_id,product_id,policy_revision,kind,expires_at)
      SELECT ${checkout.id},id,${productId},${policyRevision ?? null},${purchase.kind},${checkout.expiresAt.toISOString()}
      FROM auth_user WHERE id=${userId} AND lifecycle='active'
      ON CONFLICT(checkout_id) DO NOTHING RETURNING checkout_id`;
    if (inserted.length) return;
    const [existing] =
      await tx`SELECT user_id,product_id,policy_revision,kind FROM billing_checkout WHERE checkout_id=${checkout.id}`;
    if (!existing) throw new AppError("account_unavailable", 403);
    if (
      existing.user_id !== userId ||
      existing.product_id !== productId ||
      existing.policy_revision !== (policyRevision ?? null) ||
      existing.kind !== purchase.kind
    )
      throw new AppError("checkout_identity_conflict", 409);
  }

  async function startCheckout(userId: string, email: string, selection: BillingSelection) {
    if (!enabled) throw new AppError("billing_not_enabled", 503);
    let product: string | undefined;
    if ("topup" in selection)
      product = policy?.topups.find((p) => p.id === selection.topup)?.productId;
    else if (policy) {
      const matches = policy.subscriptions.filter(
        (p) =>
          p.checkoutEnabled !== false &&
          p.interval === selection.interval &&
          (!selection.plan || p.plan === selection.plan),
      );
      if (matches.length !== 1) throw new AppError("plan_selection_required");
      product = matches[0]?.productId;
    } else if (!selection.plan)
      product =
        selection.interval === "monthly"
          ? config.POLAR_MONTHLY_PRODUCT_ID
          : config.POLAR_YEARLY_PRODUCT_ID;
    if (!product) throw new AppError("product_not_configured", 503);
    await enforce(db, privateKey(config.ABUSE_SECRET, "checkout", userId), 60, 1);
    return checkout(
      userId,
      email,
      product,
      "topup" in selection
        ? { kind: "topup" }
        : { kind: "subscription", interval: selection.interval },
    );
  }

  async function checkout(userId: string, email: string, productId: string, purchase: Purchase) {
    if (!enabled) throw new AppError("billing_not_enabled", 503);
    if (purchase.kind === "subscription") {
      // Expired local state may be an auto-renewed subscription. Never create another
      // subscription based only on a stale local projection or an organization setting.
      let state: CustomerState | null;
      try {
        state = await provider.state(userId);
      } catch (error) {
        providerFailure(error);
      }
      if (state && state.accountId !== userId)
        throw new AppError("provider_identity_mismatch", 503);
      if (state?.subscriptions.length) throw new AppError("subscription_change_required", 409);
    }
    if (purchase.kind === "topup" && policy?.creditCurrency === "USD") {
      if (!provider.productOffer) throw unavailable();
      let offer: ProductOffer;
      try {
        offer = await provider.productOffer(productId, purchase, { fresh: true });
      } catch (error) {
        providerFailure(error);
      }
      assertTopupDenomination(productId, offer);
    }
    // Commit the deletion barrier before remote mutation. A lost create response is
    // recovered by the worker's open-checkout listing after this conservative horizon.
    await db.sql.begin(async (tx) => {
      const [billing] = await tx`SELECT * FROM billing_customer WHERE user_id=${userId} FOR UPDATE`;
      const [account] = await tx`SELECT lifecycle FROM auth_user WHERE id=${userId}`;
      if (!billing || account?.lifecycle !== "active")
        throw new AppError("account_unavailable", 403);
      await assertPurchaseAllowed(tx, userId);
      if (purchase.kind === "subscription") {
        if (
          billing.subscription_id &&
          billing.paid_until &&
          new Date(billing.paid_until) > new Date()
        )
          throw new AppError("subscription_change_required", 409);
        if (await pendingPlanChange(tx, userId)) throw new AppError("plan_change_in_progress", 409);
        const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
        if (
          billing.subscription_checkout_until &&
          new Date(billing.subscription_checkout_until) > new Date(clock?.db_now)
        )
          throw new AppError("checkout_in_progress", 409);
        await tx`UPDATE billing_customer SET subscription_checkout_until=clock_timestamp()+interval '24 hours' WHERE user_id=${userId}`;
      }
      if (policy) {
        const [active] = await tx`SELECT revision FROM cloud_active_policy WHERE singleton=true`;
        if (active?.revision !== policy.revision) throw new AppError("cloud_policy_changed", 503);
      }
      await tx`UPDATE billing_customer SET provider_touched=true,
        checkout_until=greatest(checkout_until,clock_timestamp()+interval '24 hours') WHERE user_id=${userId}`;
    });
    // No SQL connection or account lock is held during provider I/O.
    const result = await provider.checkout(userId, email, productId, policy?.revision, purchase);
    await db.sql.begin(async (tx) => {
      await tx`SELECT user_id FROM billing_customer WHERE user_id=${userId} FOR UPDATE`;
      const [account] = await tx`SELECT lifecycle FROM auth_user WHERE id=${userId}`;
      if (account?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      await recordCheckout(userId, result, productId, policy?.revision, purchase, tx);
      if (purchase.kind === "subscription")
        await tx`UPDATE billing_customer SET subscription_checkout_until=${result.expiresAt.toISOString()} WHERE user_id=${userId}`;
      await tx`UPDATE billing_customer SET
        checkout_until=greatest(checkout_until,${result.expiresAt.toISOString()}::timestamptz),
        requested=requested+1,next_attempt=now() WHERE user_id=${userId}`;
    });
    return result;
  }

  async function refresh(userId: string) {
    if (!enabled) return get(userId);
    if (!policy) throw new AppError("product_not_configured", 503);
    await enforce(db, privateKey(config.ABUSE_SECRET, "billing-refresh", userId), 60, 6);
    const started = new Date();
    const [before] =
      await db.sql`SELECT b.requested,b.reconciled_at,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId}`;
    if (before?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
    const rows = await db.sql<
      KnownCheckout[]
    >`SELECT checkout_id,user_id,product_id,policy_revision,kind
      FROM billing_checkout WHERE user_id=${userId} AND created_at>now()-interval '90 days'
      ORDER BY created_at DESC LIMIT 20`;
    // Older purchases continue to reconcile through durable webhook jobs.
    let state: CustomerState | null;
    let orders: BillingOrder[] = [];
    try {
      [state, orders] = await Promise.all([
        provider.state(userId),
        rows.length
          ? provider.ordersForCheckouts
            ? provider.ordersForCheckouts(
                userId,
                rows.map((r) => r.checkout_id),
              )
            : Promise.reject(unavailable())
          : Promise.resolve([]),
      ]);
    } catch (error) {
      providerFailure(error);
    }
    if (state && state.accountId !== userId) throw new AppError("provider_identity_mismatch", 503);
    const known = new Map(rows.map((r) => [r.checkout_id, r]));
    for (const order of orders) {
      const checkout = order.checkoutId && known.get(order.checkoutId);
      if (
        !checkout ||
        order.userId !== userId ||
        order.productId !== checkout.product_id ||
        (order.policyRevision !== undefined && order.policyRevision !== checkout.policy_revision)
      )
        throw new AppError("provider_order_identity_invalid", 502);
    }
    // Grant logic is idempotent and uses the checkout's historical policy, including refunds.
    for (const order of orders) {
      const checkout = known.get(order.checkoutId ?? "");
      if (checkout?.kind !== "topup") continue;
      await applyTopup(db, policy, {
        ...order,
        policyRevision: checkout.policy_revision ?? undefined,
      });
    }
    const products = policy.subscriptions.map((s) => s.productId);
    const ranks = Object.fromEntries(
      policy.subscriptions.map((s) => [
        s.productId,
        policy.plans.find((p) => p.id === s.plan)?.rank ?? 0,
      ]),
    );
    const decision = subscriptionDecision(state, products, new Date(), ranks);
    await db.sql.begin(async (tx) => {
      const [current] =
        await tx`SELECT b.requested,b.reconciled_at,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId} FOR UPDATE OF b`;
      if (current?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      // A managed change owns subscription projection until its charge outcome is known.
      if (await pendingPlanChange(tx, userId)) return;
      // A webhook or worker result that arrived during provider I/O has priority.
      if (
        current.requested !== before.requested ||
        (current.reconciled_at && new Date(current.reconciled_at) >= started)
      )
        return;
      await tx`UPDATE billing_customer SET provider_touched=true,polar_id=${state?.customerId ?? null},status=${decision.status},
        paid_until=${decision.paidUntil?.toISOString() ?? null},subscription_id=${decision.subscriptionId},product_id=${decision.productId},
        period_start=${decision.periodStart?.toISOString() ?? null},subscription_start=${decision.subscriptionStart?.toISOString() ?? null},
        cancel_at_period_end=${decision.cancelAtPeriodEnd},reconciled_at=now(),processed=${current.requested},attempts=0,
        next_attempt=now()+interval '15 minutes' WHERE user_id=${userId}`;
    });
    return get(userId);
  }

  async function portal(userId: string) {
    if (!enabled) throw new AppError("billing_not_enabled", 503);
    // Each portal session costs one or two Polar calls against the organization's quota.
    await enforce(db, privateKey(config.ABUSE_SECRET, "billing-portal", userId), 60, 6);
    const [row] =
      await db.sql`SELECT b.polar_id,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId}`;
    if (row?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
    try {
      if (!row.polar_id) {
        const state = await provider.state(userId);
        if (!state) throw new AppError("no_billing_account", 409);
        if (state.accountId !== userId) throw new AppError("provider_identity_mismatch", 503);
      }
      return await provider.portal(userId);
    } catch (error) {
      providerFailure(error);
    }
  }

  return {
    summary,
    get,
    refresh,
    portal,
    recordCheckout,
    checkout,
    startCheckout,
    planChanges: createPlanChangeService(db, provider, policy, config),
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
