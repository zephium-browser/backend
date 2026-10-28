import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { testDatabase } from "../../../tests/support/database";
import { createApp } from "../../apps/api/app";
import { readConfig } from "../../platform/config";
import type { BillingProvider } from "../billing";
import { createAuth, type Mailer } from "../identity";
import { cleanupWaitlist, type WaitlistMessage } from "./service";

let f: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const sent: WaitlistMessage[] = [];
let failMail = false;
let blockMail = false;
let mailResolves: (() => void)[] = [];
const origin = "https://zephium.example.test";
const provider: BillingProvider = {
  state: async () => null,
  checkout: async () => {
    throw new Error();
  },
  portal: async () => {
    throw new Error();
  },
  deleteCustomer: async () => {},
  openCheckoutUntil: async () => null,
};
const mailer: Mailer = {
  sendOTP: async () => {
    throw new Error("Identity email must not be used");
  },
};
function build(overrides: Record<string, string> = {}) {
  const config = readConfig({
    ...Object.fromEntries(Object.entries(f.config).map(([k, v]) => [k, String(v)])),
    WAITLIST_ENABLED: "true",
    WAITLIST_WEB_ORIGIN: origin,
    ...overrides,
  });
  return createApp(
    config,
    f.db,
    createAuth(config, f.db, mailer),
    provider,
    () => "192.0.2.1",
    undefined,
    mailer,
    async (message) => {
      if (failMail) throw new Error("provider details must not escape");
      sent.push(message);
      if (blockMail)
        await new Promise<void>((resolve) => {
          mailResolves.push(resolve);
        });
    },
  );
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://localhost:3000/v1/waitlists/linux${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function message(index: number): WaitlistMessage {
  const value = sent[index];
  if (!value) throw new Error("Missing test email");
  return value;
}
function linkToken(url: string): string {
  const value = new URLSearchParams(new URL(url).hash.slice(1)).get("token");
  if (!value) throw new Error("Missing test token");
  return value;
}
beforeAll(async () => {
  f = await testDatabase();
}, 30000);
afterAll(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.db.sql`DELETE FROM linux_waitlist`;
  await f.db.sql`DELETE FROM abuse_bucket`;
  sent.length = 0;
  failMail = false;
  blockMail = false;
  mailResolves = [];
  app = build();
});

test("join confirms an independent, normalized Linux opt-in without accounts or credits", async () => {
  const r = await post("", { email: " Person@Example.com " });
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ accepted: true });
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(sent[0]?.email).toBe("person@example.com");
  const delivered = message(0);
  expect(new URL(delivered.confirmationUrl).origin).toBe(origin);
  expect(new URL(delivered.confirmationUrl).search).toBe("");
  expect(delivered.confirmationUrl).not.toContain("person");
  const token = linkToken(delivered.confirmationUrl);
  const [pending] = await f.db.sql`SELECT confirmed_at,confirmation_hash FROM linux_waitlist`;
  expect(pending?.confirmed_at).toBeNull();
  expect(pending?.confirmation_hash).not.toBe(token);
  expect((await post("/confirm", { token })).status).toBe(200);
  expect((await post("/confirm", { token })).status).toBe(200);
  const [counts] = await f.db
    .sql`SELECT (SELECT count(*)::int FROM auth_user) AS accounts,(SELECT count(*)::int FROM credit_grant) AS grants,(SELECT count(*)::int FROM linux_waitlist WHERE confirmed_at IS NOT NULL) AS confirmed`;
  expect(counts).toEqual({ accounts: 0, grants: 0, confirmed: 1 });
});

test("GET/scanners cannot confirm; expired and invalid proof cannot subscribe", async () => {
  await post("", { email: "person@example.com" });
  const token = linkToken(message(0).confirmationUrl);
  expect(
    (await app.request(`http://localhost:3000/v1/waitlists/linux/confirm?token=${token}`)).status,
  ).toBe(404);
  expect((await post("/confirm", { token: "x".repeat(43) })).status).toBe(400);
  await f.db.sql`UPDATE linux_waitlist SET expires_at=now()-interval '1 second'`;
  expect((await post("/confirm", { token })).status).toBe(400);
  const [r] = await f.db
    .sql`SELECT count(*)::int AS n FROM linux_waitlist WHERE confirmed_at IS NOT NULL`;
  expect(r?.n).toBe(0);
});

