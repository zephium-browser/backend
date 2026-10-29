import { afterAll, beforeAll, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createAdminReports } from "../../src/modules/admin/reports";
import { registerPolicy } from "../../src/modules/policy/policy";
import { testDatabase } from "../support/admin-database";
import { testPolicy } from "../support/cloud-fixture";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let reports: ReturnType<typeof createAdminReports>;
const policy = testPolicy();
beforeAll(async () => {
  fixture = await testDatabase();
  await registerPolicy(fixture.db, policy);
  reports = createAdminReports(fixture.db.sql);
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

async function owner(name = "Admin report test") {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  await fixture.db
    .sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${id},${name},${email},true)`;
  return { id, email };
}

test("report balances exclude expired/revoked credit but retain outstanding holds without granting on read", async () => {
  const account = await owner("<img src=x onerror=alert(1)>");
  const before = await reports.user(account.id);
  expect(before.balance).toEqual({ remaining_units: "0", reserved_units: "0", suspended: false });
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS n FROM credit_wallet WHERE user_id=${account.id}`
    )[0]?.n,
  ).toBe(0);
  await fixture.db.sql`INSERT INTO credit_wallet(user_id,suspended) VALUES (${account.id},true)`;
  for (const grant of [
    {
      key: "active",
      amount: "9007199254741003",
      spent: "2",
      held: "3",
      expires: null,
      revoked: false,
    },
    {
      key: "expired",
      amount: "100",
      spent: "2",
      held: "5",
      expires: "2000-01-01T00:00:00Z",
      revoked: false,
    },
    { key: "revoked", amount: "100", spent: "2", held: "7", expires: null, revoked: true },
  ]) {
    await fixture.db
      .sql`INSERT INTO credit_grant(id,user_id,grant_key,kind,policy_revision,amount,spent,held,expires_at,revoked)
      VALUES (${crypto.randomUUID()},${account.id},${grant.key},'topup',${policy.revision},${grant.amount},${grant.spent},${grant.held},${grant.expires}::timestamptz,${grant.revoked})`;
  }
  const sessionId = crypto.randomUUID();
  await fixture.db.sql`INSERT INTO auth_session(id,user_id,token,expires_at,ip_address,user_agent)
    VALUES (${sessionId},${account.id},'secret-session-token',now()+interval '1 day','192.0.2.1','secret-user-agent')`;
  await fixture.db.sql`INSERT INTO auth_session(id,user_id,token,expires_at)
    VALUES (${crypto.randomUUID()},${account.id},'expired-secret',now()-interval '1 day')`;
  const detail = await reports.user(account.id);
  expect(detail.balance).toEqual({
    remaining_units: "9007199254740998",
    reserved_units: "15",
    suspended: true,
  });
  expect(detail.user.name).toBe("<img src=x onerror=alert(1)>");
  expect(detail.sessions).toHaveLength(1);
  expect(detail.sessions[0]?.id).toBe(sessionId);
  expect(Object.keys(detail.user).sort()).toEqual(
    [
      "created_at",
      "email",
      "email_verified",
      "id",
      "lifecycle",
      "name",
      "paid_until",
      "plan",
      "product_id",
      "subscription_status",
    ].sort(),
  );
  expect(Object.keys(detail.sessions[0] ?? {}).sort()).toEqual(
    ["id", "device", "created_at", "expires_at"].sort(),
  );
  const serialized = JSON.stringify(detail);
  for (const secret of [
    "secret-session-token",
    "expired-secret",
    "192.0.2.1",
    "secret-user-agent",
    "grant_key",
  ])
    expect(serialized).not.toContain(secret);
  expect(detail.credit_units).toBe("10000");
});

