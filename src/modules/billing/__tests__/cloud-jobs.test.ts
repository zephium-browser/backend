import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { exportUsage } from "../../credits";
import {
  markDispatched,
  openRequest,
  releaseRequest,
  reserveRequest,
  settleRequest,
} from "../../credits/ledger";
import { emptyUsage } from "../../credits/pricing";
import { registerPolicy } from "../../policy/policy";
import type { BillingProvider } from "../provider";
import { acceptEvent } from "../service";
import { processOrder } from "../usage-jobs";
import { workOnce } from "../worker";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

function syntheticProvider(overrides: Partial<BillingProvider> = {}): BillingProvider {
  return {
    state: async () => null,
    checkout: async () => ({
      url: "https://sandbox.polar.sh/checkout/test",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    portal: async () => "https://sandbox.polar.sh/portal/test",
    deleteCustomer: async () => {},
    openCheckoutUntil: async () => null,
    ...overrides,
  };
}

async function enqueueOrder(userId: string, orderId: string, eventId = crypto.randomUUID()) {
  await acceptEvent(fixture.db, eventId, JSON.stringify({ orderId }), userId, orderId);
}

async function orderJob(orderId: string) {
  return (
    await fixture.db
      .sql`SELECT requested,processed,attempts FROM billing_order_job WHERE order_id=${orderId}`
  )[0];
}

test("order identity must match the verified job owner", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const owner = await createCloudAccount(fixture.db);
  const other = await createCloudAccount(fixture.db);
  const orderId = crypto.randomUUID();
  await enqueueOrder(owner.userId, orderId);
  const provider = syntheticProvider({
    order: async (id) => ({
      id,
      userId: other.userId,
      productId: required(policy.topups[0]).productId,
      paid: true,
      refunded: false,
      createdAt: new Date(),
      policyRevision: policy.revision,
    }),
  });
  expect(await processOrder(fixture.db, policy, provider)).toBe(true);
  expect(await orderJob(orderId)).toMatchObject({ requested: 1, processed: 0, attempts: 1 });
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS count FROM credit_grant WHERE grant_key=${`polar-order:${orderId}`}`
    )[0]?.count,
  ).toBe(0);
});

test("replayed paid order events process once using the checkout policy revision", async () => {
  const original = testPolicy();
  await registerPolicy(fixture.db, original);
  const account = await createCloudAccount(fixture.db);
  const orderId = crypto.randomUUID();
  await enqueueOrder(account.userId, orderId);
  await enqueueOrder(account.userId, orderId);
  const revised = testPolicy({ topups: [{ ...required(original.topups[0]), units: "90" }] });
  await registerPolicy(fixture.db, revised);
  let fetches = 0;
  const provider = syntheticProvider({
    order: async (id) => {
      fetches++;
      return {
        id,
        userId: account.userId,
        productId: required(original.topups[0]).productId,
        paid: true,
        refunded: false,
        createdAt: new Date(),
        policyRevision: original.revision,
      };
    },
  });
  expect(await processOrder(fixture.db, revised, provider)).toBe(true);
  expect(await orderJob(orderId)).toMatchObject({ requested: 2, processed: 2, attempts: 0 });
  expect(
    (
      await fixture.db
        .sql`SELECT amount,policy_revision FROM credit_grant WHERE user_id=${account.userId} AND grant_key=${`polar-order:${orderId}`}`
    )[0],
  ).toMatchObject({ amount: "30", policy_revision: original.revision });
  expect(await processOrder(fixture.db, revised, provider)).toBe(false);
  await enqueueOrder(account.userId, orderId);
  expect(await processOrder(fixture.db, revised, provider)).toBe(true);
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS count FROM credit_grant WHERE user_id=${account.userId} AND grant_key=${`polar-order:${orderId}`}`
    )[0]?.count,
  ).toBe(1);
  expect(fetches).toBe(2);
});

