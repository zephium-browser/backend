import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { registerPolicy } from "../../policy/policy";
import { queueBillingContactSync } from "../account-lifecycle";
import { processContactSync } from "../contact-sync";
import type { BillingProvider, CustomerState } from "../provider";
import { accountAccess } from "../service";
import { workOnce } from "../worker";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

function provider(overrides: Partial<BillingProvider> = {}): BillingProvider {
  return {
    state: async () => null,
    checkout: async () => {
      throw new Error("Unexpected checkout creation");
    },
    portal: async () => "https://sandbox.polar.sh/portal/test",
    deleteCustomer: async () => {},
    openCheckoutUntil: async () => null,
    ...overrides,
  };
}

async function account(touched = true) {
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
  await fixture.db.sql`UPDATE billing_contact_job SET next_attempt=now()+interval '1 day'`;
  const actor = await createCloudAccount(fixture.db);
  await fixture.db.sql`INSERT INTO billing_customer(user_id,provider_touched)
    VALUES (${actor.userId},${touched}) ON CONFLICT(user_id) DO UPDATE SET provider_touched=${touched}`;
  return { ...actor, email: `${actor.userId}@example.test` };
}

async function queuedEmail(userId: string, email: string) {
  await fixture.db.sql.begin(async (tx) => {
    await tx`UPDATE auth_user SET email=${email},email_verified=true WHERE id=${userId}`;
    await queueBillingContactSync(tx, userId);
  });
}

async function contactRow(userId: string) {
  return (
    await fixture.db.sql`SELECT requested,processed,attempts,next_attempt>now() AS retry_scheduled
      FROM billing_contact_job WHERE user_id=${userId}`
  )[0];
}

async function billingRow(userId: string) {
  return (
    await fixture.db
      .sql`SELECT requested,processed,attempts,provider_touched,status,paid_until,reconciled_at
      FROM billing_customer WHERE user_id=${userId}`
  )[0];
}

function customer(userId: string, email?: string | null): CustomerState {
  return { customerId: `polar-${userId}`, accountId: userId, email, subscriptions: [] };
}

test("queued contact changes coalesce to the latest verified email and reconcile once", async () => {
  const actor = await account();
  const before = await billingRow(actor.userId);
  await queuedEmail(actor.userId, `first-${actor.userId}@example.test`);
  const latest = `latest-${actor.userId}@example.test`;
  await queuedEmail(actor.userId, latest);
  let state = customer(actor.userId, "old@example.test");
  const writes: { accountId: string; email: string }[] = [];
  const remote = provider({
    state: async (id) => {
      expect(id).toBe(actor.userId);
      return state;
    },
    updateCustomerEmail: async (accountId, email) => {
      writes.push({ accountId, email });
      state = customer(accountId, email);
    },
  });
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  expect(writes).toEqual([{ accountId: actor.userId, email: latest }]);
  expect(await contactRow(actor.userId)).toMatchObject({ requested: 2, processed: 2, attempts: 0 });
  expect(await billingRow(actor.userId)).toEqual(before);
  expect(await processContactSync(fixture.db, remote)).toBe(false);
  await queuedEmail(actor.userId, latest);
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  expect(writes).toHaveLength(1);
  expect(await contactRow(actor.userId)).toMatchObject({ requested: 3, processed: 3, attempts: 0 });
});

test("an existing customer with no contact receives the verified account email", async () => {
  const actor = await account();
  await queuedEmail(actor.userId, actor.email);
  const writes: string[] = [];
  const remote = provider({
    state: async () => customer(actor.userId, null),
    updateCustomerEmail: async (id, email) => {
      expect(id).toBe(actor.userId);
      writes.push(email);
    },
  });
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  expect(writes).toEqual([actor.email]);
  expect(await contactRow(actor.userId)).toMatchObject({ requested: 1, processed: 1, attempts: 0 });
});

