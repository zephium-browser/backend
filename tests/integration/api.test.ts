import { afterAll, beforeAll, expect, test } from "bun:test";
import { Webhook } from "standardwebhooks";
import { migrate } from "../../scripts/migrate";
import { clientAddress, createApp } from "../../src/apps/api/app";
import {
  type BillingProvider,
  type CustomerState,
  verifyBillingEvent,
} from "../../src/modules/billing/provider";
import {
  acceptEvent,
  accountAccess,
  subscriptionDecision,
} from "../../src/modules/billing/service";
import { workOnce } from "../../src/modules/billing/worker";
import { createAuth, type Mailer } from "../../src/modules/identity/auth";
import { consume } from "../../src/platform/abuse";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const mail = new Map<string, string>();
const mailer: Mailer = {
  sendOTP: async (email, otp) => {
    mail.set(email, otp);
  },
};
async function waitForMail(email: string) {
  for (let i = 0; i < 200; i++) {
    const otp = mail.get(email);
    if (otp) return otp;
    await Bun.sleep(10);
  }
  throw new Error("Expected in-memory email was not dispatched");
}
const states = new Map<string, CustomerState>();
let failing = false;
const provider: BillingProvider = {
  state: async (id) => {
    if (failing) throw new Error("provider down");
    return states.get(id) ?? null;
  },
  checkout: async () => ({
    url: "https://sandbox.polar.sh/checkout/test",
    expiresAt: new Date(Date.now() + 3600_000),
  }),
  portal: async () => "https://sandbox.polar.sh/portal/test",
  openCheckoutUntil: async () => null,
  deleteCustomer: async (id) => {
    if (failing) throw new Error("provider down");
    states.delete(id);
  },
};
beforeAll(async () => {
  fixture = await testDatabase();
  const auth = createAuth(fixture.config, fixture.db, mailer);
  app = createApp(fixture.config, fixture.db, auth, provider, undefined, undefined, mailer);
}, 30000);
afterAll(async () => {
  await fixture?.close();
});
async function request(path: string, method = "GET", body?: unknown, token?: string) {
  return app.request(`http://localhost:3000${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function sendCode(email: string) {
  mail.delete(email);
  const response = await request("/api/auth/email-otp/send-verification-otp", "POST", {
    email,
    type: "sign-in",
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  return waitForMail(email);
}
async function login(email = `${crypto.randomUUID()}@example.test`, device = "Test Mac") {
  const otp = await sendCode(email);
  const response = await request("/api/auth/sign-in/email-otp", "POST", { email, otp, device });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  const body = (await response.json()) as { user: { id: string } };
  return { email, otp, token: token as string, id: body.user.id };
}
test("email code redeems once and issues revocable native sessions", async () => {
  const email = `${crypto.randomUUID()}@example.test`;
  const otp = await sendCode(email);
  const responses = await Promise.all(
    [1, 2].map(() =>
      request("/api/auth/sign-in/email-otp", "POST", { email, otp, device: "Laptop" }),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  const signedIn = responses.find((r) => r.status === 200);
  if (!signedIn) throw new Error("Missing successful sign-in");
  const token = signedIn.headers.get("set-auth-token") as string;
  expect(token).toBeTruthy();
  expect((await request("/v1/account", "GET", undefined, token)).status).toBe(200);
  const sessions = (await (await request("/v1/sessions", "GET", undefined, token)).json()) as {
    sessions: Record<string, unknown>[];
  };
  expect(sessions.sessions).toHaveLength(1);
  expect(sessions.sessions[0]).toMatchObject({ device: "Laptop", current: true });
  expect(sessions.sessions[0]).not.toHaveProperty("token");
  expect((await request("/v1/logout", "POST", undefined, token)).status).toBe(204);
  expect((await request("/v1/account", "GET", undefined, token)).status).toBe(401);
});
test("shared limits are atomic and session deletion is scoped to its owner", async () => {
  const key = crypto.randomUUID();
  const limits = await Promise.all(
    Array.from({ length: 12 }, () => consume(fixture.db, key, 60, 3)),
  );
  expect(limits.filter((r) => r.allowed)).toHaveLength(3);
  const a = await login();
  const b = await login();
  const [session] = await fixture.db.sql`SELECT id FROM auth_session WHERE user_id=${b.id}`;
  await request(`/v1/sessions/${session?.id}`, "DELETE", undefined, a.token);
  expect((await request("/v1/account", "GET", undefined, b.token)).status).toBe(200);
  expect((await request("/api/auth/sign-up/email", "POST", {})).status).toBe(404);
  expect(
    (
      await app.request("http://localhost:3000/v1/account", {
        headers: { origin: "https://hostile.test" },
      })
    ).status,
  ).toBe(403);
});
test("code resend and redemption limits include real retry delays", async () => {
  const email = `${crypto.randomUUID()}@example.test`;
  const otp = await sendCode(email);
  const resend = await request("/api/auth/email-otp/send-verification-otp", "POST", {
    email,
    type: "sign-in",
  });
  expect(resend.status).toBe(429);
  expect(Number(resend.headers.get("Retry-After"))).toBeGreaterThan(0);
  const wrongCode = otp === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++)
    expect(
      (await request("/api/auth/sign-in/email-otp", "POST", { email, otp: wrongCode })).status,
    ).toBe(401);
  const blocked = await request("/api/auth/sign-in/email-otp", "POST", { email, otp });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
});
test("name edits and session listings stay scoped to the current account and device", async () => {
  const first = await login(undefined, "MacBook");
  expect((await request("/v1/account", "PATCH", { name: "  Alice  " }, first.token)).status).toBe(
    200,
  );
  const account = (await (await request("/v1/account", "GET", undefined, first.token)).json()) as {
    name: string;
  };
  expect(account.name).toBe("Alice");
  expect((await request("/v1/account", "PATCH", { name: "bad\nname" }, first.token)).status).toBe(
    400,
  );
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=now()-interval '1 second'`;
  const second = await login(first.email, "iPad");
  expect(second.id).toBe(first.id);
  const listed = (await (await request("/v1/sessions", "GET", undefined, second.token)).json()) as {
    sessions: { id: string; device: string | null; current: boolean; token?: string }[];
  };
  expect(listed.sessions).toHaveLength(2);
  expect(listed.sessions.find((item) => item.current)?.device).toBe("iPad");
  expect(listed.sessions.find((item) => !item.current)?.device).toBe("MacBook");
  expect(listed.sessions.every((item) => item.token === undefined)).toBe(true);
  const exported = (await (
    await request("/v1/account/export", "GET", undefined, second.token)
  ).json()) as { sessions: { current: boolean; device: string | null }[] };
  expect(exported.sessions.find((item) => item.current)?.device).toBe("iPad");
});