test("users paginate identical and submillisecond timestamps without duplicates or omissions; search is exact", async () => {
  const prefix = crypto.randomUUID();
  const ids: string[] = [];
  for (let i = 0; i < 55; i++) {
    const id = `${prefix}-${String(i).padStart(3, "0")}`;
    ids.push(id);
    const stamp = `2090-01-01T00:00:00.${i === 54 ? "123457" : "123456"}Z`;
    await fixture.db.sql`INSERT INTO auth_user(id,name,email,created_at)
      VALUES (${id},'Page',${`${id}@example.test`},${stamp}::timestamptz)`;
  }
  const first = await reports.users("");
  expect(first.items).toHaveLength(50);
  expect(first.next_cursor).toBeString();
  const second = await reports.users("", first.next_cursor ?? undefined);
  const seen = [...first.items, ...second.items].map((item) => item.id);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.filter((id) => ids.includes(id))).toEqual([...ids].reverse());
  const account = await owner();
  expect((await reports.users(account.email.toUpperCase())).items.map((r) => r.id)).toEqual([
    account.id,
  ]);
  expect((await reports.users(account.id)).items.map((r) => r.id)).toEqual([account.id]);
  for (const q of [account.email.slice(1), "%", "' OR true --"])
    expect((await reports.users(q)).items).toHaveLength(0);
});

test("strict invalid inputs fail before reporting SQL and missing users return 404", async () => {
  for (const days of [0, 2, 31, "7", null]) {
    await expect(reports.overview(days as 1)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  }
  for (const q of ["x".repeat(321), "abc\u0000def", null]) {
    await expect(reports.users(q as string)).rejects.toMatchObject({ code: "invalid_request" });
  }
  for (const id of ["", "x".repeat(129), "abc\n", null]) {
    await expect(reports.user(id as string)).rejects.toMatchObject({ code: "invalid_request" });
  }
  for (const cursor of [
    "",
    "=",
    "x".repeat(513),
    Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ created_at: "2026-02-30T00:00:00.000000Z", id: "test" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({ created_at: "2026-01-01T00:00:00.000000Z", id: "test", extra: true }),
    ).toString("base64url"),
  ]) {
    await expect(reports.users("", cursor)).rejects.toMatchObject({ code: "invalid_request" });
  }
  await expect(reports.user("nonexistent-report-user")).rejects.toMatchObject({
    code: "not_found",
    status: 404,
  });
});