test("a lost update response retries by GET and does not resend an already applied email", async () => {
  const actor = await account();
  const before = await billingRow(actor.userId);
  const latest = `latest-${actor.userId}@example.test`;
  await queuedEmail(actor.userId, latest);
  let state = customer(actor.userId, "old@example.test");
  let writes = 0;
  const remote = provider({
    state: async () => state,
    updateCustomerEmail: async (accountId, email) => {
      writes++;
      state = customer(accountId, email);
      throw new TypeError("Synthetic lost response");
    },
  });
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  expect(await contactRow(actor.userId)).toMatchObject({
    requested: 1,
    processed: 0,
    attempts: 1,
    retry_scheduled: true,
  });
  expect(await billingRow(actor.userId)).toEqual(before);
  await fixture.db
    .sql`UPDATE billing_contact_job SET next_attempt=now() WHERE user_id=${actor.userId}`;
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  expect(writes).toBe(1);
  expect(await contactRow(actor.userId)).toMatchObject({ requested: 1, processed: 1, attempts: 0 });
  expect(await billingRow(actor.userId)).toEqual(before);
});

test("missing updater, unavailable contact state or identity mismatch keeps only contact work pending", async () => {
  for (const mode of ["no-updater", "no-contact-state", "identity-mismatch"]) {
    const actor = await account();
    const before = await billingRow(actor.userId);
    await queuedEmail(actor.userId, actor.email);
    let writes = 0;
    const remote = provider({
      state: async () =>
        customer(
          mode === "identity-mismatch" ? "other-account" : actor.userId,
          mode === "no-contact-state" ? undefined : "old@example.test",
        ),
      ...(mode !== "no-updater"
        ? {
            updateCustomerEmail: async () => {
              writes++;
            },
          }
        : {}),
    });
    expect(await processContactSync(fixture.db, remote)).toBe(true);
    expect(writes).toBe(0);
    expect(await contactRow(actor.userId)).toMatchObject({
      requested: 1,
      processed: 0,
      attempts: 1,
    });
    expect(await billingRow(actor.userId)).toEqual(before);
  }
});

test("absent customers and matching normalized email need no update or customer creation", async () => {
  for (const absent of [true, false]) {
    const actor = await account();
    await queuedEmail(actor.userId, actor.email);
    let writes = 0;
    const state = absent ? null : customer(actor.userId, ` ${actor.email.toUpperCase()} `);
    expect(
      await processContactSync(
        fixture.db,
        provider({
          state: async () => state,
          updateCustomerEmail: async () => {
            writes++;
          },
        }),
      ),
    ).toBe(true);
    expect(writes).toBe(0);
    expect(await contactRow(actor.userId)).toMatchObject({
      requested: 1,
      processed: 1,
      attempts: 0,
    });
  }
});

test("queuing an untouched free account creates neither a contact job nor a provider relationship", async () => {
  const actor = await account(false);
  await fixture.db
    .sql`UPDATE billing_customer SET attempts=10,next_attempt=now()+interval '1 day' WHERE user_id=${actor.userId}`;
  const before = await billingRow(actor.userId);
  await queuedEmail(actor.userId, actor.email);
  let calls = 0;
  const remote = provider({
    state: async () => {
      calls++;
      return null;
    },
    updateCustomerEmail: async () => {
      calls++;
    },
  });
  expect(await contactRow(actor.userId)).toBeUndefined();
  expect(await billingRow(actor.userId)).toEqual(before);
  expect(await processContactSync(fixture.db, remote)).toBe(false);
  expect(calls).toBe(0);
});

test("an existing Polar ID permits contact work without changing provider_touched", async () => {
  const actor = await account(false);
  await fixture.db
    .sql`UPDATE billing_customer SET polar_id=${`polar-${actor.userId}`} WHERE user_id=${actor.userId}`;
  const before = await billingRow(actor.userId);
  await queuedEmail(actor.userId, actor.email);
  let writes = 0;
  expect(
    await processContactSync(
      fixture.db,
      provider({
        state: async () => customer(actor.userId, "old@example.test"),
        updateCustomerEmail: async () => {
          writes++;
        },
      }),
    ),
  ).toBe(true);
  expect(writes).toBe(1);
  expect(await billingRow(actor.userId)).toEqual(before);
});