test("email change requires a new-address code, retains account ID and revokes old sessions", async () => {
  const user = await login();
  const target = `${crypto.randomUUID()}@example.test`;
  expect(
    (await request("/v1/account/email", "PATCH", { email: target, otp: "000000" }, user.token))
      .status,
  ).toBe(401);
  mail.delete(target);
  expect(
    (await request("/v1/account/email/code", "POST", { email: target }, user.token)).status,
  ).toBe(202);
  const code = await waitForMail(target);
  const changed = await request(
    "/v1/account/email",
    "PATCH",
    { email: target, otp: code },
    user.token,
  );
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ updated: true, reauthentication_required: true });
  expect((await request("/v1/account", "GET", undefined, user.token)).status).toBe(401);
  const next = await login(target);
  expect(next.id).toBe(user.id);
  await fixture.db
    .sql`UPDATE auth_session SET created_at=now()-interval '20 minutes' WHERE user_id=${next.id}`;
  expect(
    (await request("/v1/account/email/code", "POST", { email: user.email }, next.token)).status,
  ).toBe(401);
});

test("webhooks verify exact bytes in both signing formats and deduplicate durably", async () => {
  const user = await login();
  const body = JSON.stringify({ type: "customer.state_changed", data: { external_id: user.id } });
  for (const format of ["standard", "legacy"] as const) {
    const secret = `whsec_${Buffer.from("a sufficiently long webhook secret").toString("base64")}`;
    const key = format === "legacy" ? Buffer.from(secret).toString("base64") : secret;
    const wh = new Webhook(key);
    const now = new Date();
    const id = `evt_${format}`;
    const headers = new Headers({
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": wh.sign(id, now, body),
    });
    const hookConfig = {
      ...fixture.config,
      POLAR_WEBHOOK_SECRET: secret,
      POLAR_WEBHOOK_FORMAT: format,
    };
    const hookApp = createApp(
      hookConfig,
      fixture.db,
      createAuth(hookConfig, fixture.db, mailer),
      provider,
      undefined,
      undefined,
      mailer,
    );
    // The public router authenticates raw signed bytes, without an account session.
    expect(
      (
        await hookApp.request("http://localhost:3000/webhooks/polar", {
          method: "POST",
          headers,
          body,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await hookApp.request("http://localhost:3000/webhooks/polar", {
          method: "POST",
          headers,
          body: `${body} `,
        })
      ).status,
    ).toBe(403);
    expect(verifyBillingEvent(body, headers, secret, format).accountId).toBe(user.id);
    expect(() => verifyBillingEvent(`${body} `, headers, secret, format)).toThrow();
    await Promise.all([
      acceptEvent(fixture.db, id, body, user.id),
      acceptEvent(fixture.db, id, body, user.id),
    ]);
    expect((await fixture.db.sql`SELECT id FROM billing_event WHERE id=${id}`).length).toBe(1);
    await expect(acceptEvent(fixture.db, id, `${body} `, user.id)).rejects.toThrow();
  }
});
test("refund and dispute events route to their order and Polar customer", () => {
  const secret = `whsec_${Buffer.from("a sufficiently long webhook secret").toString("base64")}`;
  const sign = (type: string, data: Record<string, unknown>) => {
    const body = JSON.stringify({ type, data });
    const now = new Date();
    const headers = new Headers({
      "webhook-id": `evt_${type.replace(".", "_")}`,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign(`evt_${type.replace(".", "_")}`, now, body),
    });
    return verifyBillingEvent(body, headers, secret, "standard");
  };
  expect(
    sign("refund.updated", { id: "ref_1", order_id: "ord_1", customer_id: "cus_1", dispute: {} }),
  ).toMatchObject({ accountId: null, orderId: "ord_1", customerId: "cus_1" });
  expect(
    sign("order.refunded", { id: "ord_2", customer_id: "cus_2", customer: { external_id: "u" } }),
  ).toMatchObject({ accountId: "u", orderId: "ord_2", customerId: null });
  expect(sign("subscription.updated", { id: "sub_1", customer_id: "cus_3" })).toMatchObject({
    orderId: null,
    customerId: null,
  });
});
test("billing preserves paid cancellation periods; trials, foreign products, and expiration do not grant access", () => {
  const s: CustomerState = {
    customerId: "p",
    accountId: "a",
    subscriptions: [
      {
        productId: "paid",
        status: "active",
        paidUntil: new Date(Date.now() + 60000),
        cancelAtPeriodEnd: true,
      },
    ],
  };
  expect(subscriptionDecision(s, ["paid"]).status).toBe("active");
  expect(subscriptionDecision(s, ["other"]).status).toBe("inactive");
  expect(subscriptionDecision(s, ["paid"], new Date(Date.now() + 120000)).status).toBe("inactive");
  const subscription = s.subscriptions[0];
  if (!subscription) throw new Error("Missing fixture subscription");
  subscription.status = "trialing";
  expect(subscriptionDecision(s, ["paid"]).status).toBe("inactive");
});
test("deletion seals access, survives provider failure, and finishes after retry", async () => {
  const u = await login();
  await fixture.db.sql`UPDATE billing_customer SET provider_touched=true WHERE user_id=${u.id}`;
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
  failing = true;
  mail.delete(u.email);
  expect((await request("/v1/account/deletion/code", "POST", {}, u.token)).status).toBe(202);
  const code = await waitForMail(u.email);
  expect((await request("/v1/account/deletion", "POST", { otp: code }, u.token)).status).toBe(202);
  expect((await request("/v1/account", "GET", undefined, u.token)).status).toBe(401);
  await workOnce(fixture.db, provider, []);
  expect(
    (await fixture.db.sql`SELECT lifecycle FROM auth_user WHERE id=${u.id}`)[0]?.lifecycle,
  ).toBe("deleting");
  failing = false;
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${u.id}`;
  await workOnce(fixture.db, provider, []);
  expect((await fixture.db.sql`SELECT id FROM auth_user WHERE id=${u.id}`).length).toBe(0);
});
test("migrations are repeatable and spoofed proxy headers are ignored", async () => {
  await migrate(fixture.db);
  expect(
    clientAddress("192.0.2.1", new Headers({ "x-forwarded-for": "203.0.113.1" }), "10.0.0.0/8"),
  ).toBe("192.0.2.1");
  expect(
    clientAddress(
      "10.0.0.2",
      new Headers({ "x-forwarded-for": "forged, 203.0.113.1" }),
      "10.0.0.0/8",
    ),
  ).toBe("203.0.113.1");
});

test("expired sign-in codes fail, while an old session can delete after a fresh code", async () => {
  const email = `${crypto.randomUUID()}@example.test`;
  const otp = await sendCode(email);
  await fixture.db
    .sql`UPDATE auth_verification SET expires_at=now()-interval '1 minute' WHERE identifier=${`sign-in-otp-${email}`}`;
  expect((await request("/api/auth/sign-in/email-otp", "POST", { email, otp })).status).toBe(401);
  const u = await login();
  await fixture.db
    .sql`UPDATE auth_session SET created_at=now()-interval '20 minutes' WHERE user_id=${u.id}`;
  mail.delete(u.email);
  expect((await request("/v1/account/deletion/code", "POST", {}, u.token)).status).toBe(202);
  const code = await waitForMail(u.email);
  expect((await request("/v1/account/deletion", "POST", { otp: code }, u.token)).status).toBe(202);
  expect((await request("/v1/account", "GET", undefined, u.token)).status).toBe(401);
});
test("workers serialize per customer and a delayed event reconciles current provider state", async () => {
  const u = await login();
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,next_attempt=now() WHERE user_id=${u.id}`;
  const active: CustomerState = {
    accountId: u.id,
    customerId: crypto.randomUUID(),
    subscriptions: [
      {
        productId: fixture.config.POLAR_MONTHLY_PRODUCT_ID as string,
        status: "active",
        paidUntil: new Date(Date.now() + 60000),
        cancelAtPeriodEnd: true,
      },
    ],
  };
  let enter: () => void = () => {};
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  let finish: (v: CustomerState) => void = () => {};
  const result = new Promise<CustomerState>((r) => {
    finish = r;
  });
  const blocked = {
    ...provider,
    state: async () => {
      enter();
      return result;
    },
  };
  const first = workOnce(fixture.db, blocked, [fixture.config.POLAR_MONTHLY_PRODUCT_ID as string]);
  await entered;
  expect(await workOnce(fixture.db, provider, [])).toBe(false);
  const delayed = acceptEvent(fixture.db, `late_${crypto.randomUUID()}`, "signed-old-event", u.id);
  finish(active);
  await first;
  await delayed;
  expect((await accountAccess(fixture.db, u.id)).paid).toBe(true);
  // A stale event cannot restore old access: every event fetches current provider state.
  states.set(u.id, { ...active, subscriptions: [] });
  await workOnce(fixture.db, provider, [fixture.config.POLAR_MONTHLY_PRODUCT_ID as string]);
  expect((await accountAccess(fixture.db, u.id)).paid).toBe(false);
});

test("checkout binds the caller and configured product; deletion waits out a pending checkout", async () => {
  const u = await login();
  let argumentsSeen: string[] = [];
  const checkoutProvider = {
    ...provider,
    checkout: async (id: string, email: string, product: string) => {
      argumentsSeen = [id, email, product];
      return {
        url: "https://sandbox.polar.sh/checkout/owned",
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
  };
  const config = { ...fixture.config, BILLING_ENABLED: "true" as const };
  const auth = createAuth(config, fixture.db, mailer);
  const enabledApp = createApp(
    config,
    fixture.db,
    auth,
    checkoutProvider,
    undefined,
    undefined,
    mailer,
  );
  const post = (path: string, body: unknown) =>
    enabledApp.request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${u.token}` },
      body: JSON.stringify(body),
    });
  expect(
    (await post("/v1/billing/checkout", { interval: "monthly", customerId: "someone-else" }))
      .status,
  ).toBe(400);
  expect(argumentsSeen).toEqual([]);
  expect((await post("/v1/billing/checkout", { interval: "monthly" })).status).toBe(200);
  expect(argumentsSeen).toEqual([u.id, u.email, config.POLAR_MONTHLY_PRODUCT_ID as string]);
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
  mail.delete(u.email);
  expect((await post("/v1/account/deletion/code", {})).status).toBe(202);
  const code = await waitForMail(u.email);
  expect((await post("/v1/account/deletion", { otp: code })).status).toBe(202);
  await workOnce(fixture.db, provider, []);
  expect(
    (await fixture.db.sql`SELECT lifecycle FROM auth_user WHERE id=${u.id}`)[0]?.lifecycle,
  ).toBe("deleting");
});

test("email change waits for an in-flight code sign-in and revokes that session", async () => {
  const user = await login();
  const target = `${crypto.randomUUID()}@example.test`;
  mail.delete(target);
  expect(
    (await request("/v1/account/email/code", "POST", { email: target }, user.token)).status,
  ).toBe(202);
  const changeCode = await waitForMail(target);
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=now()-interval '1 second'`;
  const signInCode = await sendCode(user.email);
  await fixture.db
    .sql`CREATE FUNCTION api_test_hold_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(946357196); RETURN NEW; END $$`;
  await fixture.db
    .sql`CREATE TRIGGER api_test_hold_session BEFORE INSERT ON auth_session FOR EACH ROW EXECUTE FUNCTION api_test_hold_session()`;
  let release: () => void = () => {};
  let acquired: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = fixture.db.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(946357196)`;
    acquired();
    await gate;
  });
  try {
    await ready;
    const signIn = Promise.resolve(
      request("/api/auth/sign-in/email-otp", "POST", { email: user.email, otp: signInCode }),
    );
    let waiters = 0;
    for (let i = 0; i < 200; i++) {
      const [state] = await fixture.db
        .sql`SELECT count(*)::integer AS waiters FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`;
      waiters = Number(state?.waiters ?? 0);
      if (waiters >= 1) break;
      await Bun.sleep(5);
    }
    expect(waiters).toBeGreaterThanOrEqual(1);
    const changed = Promise.resolve(
      request("/v1/account/email", "PATCH", { email: target, otp: changeCode }, user.token),
    );
    for (let i = 0; i < 200; i++) {
      const [state] = await fixture.db
        .sql`SELECT count(*)::integer AS waiters FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`;
      waiters = Number(state?.waiters ?? 0);
      if (waiters >= 2) break;
      await Bun.sleep(5);
    }
    expect(waiters).toBeGreaterThanOrEqual(2);
    release();
    await holder;
    const [signInResponse, changedResponse] = await Promise.all([signIn, changed]);
    expect(signInResponse.status).toBe(200);
    expect(changedResponse.status).toBe(200);
    const racedToken = signInResponse.headers.get("set-auth-token");
    expect(racedToken).toBeTruthy();
    expect((await request("/v1/account", "GET", undefined, racedToken as string)).status).toBe(401);
    expect((await request("/v1/account", "GET", undefined, user.token)).status).toBe(401);
  } finally {
    release();
    await holder;
    await fixture.db.sql`DROP TRIGGER api_test_hold_session ON auth_session`;
    await fixture.db.sql`DROP FUNCTION api_test_hold_session()`;
  }
});

test("application role cannot rewrite migration history", async () => {
  await fixture.db.sql`CREATE ROLE zephium_app`;
  await fixture.db.sql`GRANT SELECT,INSERT,UPDATE,DELETE ON schema_migration TO zephium_app`;
  try {
    await migrate(fixture.db);
    const [privileges] = await fixture.db
      .sql`SELECT has_table_privilege('zephium_app','schema_migration','SELECT') AS readable,has_table_privilege('zephium_app','schema_migration','INSERT') AS writable`;
    expect(privileges?.readable).toBe(true);
    expect(privileges?.writable).toBe(false);
    await expect(
      fixture.db.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE zephium_app`;
        await tx`DELETE FROM schema_migration`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await fixture.db.sql`REVOKE ALL ON schema_migration FROM zephium_app`;
    await fixture.db.sql`DROP ROLE zephium_app`;
  }
});