test("concurrent duplicate sends are bounded and confirmed entries do not reveal status", async () => {
  const rs = await Promise.all([
    post("", { email: "person@example.com" }),
    post("", { email: "person@example.com" }),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual([202, 429]);
  expect(sent).toHaveLength(1);
  const throttled = rs.find((r) => r.status === 429);
  if (!throttled) throw new Error("Missing throttled response");
  expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
  await post("/confirm", { token: linkToken(message(0).confirmationUrl) });
  await f.db.sql`DELETE FROM abuse_bucket`;
  expect((await post("", { email: "PERSON@example.com" })).status).toBe(202);
  expect(sent).toHaveLength(2);
  const [r] = await f.db.sql`SELECT count(*)::int AS n FROM linux_waitlist`;
  expect(r?.n).toBe(1);
});

test("unsubscribe is signed, idempotent, and old links cannot remove a later signup", async () => {
  await post("", { email: "person@example.com" });
  const delivered = message(0);
  await post("/confirm", { token: linkToken(delivered.confirmationUrl) });
  const token = linkToken(delivered.unsubscribeUrl);
  expect(
    (await post("/unsubscribe", { token: token.slice(0, -1) + (token.endsWith("0") ? "1" : "0") }))
      .status,
  ).toBe(400);
  expect((await post("/unsubscribe", { token })).status).toBe(200);
  expect((await post("/unsubscribe", { token })).status).toBe(200);
  await f.db.sql`DELETE FROM abuse_bucket`;
  await post("", { email: "person@example.com" });
  expect((await post("/unsubscribe", { token })).status).toBe(200);
  const [r] = await f.db.sql`SELECT count(*)::int AS n FROM linux_waitlist`;
  expect(r?.n).toBe(1);
});

test("bad origins, credentials, oversized bodies and malformed fields fail before sending", async () => {
  expect(
    (await post("", { email: "person@example.com" }, { origin: "https://evil.example" })).status,
  ).toBe(403);
  expect(
    (await post("", { email: "person@example.com" }, { authorization: "Bearer fake" })).status,
  ).toBe(400);
  expect(
    (await post("", { email: "person@example.com" }, { cookie: "customer=fake" })).status,
  ).toBe(400);
  expect((await post("", { email: "not-email" })).status).toBe(400);
  expect(
    (await post("", { email: "person@example.com", redirect: "https://evil.example" })).status,
  ).toBe(400);
  expect((await post("", { email: "x".repeat(3000) })).status).toBe(413);
  expect(sent).toHaveLength(0);
  const cors = await app.request("http://localhost:3000/v1/waitlists/linux", {
    method: "OPTIONS",
    headers: { origin },
  });
  expect(cors.status).toBe(204);
  expect(cors.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  expect(cors.headers.get("Access-Control-Allow-Credentials")).toBeNull();
});

test("disabled and restricted staging deployments cannot send to unintended addresses", async () => {
  app = build({ WAITLIST_ENABLED: "false" });
  expect((await post("", { email: "person@example.com" })).status).toBe(404);
  app = build({ SIGNUP_EMAIL_ALLOWLIST: "owner@example.com" });
  expect((await post("", { email: "person@example.com" })).status).toBe(202);
  expect(sent).toHaveLength(0);
});

test("global daily send budget applies across service instances and stores no raw identifiers", async () => {
  app = build({ WAITLIST_EMAILS_PER_DAY: "1" });
  expect((await post("", { email: "one@example.com" })).status).toBe(202);
  app = build({ WAITLIST_EMAILS_PER_DAY: "1" });
  const r = await post("", { email: "two@example.com" });
  expect(r.status).toBe(429);
  expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
  const rows = await f.db.sql`SELECT key FROM abuse_bucket`;
  for (const row of rows) expect(row.key).toMatch(/^[a-f0-9]{64}$/);
});

test("failed email is sanitized, consumes limits and never loses an existing confirmed membership", async () => {
  failMail = true;
  const r = await post("", { email: "person@example.com" });
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain("provider details");
  const [empty] = await f.db.sql`SELECT count(*)::int AS n FROM linux_waitlist`;
  expect(empty?.n).toBe(0);
  failMail = false;
  app = build();
  await f.db.sql`DELETE FROM abuse_bucket`;
  await post("", { email: "person@example.com" });
  await post("/confirm", { token: linkToken(message(0).confirmationUrl) });
  await f.db.sql`DELETE FROM abuse_bucket`;
  failMail = true;
  expect((await post("", { email: "person@example.com" })).status).toBe(503);
  const [confirmed] = await f.db
    .sql`SELECT count(*)::int AS n FROM linux_waitlist WHERE confirmed_at IS NOT NULL`;
  expect(confirmed?.n).toBe(1);
});

test("cleanup removes old unconfirmed requests while retaining confirmed consent", async () => {
  await post("", { email: "pending@example.com" });
  await post("", { email: "confirmed@example.com" });
  await post("/confirm", { token: linkToken(message(1).confirmationUrl) });
  await f.db.sql`UPDATE linux_waitlist SET expires_at=now()-interval '7 days'`;
  await cleanupWaitlist(f.db);
  const rows = await f.db.sql`SELECT email FROM linux_waitlist`;
  expect(Array.from(rows)).toEqual([{ email: "confirmed@example.com" }]);
});

test("slow email delivery cannot accumulate an unbounded request queue", async () => {
  blockMail = true;
  const requests = [
    post("", { email: "first@example.com" }),
    post("", { email: "second@example.com" }),
  ];
  try {
    for (let i = 0; i < 100 && sent.length < 2; i++) await Bun.sleep(5);
    expect(sent).toHaveLength(2);
    const excess = await post("", { email: "third@example.com" });
    expect(excess.status).toBe(503);
    expect(excess.headers.get("Retry-After")).toBe("1");
  } finally {
    blockMail = false;
    for (const resolve of mailResolves) resolve();
  }
  expect((await Promise.all(requests)).map((r) => r.status)).toEqual([202, 202]);
  expect((await post("", { email: "third@example.com" })).status).toBe(202);
});

test("slow chunked request bodies are cancelled at the waitlist deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"email":"'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const r = await app.fetch(
    new Request("http://localhost:3000/v1/waitlists/linux", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
    }),
  );
  expect(r.status).toBe(408);
  expect(cancelled).toBe(true);
  expect(sent).toHaveLength(0);
}, 10000);
