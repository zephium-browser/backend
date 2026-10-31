import { expect, test } from "bun:test";
import { testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { usageSummary } from "../../credits/ledger";
import { registerPolicy } from "../../policy/policy";
import { consumeActionCode, requestActionCode } from "../actions";
import {
  eligibilityKey,
  eligibilitySecret,
  grantMailboxKey,
  normalizeEmail,
  resolveEligibilityKey,
} from "../eligibility";
import { backfillGrantEligibility, prepareGrantEligibility } from "../grant-backfill";
import { assertGrantEligibilityReady, lockGrantGrouping } from "../grant-mailboxes";

type Fixture = Awaited<ReturnType<typeof testDatabase>>;
async function user(f: Fixture, email: string, legacy = false) {
  return f.db.sql.begin(async (tx) => {
    const id = crypto.randomUUID();
    const exact = eligibilityKey(eligibilitySecret(f.config), email);
    await tx`INSERT INTO email_eligibility(key) VALUES (${exact}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO auth_user(id,name,email,email_verified,eligibility_key) VALUES (${id},'Test',${email},true,${exact})`;
    const key = legacy
      ? exact
      : await resolveEligibilityKey(tx, eligibilitySecret(f.config), email);
    await tx`UPDATE auth_user SET eligibility_key=${key} WHERE id=${id}`;
    return { id, key, email };
  });
}
function oncePolicy() {
  const base = testPolicy();
  const free = base.plans[0];
  if (!free) throw new Error("Missing free plan");
  return testPolicy({
    welcomeUnits: "0",
    welcomeExpiresDays: null,
    plans: [{ ...free, cycle: { kind: "once" } }],
  });
}
async function change(f: Fixture, id: string, email: string) {
  let otp = "";
  await requestActionCode(
    f.config,
    f.db,
    {
      sendOTP: async (_email, code) => {
        otp = code;
      },
    },
    {
      userId: id,
      purpose: "email-change",
      destinationEmail: email,
    },
  );
  await consumeActionCode(
    f.config,
    f.db,
    { userId: id, purpose: "email-change", destinationEmail: email, otp },
    async (tx) => {
      await tx`UPDATE auth_user SET email=${email} WHERE id=${id}`;
    },
  );
}

test("versioned grant normalization groups only consumer Gmail aliases and leaves identities exact", () => {
  const secret = "x".repeat(40);
  expect(grantMailboxKey(secret, " A.L.I.C.E+one@GoogleMail.com ")).toBe(
    grantMailboxKey(secret, "alice@gmail.com"),
  );
  expect(grantMailboxKey(secret, "alice+two@gmail.com")).toBe(
    grantMailboxKey(secret, "alice@gmail.com"),
  );
  expect(grantMailboxKey(secret, "alice@gmail.com")).not.toBe(
    grantMailboxKey(secret, "alicia@gmail.com"),
  );
  expect(grantMailboxKey(secret, "alice+one@workspace.example")).toBeNull();
  expect(grantMailboxKey(secret, "alice+one@outlook.com")).toBeNull();
  expect(normalizeEmail(" A.L.I.C.E+one@GoogleMail.com ")).toBe("a.l.i.c.e+one@googlemail.com");
  expect(eligibilityKey(secret, "a.lice@gmail.com")).not.toBe(
    eligibilityKey(secret, "alice@gmail.com"),
  );
  expect(grantMailboxKey(secret, "alice@gmail.com")).not.toBe(
    eligibilityKey(secret, "alice@gmail.com"),
  );
});

test("concurrent Gmail aliases receive exactly one signup grant and stay separate accounts", async () => {
  const f = await testDatabase();
  try {
    const p = oncePolicy();
    await registerPolicy(f.db, p);
    const accounts = await Promise.all(
      ["a.lice+one@gmail.com", "alice+two@googlemail.com", "alice@gmail.com"].map(async (email) => {
        const account = await user(f, email);
        await usageSummary(f.db, p, account.id);
        return account;
      }),
    );
    const summaries = await Promise.all(
      accounts.flatMap((a) => Array.from({ length: 3 }, () => usageSummary(f.db, p, a.id))),
    );
    expect(summaries.filter((s) => s.credits_remaining === "100")).toHaveLength(3);
    const grants = await f.db.sql`SELECT user_id,amount FROM credit_grant`;
    expect(grants).toHaveLength(1);
    expect(String(grants[0]?.amount)).toBe("100");
    expect(new Set(accounts.map((a) => a.key)).size).toBe(3);
    expect(
      (await f.db.sql`SELECT email FROM auth_user ORDER BY email`).map((a) => a.email),
    ).toEqual(accounts.map((a) => a.email).sort());
    const outsider = await user(f, "alice+one@example.test");
    expect((await usageSummary(f.db, p, outsider.id)).credits_remaining).toBe("100");
  } finally {
    await f.close();
  }
}, 30000);

test("welcome and recurring free grants share one period while paid grants remain account owned", async () => {
  const f = await testDatabase();
  try {
    const base = testPolicy();
    const free = base.plans[0];
    if (!free) throw new Error("plan");
    const product = "00000000-0000-4000-8000-000000000299";
    const p = testPolicy({
      plans: [free, { ...free, id: "pro", rank: 1, allowanceUnits: "1000" }],
      subscriptions: [
        { plan: "pro", productId: product, interval: "monthly", checkoutEnabled: true },
      ],
    });
    await registerPolicy(f.db, p);
    const accounts = await Promise.all(
      ["monthly+one@gmail.com", "mon.thly+two@googlemail.com"].map((email) => user(f, email)),
    );
    await Promise.all(accounts.map((a) => usageSummary(f.db, p, a.id)));
    expect(
      (await f.db.sql`SELECT kind FROM credit_grant ORDER BY kind`).map((g) => g.kind),
    ).toEqual(["included", "welcome"]);
    for (const a of accounts)
      await f.db
        .sql`UPDATE billing_customer SET status='active',product_id=${product},paid_until=clock_timestamp()+interval '20 days',subscription_start=clock_timestamp(),reconciled_at=clock_timestamp() WHERE user_id=${a.id}`;
    const paid = await Promise.all(accounts.map((a) => usageSummary(f.db, p, a.id)));
    expect(paid.every((s) => s.plan === "pro")).toBe(true);
    expect(await f.db.sql`SELECT user_id FROM credit_grant WHERE plan_id='pro'`).toHaveLength(2);
    expect(await f.db.sql`SELECT id FROM credit_grant WHERE revoked`).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30000);

test("backfill preserves issued balances and imports dormant aliases before any new claim", async () => {
  const f = await testDatabase();
  try {
    const p = oncePolicy();
    await registerPolicy(f.db, p);
    const a = await user(f, "back.fill+old@gmail.com", true);
    const b = await user(f, "backfill+other@googlemail.com", true);
    await usageSummary(f.db, p, a.id);
    await usageSummary(f.db, p, b.id);
    await f.db.sql`UPDATE credit_grant SET spent=17 WHERE user_id=${a.id}`;
    const before = await f.db.sql`SELECT * FROM credit_grant ORDER BY id`;
    await f.db.sql`UPDATE grant_eligibility_migration SET complete=false`;
    await expect(assertGrantEligibilityReady(f.db)).rejects.toThrow("offline backfill");
    // API startup completes an incomplete backfill and is a no-op afterwards.
    await prepareGrantEligibility(f.db, eligibilitySecret(f.config));
    await assertGrantEligibilityReady(f.db);
    await prepareGrantEligibility(f.db, eligibilitySecret(f.config));
    expect(await backfillGrantEligibility(f.db, eligibilitySecret(f.config))).toBe(2);
    expect(Array.from(await f.db.sql`SELECT * FROM credit_grant ORDER BY id`)).toEqual(
      Array.from(before),
    );
    expect((await usageSummary(f.db, p, a.id)).credits_remaining).toBe("83");
    expect((await usageSummary(f.db, p, b.id)).credits_remaining).toBe("100");
    const c = await user(f, "b.a.c.k.f.i.l.l+new@gmail.com");
    expect((await usageSummary(f.db, p, c.id)).credits_remaining).toBe("0");
    expect(await f.db.sql`SELECT key FROM grant_eligibility_group`).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

test("Gmail grant history survives email change, deletion and a newly presented alias", async () => {
  const f = await testDatabase();
  try {
    const p = oncePolicy();
    await registerPolicy(f.db, p);
    const original = await user(f, "ke.ep+old@gmail.com");
    await usageSummary(f.db, p, original.id);
    await change(f, original.id, "destination@example.test");
    await f.db.sql`DELETE FROM auth_user WHERE id=${original.id}`;
    const aliases = await Promise.all(
      ["keep+new@googlemail.com", "destination@example.test"].map((email) => user(f, email)),
    );
    const summaries = await Promise.all(aliases.map((a) => usageSummary(f.db, p, a.id)));
    expect(summaries.every((s) => s.credits_remaining === "0")).toBe(true);
    expect(
      await f.db.sql`SELECT key FROM email_eligibility WHERE key=${original.key}`,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

test("email change joins future Gmail eligibility across groups without revoking either account's grant", async () => {
  const f = await testDatabase();
  try {
    const p = oncePolicy();
    await registerPolicy(f.db, p);
    const a = await user(f, "firstbox@gmail.com");
    const b = await user(f, "secondbox+old@gmail.com");
    await Promise.all([a, b].map((u) => usageSummary(f.db, p, u.id)));
    const before = await f.db.sql`SELECT * FROM credit_grant ORDER BY id`;
    await change(f, a.id, "second.box+changed@googlemail.com");
    expect(Array.from(await f.db.sql`SELECT * FROM credit_grant ORDER BY id`)).toEqual(
      Array.from(before),
    );
    expect(await f.db.sql`SELECT key FROM grant_eligibility_group`).toHaveLength(1);
    const future = await Promise.all(
      ["first.box+new@gmail.com", "secondbox+new@gmail.com"].map((email) => user(f, email)),
    );
    expect(
      (await Promise.all(future.map((u) => usageSummary(f.db, p, u.id)))).every(
        (s) => s.credits_remaining === "0",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);

test("an unavailable legacy deleted address remains exact-match protected and joins Gmail history on reappearance", async () => {
  const f = await testDatabase();
  try {
    const p = oncePolicy();
    await registerPolicy(f.db, p);
    const old = await user(f, "un.known+old@gmail.com", true);
    await usageSummary(f.db, p, old.id);
    await f.db.sql`DELETE FROM auth_user WHERE id=${old.id}`;
    await backfillGrantEligibility(f.db, eligibilitySecret(f.config));
    expect(await f.db.sql`SELECT mailbox_key FROM grant_eligibility_mailbox`).toHaveLength(0);
    const returned = await user(f, old.email);
    expect((await usageSummary(f.db, p, returned.id)).credits_remaining).toBe("0");
    const variant = await user(f, "unknown+new@googlemail.com");
    expect((await usageSummary(f.db, p, variant.id)).credits_remaining).toBe("0");
  } finally {
    await f.close();
  }
}, 30000);

test("paid one-time grants do not consume or inherit another alias's signup eligibility", async () => {
  const f = await testDatabase();
  try {
    const base = oncePolicy();
    const free = base.plans[0];
    if (!free) throw new Error("Missing free plan");
    const product = "00000000-0000-4000-8000-000000000298";
    const p = testPolicy({
      ...base,
      plans: [free, { ...free, id: "pro", rank: 1, allowanceUnits: "1000" }],
      subscriptions: [
        { plan: "pro", productId: product, interval: "monthly", checkoutEnabled: true },
      ],
    });
    await registerPolicy(f.db, p);
    const accounts = await Promise.all(
      ["paidonce+one@gmail.com", "paid.once+two@googlemail.com"].map((email) => user(f, email)),
    );
    await Promise.all(accounts.map((a) => usageSummary(f.db, p, a.id)));
    for (const a of accounts)
      await f.db
        .sql`UPDATE billing_customer SET status='active',product_id=${product},paid_until=clock_timestamp()+interval '20 days',subscription_start=clock_timestamp(),reconciled_at=clock_timestamp() WHERE user_id=${a.id}`;
    await Promise.all(accounts.map((a) => usageSummary(f.db, p, a.id)));
    expect(
      await f.db.sql`SELECT user_id FROM credit_grant WHERE grant_key='signup:pro'`,
    ).toHaveLength(2);
    expect(
      await f.db.sql`SELECT user_id FROM credit_grant WHERE grant_key='signup:free'`,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

test("backfill imports grants for an older account without an identity eligibility key", async () => {
  const f = await testDatabase();
  try {
    const p = oncePolicy();
    await registerPolicy(f.db, p);
    const a = await user(f, "missing.key@gmail.com", true);
    await f.db.sql`UPDATE auth_user SET eligibility_key=NULL WHERE id=${a.id}`;
    await usageSummary(f.db, p, a.id);
    expect(
      (await f.db.sql`SELECT signup_claimed_at FROM email_eligibility WHERE key=${a.key}`)[0]
        ?.signup_claimed_at,
    ).toBeNull();
    await backfillGrantEligibility(f.db, eligibilitySecret(f.config));
    const b = await user(f, "missingkey+new@gmail.com");
    expect((await usageSummary(f.db, p, b.id)).credits_remaining).toBe("0");
    expect((await usageSummary(f.db, p, a.id)).credits_remaining).toBe("100");
    expect(
      (await f.db.sql`SELECT eligibility_key FROM auth_user WHERE id=${a.id}`)[0]?.eligibility_key,
    ).toBe(a.key);
  } finally {
    await f.close();
  }
}, 30000);

test("changing an unclaimed Gmail address preserves its canonical welcome eligibility", async () => {
  const f = await testDatabase();
  try {
    const p = testPolicy();
    await registerPolicy(f.db, p);
    const a = await user(f, "unclaimed@gmail.com");
    await change(f, a.id, "un.claimed+next@googlemail.com");
    expect((await usageSummary(f.db, p, a.id)).credits_remaining).toBe("120");
    expect(await f.db.sql`SELECT kind FROM credit_grant WHERE kind='welcome'`).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

test("backfill never treats a paid one-time grant as evidence of a free signup claim", async () => {
  const f = await testDatabase();
  try {
    const base = oncePolicy();
    const free = base.plans[0];
    if (!free) throw new Error("plan");
    const product = "00000000-0000-4000-8000-000000000297";
    const p = testPolicy({
      ...base,
      plans: [free, { ...free, id: "pro", rank: 1, allowanceUnits: "1000" }],
      subscriptions: [
        { plan: "pro", productId: product, interval: "monthly", checkoutEnabled: true },
      ],
    });
    await registerPolicy(f.db, p);
    const paid = await user(f, "migrationpaid+old@gmail.com", true);
    await f.db
      .sql`UPDATE billing_customer SET status='active',product_id=${product},paid_until=clock_timestamp()+interval '20 days',subscription_start=clock_timestamp(),reconciled_at=clock_timestamp() WHERE user_id=${paid.id}`;
    await usageSummary(f.db, p, paid.id);
    await backfillGrantEligibility(f.db, eligibilitySecret(f.config));
    expect(
      (await f.db.sql`SELECT signup_claimed_at FROM email_eligibility WHERE key=${paid.key}`)[0]
        ?.signup_claimed_at,
    ).toBeNull();
    const freeAccount = await user(f, "migration.paid+new@googlemail.com");
    expect((await usageSummary(f.db, p, freeAccount.id)).credits_remaining).toBe("100");
    expect((await usageSummary(f.db, p, paid.id)).credits_remaining).toBe("1000");
  } finally {
    await f.close();
  }
}, 30000);

test("ordinary sign-in skips the exclusive fence while a new Gmail binding waits for it", async () => {
  const f = await testDatabase();
  let release: () => void = () => {};
  let holder: Promise<unknown> | undefined;
  try {
    const known = await user(f, "fast.path@gmail.com");
    const other = await user(f, "fast.path@example.test");
    let signalHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    holder = f.db.sql.begin(async (tx) => {
      await lockGrantGrouping(tx);
      signalHeld();
      await gate;
    });
    await held;
    const resolveBounded = (email: string) =>
      f.db.sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout='100ms'`;
        return resolveEligibilityKey(tx, eligibilitySecret(f.config), email);
      });
    expect(await resolveBounded(known.email)).toBe(known.key);
    expect(await resolveBounded(other.email)).toBe(other.key);
    // The PostgreSQL lock timeout proves the new mapping really waits for the
    // held fence, without relying on scheduler timing or arbitrary sleeps.
    await expect(resolveBounded("fastpath+new@googlemail.com")).rejects.toMatchObject({
      code: "55P03",
    });
    release();
    await holder;
    const fresh = await resolveBounded("fastpath+new@googlemail.com");
    expect(fresh).not.toBe(known.key);
    const groups = await f.db
      .sql`SELECT group_key FROM grant_eligibility_member WHERE identity_key IN (${known.key},${fresh})`;
    expect(new Set(groups.map((row) => row.group_key)).size).toBe(1);
  } finally {
    release();
    await holder;
    await f.close();
  }
}, 30000);
