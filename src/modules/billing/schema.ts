import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });

import { user } from "../identity/schema";
import { cloudPolicy } from "../policy/schema";

export const billing = pgTable("billing_customer", {
  providerTouched: boolean("provider_touched").notNull().default(false),
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  polarId: text("polar_id").unique(),
  status: text("status").notNull().default("unknown"),
  paidUntil: time("paid_until"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  reconciledAt: time("reconciled_at"),
  requested: integer("requested").notNull().default(1),
  processed: integer("processed").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  nextAttempt: time("next_attempt").notNull().defaultNow(),
  checkoutUntil: time("checkout_until"),
  subscriptionId: text("subscription_id"),
  subscriptionCheckoutUntil: time("subscription_checkout_until"),
  productId: text("product_id"),
  periodStart: time("period_start"),
  subscriptionStart: time("subscription_start"),
});

export const billingCheckout = pgTable(
  "billing_checkout",
  {
    checkoutId: text("checkout_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull(),
    policyRevision: integer("policy_revision").references(() => cloudPolicy.revision),
    kind: text("kind").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("billing_checkout_kind_check", sql`${t.kind} in ('subscription', 'topup')`),
    index("billing_checkout_user_created").on(t.userId, t.createdAt.desc()),
  ],
);

export const billingOrderReversal = pgTable(
  "billing_order_reversal",
  {
    orderId: text("order_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    productId: text("product_id").notNull(),
    subscriptionId: text("subscription_id"),
    orderCreatedAt: time("order_created_at"),
    observedAt: time("observed_at").notNull().defaultNow(),
  },
  (t) => [index("billing_order_reversal_user").on(t.userId)],
);

export const billingOrderJob = pgTable("billing_order_job", {
  orderId: text("order_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  requested: integer("requested").notNull().default(1),
  processed: integer("processed").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  nextAttempt: time("next_attempt").notNull().defaultNow(),
});

export const billingPlanChange = pgTable(
  "billing_plan_change",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    policyRevision: integer("policy_revision")
      .notNull()
      .references(() => cloudPolicy.revision),
    quote: jsonb("quote").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull().default("quoted"),
    errorCode: text("error_code"),
    attemptId: uuid("attempt_id"),
    attempts: integer("attempts").notNull().default(0),
    nextAttempt: time("next_attempt").notNull().defaultNow(),
    dispatchedAt: time("dispatched_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    finishedAt: time("finished_at"),
  },
  (t) => [
    check(
      "billing_plan_change_state_check",
      sql`${t.state} in ('quoted','queued','executing','uncertain','applied','scheduled','failed')`,
    ),
    check("billing_plan_change_attempts_check", sql`${t.attempts} >= 0`),
    uniqueIndex("billing_plan_change_one_active")
      .on(t.userId)
      .where(sql`${t.state} in ('queued','executing','uncertain')`),
    index("billing_plan_change_work")
      .on(t.nextAttempt)
      .where(sql`${t.state} in ('queued','executing','uncertain')`),
    index("billing_plan_change_user").on(t.userId, t.createdAt.desc()),
  ],
);

export const billingContactJob = pgTable(
  "billing_contact_job",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    requested: integer("requested").notNull().default(1),
    processed: integer("processed").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttempt: time("next_attempt").notNull().defaultNow(),
  },
  (t) => [
    check("billing_contact_job_requested_check", sql`${t.requested} >= 0`),
    check(
      "billing_contact_job_processed_check",
      sql`${t.processed} >= 0 AND ${t.processed} <= ${t.requested}`,
    ),
    check("billing_contact_job_attempts_check", sql`${t.attempts} >= 0`),
    index("billing_contact_job_work")
      .on(t.nextAttempt)
      .where(sql`${t.requested} > ${t.processed} AND ${t.attempts} < 10`),
  ],
);