test("usage outbox retries with stable externalId and no request content", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  await fixture.db
    .sql`UPDATE billing_customer SET polar_id='synthetic-customer' WHERE user_id=${account.userId}`;
  const model = required(policy.models[0]);
  const request = await openRequest(
    fixture.db,
    policy,
    model,
    account.userId,
    account.sessionId,
    crypto.randomUUID(),
    "/v1/chat/completions",
  );
  await reserveRequest(
    fixture.db,
    policy,
    model,
    request.id,
    account.userId,
    account.sessionId,
    12n,
    1,
  );
  await markDispatched(fixture.db, request.id, account.userId, account.sessionId);
  await settleRequest(
    fixture.db,
    request.id,
    account.userId,
    { ...emptyUsage(), input: 3, output: 1 },
    200,
    "synthetic-upstream-id",
  );
  const seen: Record<string, unknown>[] = [];
  const provider = syntheticProvider({
    ingestUsage: async (payload) => {
      seen.push(payload);
      if (seen.length === 1) throw new Error("acknowledgement lost after ingest");
    },
  });
  expect(await exportUsage(fixture.db, provider.ingestUsage?.bind(provider))).toBe(true);
  expect(
    (
      await fixture.db
        .sql`SELECT attempts,delivered_at FROM cloud_outbox WHERE request_id=${request.id}`
    )[0],
  ).toMatchObject({ attempts: 1, delivered_at: null });
  await fixture.db.sql`UPDATE cloud_outbox SET next_attempt=now() WHERE request_id=${request.id}`;
  expect(await exportUsage(fixture.db, provider.ingestUsage?.bind(provider))).toBe(true);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toEqual(seen[1]);
  expect(seen[0]?.externalId).toBe(request.id);
  expect(seen[0]?.externalCustomerId).toBe(account.userId);
  expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
    "externalCustomerId",
    "externalId",
    "metadata",
    "name",
    "timestamp",
  ]);
  expect(Object.keys((seen[0]?.metadata ?? {}) as Record<string, unknown>).sort()).toEqual([
    "cacheWrite1h",
    "cacheWrite5m",
    "cachedInput",
    "charged_units",
    "input",
    "model",
    "output",
    "policy_revision",
    "provider",
    "reasoning",
    "searchCalls",
  ]);
  expect(
    (
      await fixture.db
        .sql`SELECT delivered_at IS NOT NULL AS delivered FROM cloud_outbox WHERE request_id=${request.id}`
    )[0]?.delivered,
  ).toBe(true);
  expect(await exportUsage(fixture.db, provider.ingestUsage?.bind(provider))).toBe(false);
});

test("account deletion waits for an unsettled cloud request", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  const model = required(policy.models[0]);
  const request = await openRequest(
    fixture.db,
    policy,
    model,
    account.userId,
    account.sessionId,
    crypto.randomUUID(),
    "/v1/chat/completions",
  );
  await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,next_attempt=now() WHERE user_id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day' WHERE user_id<>${account.userId}`;
  let deletions = 0;
  const provider = syntheticProvider({
    deleteCustomer: async () => {
      deletions++;
    },
  });
  expect(await workOnce(fixture.db, provider, [])).toBe(true);
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS count FROM auth_user WHERE id=${account.userId}`
    )[0]?.count,
  ).toBe(1);
  expect(deletions).toBe(0);
  await releaseRequest(fixture.db, request.id, account.userId, "account_deleted");
  await fixture.db
    .sql`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${account.userId}`;
  expect(await workOnce(fixture.db, provider, [])).toBe(true);
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS count FROM auth_user WHERE id=${account.userId}`
    )[0]?.count,
  ).toBe(0);
  expect(deletions).toBe(1);
});

test("account deletion is not held forever by an exhausted order job", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  const orderId = crypto.randomUUID();
  await enqueueOrder(account.userId, orderId);
  await fixture.db.sql`UPDATE billing_order_job SET attempts=10 WHERE order_id=${orderId}`;
  await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,next_attempt=now() WHERE user_id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day' WHERE user_id<>${account.userId}`;
  expect(await workOnce(fixture.db, syntheticProvider(), [])).toBe(true);
  expect(await fixture.db.sql`SELECT id FROM auth_user WHERE id=${account.userId}`).toHaveLength(0);
});