test("usage is bounded to the selected window and provider cost never uses retail charge or pending exposure", async () => {
  const account = await owner();
  await fixture.db.sql`INSERT INTO credit_wallet(user_id) VALUES (${account.id})`;
  const base = await reports.overview(1);
  const rates = {
    input: "2000000",
    cachedInput: "1000000",
    cacheWrite5m: "2000000",
    cacheWrite1h: "2000000",
    output: "3000000",
    searchCall: "0",
  };
  const usage = {
    input: 10,
    cachedInput: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 2,
    reasoning: 0,
    searchCalls: 0,
  };
  for (const row of [
    {
      state: "settled",
      days: 0,
      charge: "9007199254740993",
      dispatched: true,
      cost: true,
      error: null,
    },
    { state: "running", days: 0, charge: "0", dispatched: true, cost: false, error: null },
    {
      state: "released",
      days: 0,
      charge: "0",
      dispatched: false,
      cost: false,
      error: "provider_failed",
    },
    { state: "settled", days: 8, charge: "20", dispatched: true, cost: false, error: null },
    { state: "settled", days: 31, charge: "99999", dispatched: true, cost: false, error: null },
  ]) {
    const id = crypto.randomUUID();
    await fixture.db
      .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,
      price_snapshot,cost_rates,usage,state,charged,actual_cost,started_at,dispatched_at,lease_until,hold_until,error_class)
      VALUES (${id},${account.id},'session',${id},'openai','report-test-model','responses',${policy.revision},'{}'::jsonb,
      ${row.cost ? JSON.stringify(rates) : null}::jsonb,${JSON.stringify(usage)}::jsonb,${row.state},${row.charge},999999,
      now()-${row.days}*interval '1 day',${row.dispatched ? new Date().toISOString() : null}::timestamptz,now(),now(),${row.error})`;
    await fixture.db
      .sql`INSERT INTO cloud_cost_record(request_id,scope,day,reserved,exposure,free_reserved,free_exposure,terminal)
      VALUES (${id},'report-test',current_date,1000,${row.cost ? 26 : 777777},0,0,${row.state === "settled" || row.state === "released"})`;
  }
  const overview = await reports.overview(1);
  expect(overview.usage.calls - base.usage.calls).toBe(3);
  expect(overview.usage.dispatched - base.usage.dispatched).toBe(2);
  expect(overview.usage.settled - base.usage.settled).toBe(1);
  expect(overview.usage.failed - base.usage.failed).toBe(1);
  expect(BigInt(overview.usage.charged_units) - BigInt(base.usage.charged_units)).toBe(
    9007199254740993n,
  );
  expect(
    BigInt(overview.usage.provider_cost_usd_micros) - BigInt(base.usage.provider_cost_usd_micros),
  ).toBe(26n);
  expect(overview.usage.unknown_cost_calls - base.usage.unknown_cost_calls).toBe(1);
  expect(overview.budget.find((row) => row.key.startsWith("report-test:day:"))).toMatchObject({
    spent: "2333357",
    reserved: "777777",
  });
  expect(overview.models.find((row) => row.model_id === "report-test-model")).toEqual({
    model_id: "report-test-model",
    calls: 3,
    charged_units: "9007199254740993",
    provider_cost_usd_micros: "26",
  });
  expect(overview.errors.find((row) => row.code === "provider_failed")).toEqual({
    code: "provider_failed",
    count: 1,
  });
  expect(typeof overview.billing.active_subscriptions).toBe("number");
  const detail = await reports.user(account.id);
  expect(detail.usage).toEqual({
    calls: 4,
    charged_units: "9007199254741013",
    provider_cost_usd_micros: "26",
    unknown_cost_calls: 2,
  });
  expect(detail.requests).toHaveLength(4);
  expect(detail.requests.every((r) => r.charged !== "99999")).toBe(true);
  expect((await reports.overview(7)).usage.calls).toBe(overview.usage.calls);
  expect((await reports.overview(30)).usage.calls).toBe(overview.usage.calls + 1);
});

test("detail lists and overview groupings have fixed limits and stable ordering", async () => {
  const account = await owner();
  await fixture.db.sql`INSERT INTO credit_wallet(user_id) VALUES (${account.id})`;
  const ids: string[] = [];
  const createdAt = new Date().toISOString();
  for (let index = 0; index < 55; index++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await fixture.db.sql`INSERT INTO auth_session(id,user_id,token,expires_at,created_at)
      VALUES (${id},${account.id},${crypto.randomUUID()},now()+interval '1 day','2026-01-01T00:00:00Z')`;
    await fixture.db
      .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,
      price_snapshot,state,lease_until,hold_until,error_class,started_at)
      VALUES (${id},${account.id},'session',${id},'openai',${`model-${index}`},'responses',${policy.revision},'{}'::jsonb,
      'released',now(),now(),${`error-${index}`},${createdAt}::timestamptz)`;
  }
  const detail = await reports.user(account.id);
  expect(detail.sessions).toHaveLength(50);
  expect(detail.requests).toHaveLength(50);
  expect(detail.sessions.map((row) => row.id)).toEqual([...ids].sort().reverse().slice(0, 50));
  expect(detail.requests.map((row) => row.id)).toEqual([...ids].sort().reverse().slice(0, 50));
  const overview = await reports.overview(30);
  expect(overview.models).toHaveLength(20);
  expect(overview.errors).toHaveLength(20);
});

