import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAdminReports, parsePlanPrices } from "../../src/modules/admin/reports";
import { registerPolicy } from "../../src/modules/policy/policy";
import { testDatabase } from "../support/admin-database";
import { testPolicy } from "../support/cloud-fixture";

const proProduct = "00000000-0000-4000-8000-000000000901";
const base = testPolicy();
const free = base.plans[0];
const model = base.models[0];
if (!free || !model) throw new Error("Missing fixture plan");
const policy = testPolicy({
  models: [{ ...model, costRates: model.rates }],
  plans: [free, { ...free, id: "pro", rank: 1, allowanceUnits: "1000" }],
  subscriptions: [{ productId: proProduct, plan: "pro", interval: "monthly" }],
  limits: {
    ...base.limits,
    budgets: {
      scope: "insights",
      dailyUsdMicros: "10000000",
      totalUsdMicros: "50000000",
      freeDailyUsdMicros: "5000000",
    },
  },
});
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let reports: ReturnType<typeof createAdminReports>;
beforeAll(async () => {
  fixture = await testDatabase();
  await registerPolicy(fixture.db, policy);
  reports = createAdminReports(fixture.db.sql, parsePlanPrices("pro:monthly=2000"));
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

async function account(days = 0) {
  const id = crypto.randomUUID();
  await fixture.db.sql`INSERT INTO auth_user(id,name,email,email_verified,created_at)
    VALUES (${id},'Insights',${`${id}@example.test`},true,now()-${days}*interval '1 day')`;
  await fixture.db.sql`INSERT INTO billing_customer(user_id) VALUES (${id}) ON CONFLICT DO NOTHING`;
  return id;
}

test("plan prices parse strictly", () => {
  expect([...parsePlanPrices(" pro:monthly=2000, max:yearly=100000 ")]).toEqual([
    ["pro:monthly", 2000],
    ["max:yearly", 100000],
  ]);
  expect(() => parsePlanPrices("pro=20")).toThrow();
});

test("revenue counts reconciled paying subscriptions and prices MRR", async () => {
  const paying = [await account(), await account()];
  for (const [index, id] of paying.entries())
    await fixture.db.sql`UPDATE billing_customer SET status='active',product_id=${proProduct},
      paid_until=now()+interval '20 days',subscription_start=now()-interval '3 days',
      cancel_at_period_end=${index === 1} WHERE user_id=${id}`;
  const lapsed = await account();
  await fixture.db.sql`UPDATE billing_customer SET status='inactive',product_id=${proProduct},
    paid_until=now()-interval '2 days' WHERE user_id=${lapsed}`;
  const revenue = await reports.revenue();
  expect(revenue.prices_configured).toBe(true);
  expect(revenue.paying).toBe(2);
  expect(revenue.mrr_minor).toBe(4000);
  expect(revenue.plans).toEqual([
    {
      plan: "pro",
      interval: "monthly",
      active: 2,
      cancelling: 1,
      new_30d: 2,
      lapsed_30d: 1,
      price_minor: 2000,
      mrr_minor: 4000,
    },
  ]);
  // Unknown prices never produce a misleading total.
  expect((await createAdminReports(fixture.db.sql).revenue()).mrr_minor).toBeNull();
});

test("activity returns a dense UTC series with signups and requests", async () => {
  const id = await account(2);
  await fixture.db.sql`INSERT INTO credit_wallet(user_id) VALUES (${id})`;
  await fixture.db
    .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,
    policy_revision,price_snapshot,state,charged,started_at,lease_until,hold_until,error_class)
    VALUES (${crypto.randomUUID()},${id},'s',${crypto.randomUUID()},'openai','test-model','responses',
    ${policy.revision},'{}'::jsonb,'settled',5,now(),now(),now(),'client_disconnected')`;
  const activity = await reports.activity(30);
  expect(activity.series).toHaveLength(30);
  const today = activity.series.at(-1);
  expect(today).toMatchObject({ stopped: 1, failed: 0 });
  expect(Number(today?.calls)).toBeGreaterThanOrEqual(1);
  expect(activity.series.reduce((sum, day) => sum + Number(day.signups), 0)).toBeGreaterThan(0);
  await expect(reports.activity(7 as 30)).rejects.toMatchObject({ code: "invalid_request" });
});

test("overview reports spend against the active policy caps", async () => {
  const day = new Date().toISOString().slice(0, 10);
  await fixture.db.sql`INSERT INTO cloud_spend_bucket(key,amount) VALUES
    ('insights:total',1234),(${`insights:day:${day}`},567) ON CONFLICT(key) DO UPDATE SET amount=excluded.amount`;
  const overview = await reports.overview(1);
  expect(overview.budget).toEqual({
    scope: "insights",
    day,
    total: { spent: "1234", cap: "50000000" },
    daily: { spent: "567", cap: "10000000" },
    free_daily: { spent: "0", cap: "5000000" },
  });
});

test("jobs expose every durable queue with exhausted counts", async () => {
  const id = await account();
  await fixture.db.sql`UPDATE billing_customer SET attempts=10,next_attempt=now()-interval '1 hour'
    WHERE user_id=${id}`;
  const { queues } = await reports.jobs();
  expect(queues.map((q) => q.queue)).toEqual([
    "subscription_sync",
    "orders",
    "billing_contacts",
    "plan_changes",
    "usage_export",
    "unconfirmed_usage",
    "account_deletion",
  ]);
  const sync = queues.find((q) => q.queue === "subscription_sync");
  expect(Number(sync?.exhausted)).toBeGreaterThanOrEqual(1);
  expect(Number(sync?.oldest_due_seconds)).toBeGreaterThanOrEqual(3500);
});

test("user detail includes billing, grants, plan changes and checkouts without secrets", async () => {
  const id = await account();
  await fixture.db.sql`UPDATE billing_customer SET status='active',product_id=${proProduct},
    paid_until=now()+interval '5 days' WHERE user_id=${id}`;
  await fixture.db.sql`INSERT INTO credit_wallet(user_id) VALUES (${id})`;
  await fixture.db
    .sql`INSERT INTO credit_grant(id,user_id,grant_key,kind,policy_revision,plan_id,amount)
    VALUES (${crypto.randomUUID()},${id},'included:pro:x','included',${policy.revision},'pro',1000)`;
  await fixture.db
    .sql`INSERT INTO billing_checkout(checkout_id,user_id,product_id,policy_revision,kind,expires_at)
    VALUES ('secret-checkout-id',${id},${proProduct},${policy.revision},'subscription',now()+interval '1 hour')`;
  const detail = await reports.user(id);
  expect(detail.billing).toMatchObject({ status: "active", paying: true, product: "pro monthly" });
  expect(detail.grants).toHaveLength(1);
  expect(detail.grants[0]).toMatchObject({ kind: "included", amount: "1000", plan_id: "pro" });
  expect(detail.checkouts).toEqual([
    expect.objectContaining({ kind: "subscription", product: "pro monthly" }),
  ]);
  expect(JSON.stringify(detail)).not.toContain("secret-checkout-id");
});

test("audit lists operator events newest first with cursor pagination", async () => {
  const operator = crypto.randomUUID();
  await fixture.db
    .sql`INSERT INTO admin_auth_user(id,name,email) VALUES (${operator},'Op','op@example.test')`;
  for (let i = 0; i < 55; i++)
    await fixture.db.sql`INSERT INTO admin_audit_event(id,operator_id,action,target_id,created_at)
      VALUES (${crypto.randomUUID()},${operator},'user',${`target-${i}`},now()-${i}*interval '1 minute')`;
  const first = await reports.audit();
  expect(first.items).toHaveLength(50);
  expect(first.items[0]).toMatchObject({
    action: "user",
    target_id: "target-0",
    operator_email: "op@example.test",
  });
  const second = await reports.audit(first.next_cursor ?? undefined);
  expect(second.items.length).toBeGreaterThanOrEqual(5);
  expect(second.items[0]?.target_id).toBe("target-50");
});

test("user filters narrow the list", async () => {
  const id = await account();
  await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${id}`;
  const deleting = await reports.users("", undefined, "deleting");
  expect(deleting.items.every((row) => row.lifecycle === "deleting")).toBe(true);
  expect(deleting.items.some((row) => row.id === id)).toBe(true);
  await expect(reports.users("", undefined, "bogus" as "")).rejects.toMatchObject({
    code: "invalid_request",
  });
});