test("customer requests do not wait on the billing row during provider I/O", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,reconciled_at=NULL,next_attempt=now() WHERE user_id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day' WHERE user_id<>${account.userId}`;
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = workOnce(
    fixture.db,
    syntheticProvider({
      state: async () => {
        entered();
        await blocked;
        return null;
      },
    }),
    [],
  );
  await inside;
  // A request-path lock on the same row must not wait for the provider.
  const [row] = await fixture.db.sql.begin(
    (tx) =>
      tx`SELECT user_id FROM billing_customer WHERE user_id=${account.userId} FOR SHARE NOWAIT`,
  );
  expect(row?.user_id).toBe(account.userId);
  release();
  expect(await work).toBe(true);
  const [after] = await fixture.db
    .sql`SELECT attempts,reconciled_at IS NOT NULL AS reconciled FROM billing_customer WHERE user_id=${account.userId}`;
  expect(after).toMatchObject({ attempts: 0, reconciled: true });
});

test("a database failure during billing work still records backoff", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,attempts=0,next_attempt=now() WHERE user_id=${account.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day' WHERE user_id<>${account.userId}`;
  // Hold the account row so the purge transaction hits the lock timeout.
  const holder = fixture.db.sql.begin(async (tx) => {
    await tx`SELECT id FROM auth_user WHERE id=${account.userId} FOR UPDATE`;
    await Bun.sleep(4000);
  });
  await Bun.sleep(100);
  expect(await workOnce(fixture.db, syntheticProvider(), [])).toBe(true);
  await holder;
  const [after] = await fixture.db
    .sql`SELECT attempts,next_attempt>now() AS deferred FROM billing_customer WHERE user_id=${account.userId}`;
  expect(after).toMatchObject({ attempts: 1, deferred: true });
});

test("a refunded or charged-back subscription order ends that period's paid access", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  const product = crypto.randomUUID();
  const polarCustomer = `cus_${crypto.randomUUID()}`;
  const day = 86400_000;
  let periodStart = new Date(Date.now() - day);
  const provider = syntheticProvider({
    state: async (accountId) => ({
      customerId: polarCustomer,
      accountId,
      subscriptions: [
        {
          id: "sub_reversal",
          productId: product,
          status: "active",
          periodStart,
          paidUntil: new Date(periodStart.getTime() + 30 * day),
          cancelAtPeriodEnd: false,
        },
      ],
    }),
    order: async (id) => ({
      id,
      userId: account.userId,
      productId: product,
      paid: true,
      refunded: true,
      createdAt: new Date(Date.now() - day),
      subscriptionId: "sub_reversal",
    }),
  });
  const reconcile = async () => {
    await fixture.db
      .sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day' WHERE user_id<>${account.userId}`;
    expect(await workOnce(fixture.db, provider, [product])).toBe(true);
    return (
      await fixture.db
        .sql`SELECT status,requested>processed AS pending FROM billing_customer WHERE user_id=${account.userId}`
    )[0];
  };
  await acceptEvent(fixture.db, crypto.randomUUID(), "{}", account.userId);
  expect(await reconcile()).toMatchObject({ status: "active", pending: false });

  // Refund events name only the Polar customer; the reconciled link resolves the account.
  const orderId = crypto.randomUUID();
  await acceptEvent(fixture.db, crypto.randomUUID(), "{}", null, orderId, polarCustomer);
  await fixture.db
    .sql`UPDATE billing_order_job SET next_attempt=now()+interval '1 day' WHERE order_id<>${orderId}`;
  expect(await processOrder(fixture.db, policy, provider)).toBe(true);
  expect(await orderJob(orderId)).toMatchObject({ processed: 1, attempts: 0 });
  expect(await reconcile()).toMatchObject({ status: "inactive", pending: false });

  // A replayed refund changes nothing; a paid renewal opens a new period.
  await acceptEvent(fixture.db, crypto.randomUUID(), "{}", null, orderId, polarCustomer);
  expect(await processOrder(fixture.db, policy, provider)).toBe(true);
  periodStart = new Date();
  await acceptEvent(fixture.db, crypto.randomUUID(), "{}", account.userId);
  expect(await reconcile()).toMatchObject({ status: "active", pending: false });
});