test("plan labels use the active stored policy, preserve unknown paid products, and never grant credit", async () => {
  const free = policy.plans[0];
  if (!free) throw new Error("Missing free test plan");
  const productId = crypto.randomUUID();
  const unrelatedProductId = crypto.randomUUID();
  const p = testPolicy({
    plans: [free, { ...free, id: "pro", rank: 1, allowanceUnits: "1000" }],
    subscriptions: [{ productId, plan: "pro", interval: "monthly" }],
  });
  await registerPolicy(fixture.db, p);
  // A newer but inactive policy must not supply either its free plan or its product mapping.
  await fixture.db.sql`INSERT INTO cloud_policy(revision,digest,configuration)
    VALUES (${p.revision + 10000},'test-inactive-policy',${JSON.stringify({ ...p, freePlan: "other-free", subscriptions: [{ productId: unrelatedProductId, plan: "other-pro", interval: "monthly" }] })}::jsonb)`;
  const users = await Promise.all([owner(), owner(), owner(), owner()]);
  const [freeUser, proUser, expiredUser, unknownUser] = users;
  if (!freeUser || !proUser || !expiredUser || !unknownUser) throw new Error("Missing plan users");
  await fixture.db
    .sql`UPDATE billing_customer SET status='active',product_id=${productId},paid_until=now()+interval '1 day' WHERE user_id=${proUser.id}`;
  await fixture.db
    .sql`UPDATE billing_customer SET status='active',product_id=${productId},paid_until=now()-interval '1 day' WHERE user_id=${expiredUser.id}`;
  await fixture.db
    .sql`UPDATE billing_customer SET status='active',product_id=${unrelatedProductId},paid_until=now()+interval '1 day' WHERE user_id=${unknownUser.id}`;
  const countBefore = (await reports.overview(1)).users.total;
  for (const [account, expected] of [
    [freeUser, "free"],
    [proUser, "pro"],
    [expiredUser, "free"],
    [unknownUser, "unknown"],
  ] as const) {
    expect((await reports.user(account.id)).user.plan).toBe(expected);
    expect((await reports.users(account.email)).items.map((row) => row.plan)).toEqual([expected]);
    expect(
      (
        await fixture.db
          .sql`SELECT count(*)::integer AS n FROM credit_wallet WHERE user_id=${account.id}`
      )[0]?.n,
    ).toBe(0);
  }
  expect((await reports.overview(1)).users.total).toBe(countBefore);
  const selfHosted = { ...p, revision: p.revision + 1, selfHostedPlan: "pro" };
  await registerPolicy(fixture.db, selfHosted);
  expect((await reports.user(freeUser.id)).user.plan).toBe("pro");
  expect((await reports.user(unknownUser.id)).user.plan).toBe("pro");
  await fixture.db.sql`DELETE FROM cloud_active_policy WHERE singleton=true`;
  expect((await reports.user(freeUser.id)).user.plan).toBe("unknown");
});

test("Linux export pages contain only subscriptions and exclude token material", async () => {
  await fixture.db
    .sql`INSERT INTO linux_waitlist(id,email,confirmation_hash,expires_at,confirmed_at,subscribed_at,consent_version)
    SELECT gen_random_uuid(),'linux-'||n||'@example.test',md5(n::text)||md5(n::text),now()+interval '1 day',
      CASE WHEN n<=203 THEN now()-interval '1 hour' ELSE NULL END,
      CASE WHEN n IN (204,205) THEN now()-interval '1 hour' ELSE NULL END,'linux-release-v1' FROM generate_series(1,207) n`;
  const first = await reports.linuxWaitlist();
  expect(first.available).toBe(true);
  expect(first.subscribed).toBe(205);
  expect(first.confirmed).toBe(203);
  expect(first.pending).toBe(2);
  expect(first.items).toHaveLength(200);
  const cursor = first.next_cursor;
  if (!cursor) throw new Error("Expected another page");
  const second = await reports.linuxWaitlist(cursor);
  expect(second.items).toHaveLength(5);
  expect(second.next_cursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((x) => x.id)).size).toBe(205);
  for (const row of [...first.items, ...second.items])
    expect(Object.keys(row).sort()).toEqual(["confirmed_at", "email", "id", "subscribed_at"]);
  await expect(reports.linuxWaitlist("invalid cursor")).rejects.toThrow();
});