test("deleting or unverified accounts and pending plan changes leave contact work untouched", async () => {
  for (const mode of ["deleting", "unverified", "plan-change"]) {
    const actor = await account();
    await queuedEmail(actor.userId, actor.email);
    if (mode === "deleting") {
      await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${actor.userId}`;
    } else if (mode === "unverified") {
      await fixture.db.sql`UPDATE auth_user SET email_verified=false WHERE id=${actor.userId}`;
    } else {
      const policy = testPolicy();
      await registerPolicy(fixture.db, policy);
      await fixture.db
        .sql`INSERT INTO billing_plan_change(id,user_id,session_id,policy_revision,quote,state)
        VALUES (${crypto.randomUUID()},${actor.userId},${actor.sessionId},${policy.revision},'{}'::jsonb,'queued')`;
    }
    let calls = 0;
    const remote = provider({
      state: async () => {
        calls++;
        return customer(actor.userId, "old@example.test");
      },
      updateCustomerEmail: async () => {
        calls++;
      },
    });
    expect(await processContactSync(fixture.db, remote)).toBe(false);
    expect(calls).toBe(0);
    expect(await contactRow(actor.userId)).toMatchObject({
      requested: 1,
      processed: 0,
      attempts: 0,
    });
  }
});

test("exhausted contact sync cannot block paid subscription reconciliation", async () => {
  const actor = await account();
  await fixture.db.sql`UPDATE billing_customer SET requested=7,processed=6,attempts=0,
    status='inactive',paid_until=NULL,reconciled_at=now()-interval '25 hours' WHERE user_id=${actor.userId}`;
  const before = await billingRow(actor.userId);
  await queuedEmail(actor.userId, actor.email);
  await fixture.db.sql`UPDATE billing_contact_job SET attempts=9 WHERE user_id=${actor.userId}`;
  const productId = "00000000-0000-4000-8000-000000000501";
  const paidUntil = new Date(Date.now() + 86400000);
  let writes = 0;
  const remote = provider({
    state: async () => ({
      ...customer(actor.userId, "old@example.test"),
      subscriptions: [
        {
          id: "paid-subscription",
          productId,
          status: "active",
          paidUntil,
          cancelAtPeriodEnd: false,
        },
      ],
    }),
    updateCustomerEmail: async () => {
      writes++;
      throw new Error("Synthetic contact conflict");
    },
  });
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  expect(await contactRow(actor.userId)).toMatchObject({
    requested: 1,
    processed: 0,
    attempts: 10,
  });
  expect(await billingRow(actor.userId)).toEqual(before);
  // Exhausted contact work keeps retrying at the capped backoff instead of stopping forever.
  await fixture.db
    .sql`UPDATE billing_contact_job SET next_attempt=now() WHERE user_id=${actor.userId}`;
  expect(await processContactSync(fixture.db, remote)).toBe(true);
  const [retry] = await fixture.db
    .sql`SELECT attempts,next_attempt>now()+interval '59 minutes' AS capped FROM billing_contact_job WHERE user_id=${actor.userId}`;
  expect(retry).toMatchObject({ attempts: 11, capped: true });
  expect(await processContactSync(fixture.db, remote)).toBe(false);
  expect(await workOnce(fixture.db, remote, [productId])).toBe(true);
  expect(await billingRow(actor.userId)).toMatchObject({
    requested: 7,
    processed: 7,
    attempts: 0,
    status: "active",
  });
  expect(new Date((await billingRow(actor.userId))?.paid_until).toISOString()).toBe(
    paidUntil.toISOString(),
  );
  expect((await accountAccess(fixture.db, actor.userId)).paid).toBe(true);
  expect(await contactRow(actor.userId)).toMatchObject({
    requested: 1,
    processed: 0,
    attempts: 11,
  });
  expect(writes).toBe(2);
});
