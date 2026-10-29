import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { testDatabase } from "../../../tests/support/database";
import { createApp } from "../../apps/api/app";
import { readConfig } from "../../platform/config";
import type { BillingProvider } from "../billing";
import { createAuth, type Mailer } from "../identity";
import { cleanupWaitlist, waitlistUnsubscribeUrl } from "./service";

let f: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
const origin = "https://zephium.example.test";
const provider: BillingProvider = {
  state: async () => null,
  checkout: async () => {
    throw new Error("No billing");
  },
  portal: async () => {
    throw new Error("No billing");
  },
  deleteCustomer: async () => {},
  openCheckoutUntil: async () => null,
};
const mailer: Mailer = {
  sendOTP: async () => {
    throw new Error("No identity email");
  },
};
function config(overrides: Record<string, string> = {}) {
  return readConfig({
    ...Object.fromEntries(Object.entries(f.config).map(([k, v]) => [k, String(v)])),
    WAITLIST_ENABLED: "true",
    WAITLIST_WEB_ORIGIN: origin,
    RESEND_API_KEY: "",
    ...overrides,
  });
}
function build(overrides: Record<string, string> = {}) {
  const c = config(overrides);
  return createApp(
    c,
    f.db,
    createAuth(c, f.db, mailer),
    provider,
    () => "192.0.2.1",
    undefined,
    mailer,
  );
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://localhost:3000/v1/waitlists/linux${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function legacy(email: string, expired = false) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await f.db.sql`INSERT INTO linux_waitlist(id,email,confirmation_hash,expires_at,consent_version)
    VALUES (${randomUUID()},${email},${hash},${new Date(Date.now() + (expired ? -864000000 : 86400000)).toISOString()},'linux-release-v1')`;
  return token;
}
function token(url: string) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("token");
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
  app = build();
});

test("single-step signup records consent without email, account, credits or a verification claim", async () => {
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Waitlist must not use network");
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const r = await post("", { email: " Person@Example.com ", website: "" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: true });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(network).not.toHaveBeenCalled();
    const [row] = await f.db
      .sql`SELECT email,subscribed_at,confirmed_at,confirmation_hash,expires_at,consent_version FROM linux_waitlist`;
    expect(row?.email).toBe("person@example.com");
    expect(row?.subscribed_at).not.toBeNull();
    expect(row?.confirmed_at).toBeNull();
    expect(row?.confirmation_hash).toBeNull();
    expect(row?.expires_at).toBeNull();
    expect(row?.consent_version).toBe("linux-release-single-opt-in-v1");
    const [counts] = await f.db
      .sql`SELECT (SELECT count(*)::int FROM auth_user) accounts,(SELECT count(*)::int FROM credit_grant) grants`;
    expect(counts).toEqual({ accounts: 0, grants: 0 });
  } finally {
    network.mockRestore();
  }
});
test("concurrent duplicates are bounded; repeated signup preserves ID and consent timestamp", async () => {
  const rs = await Promise.all([
    post("", { email: "person@example.com" }),
    post("", { email: "person@example.com" }),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual([202, 429]);
  expect(Number(rs.find((r) => r.status === 429)?.headers.get("Retry-After"))).toBeGreaterThan(0);
  const before = await f.db.sql`SELECT id,subscribed_at FROM linux_waitlist`;
  await f.db.sql`DELETE FROM abuse_bucket`;
  expect((await post("", { email: "PERSON@example.com" })).status).toBe(202);
  expect(Array.from(await f.db.sql`SELECT id,subscribed_at FROM linux_waitlist`)).toEqual(
    Array.from(before),
  );
});
test("honeypot is generic and never creates or modifies membership", async () => {
  expect(
    (await post("", { email: "bot@example.com", website: "https://spam.example" })).status,
  ).toBe(202);
  expect((await f.db.sql`SELECT id FROM linux_waitlist`).length).toBe(0);
  await post("", { email: "real@example.com" });
  const before = await f.db.sql`SELECT * FROM linux_waitlist`;
  expect((await post("", { email: "real@example.com", website: "bot" })).status).toBe(202);
  expect(Array.from(await f.db.sql`SELECT * FROM linux_waitlist`)).toEqual(Array.from(before));
});
test("legacy confirmation links remain valid, but GET/scanners and expired proof cannot enroll", async () => {
  const valid = await legacy("valid@example.com");
  const expired = await legacy("expired@example.com", true);
  expect(
    (await app.request(`http://localhost:3000/v1/waitlists/linux/confirm?token=${valid}`)).status,
  ).toBe(404);
  expect((await post("/confirm", { token: "x".repeat(43) })).status).toBe(400);
  expect((await post("/confirm", { token: expired })).status).toBe(400);
  expect((await post("/confirm", { token: valid })).status).toBe(200);
  expect((await post("/confirm", { token: valid })).status).toBe(200);
  const rows = await f.db
    .sql`SELECT email FROM linux_waitlist WHERE subscribed_at IS NOT NULL AND confirmed_at IS NOT NULL`;
  expect(Array.from(rows)).toEqual([{ email: "valid@example.com" }]);
});
test("a fresh form submission can enroll an old pending address without claiming verification", async () => {
  await legacy("pending@example.com");
  expect((await post("", { email: "pending@example.com" })).status).toBe(202);
  const [row] = await f.db
    .sql`SELECT subscribed_at,confirmed_at,confirmation_hash,consent_version FROM linux_waitlist`;
  expect(row?.subscribed_at).not.toBeNull();
  expect(row?.confirmed_at).toBeNull();
  expect(row?.confirmation_hash).toBeNull();
  expect(row?.consent_version).toBe("linux-release-single-opt-in-v1");
});
test("signed unsubscribe is idempotent and old links cannot delete a later membership", async () => {
  await post("", { email: "person@example.com" });
  const [row] = await f.db.sql`SELECT id FROM linux_waitlist`;
  const url = waitlistUnsubscribeUrl(config(), row?.id);
  expect(new URL(url).search).toBe("");
  expect(url).not.toContain("person");
  const proof = token(url);
  if (!proof) throw new Error("Missing proof");
  expect(
    (await post("/unsubscribe", { token: proof.slice(0, -1) + (proof.endsWith("0") ? "1" : "0") }))
      .status,
  ).toBe(400);
  expect((await post("/unsubscribe", { token: proof })).status).toBe(200);
  expect((await post("/unsubscribe", { token: proof })).status).toBe(200);
  await f.db.sql`DELETE FROM abuse_bucket`;
  await post("", { email: "person@example.com" });
  expect((await post("/unsubscribe", { token: proof })).status).toBe(200);
  expect((await f.db.sql`SELECT id FROM linux_waitlist`).length).toBe(1);
});
test("invalid origins, credentials, payloads and oversize bodies are rejected", async () => {
  expect(
    (await post("", { email: "person@example.com" }, { origin: "https://evil.example" })).status,
  ).toBe(403);
  expect(
    (await post("", { email: "person@example.com" }, { authorization: "Bearer fake" })).status,
  ).toBe(400);
  expect((await post("", { email: "person@example.com" }, { cookie: "fake=1" })).status).toBe(400);
  expect((await post("", { email: "invalid" })).status).toBe(400);
  expect((await post("", { email: "person@example.com", website: {} })).status).toBe(400);
  expect((await post("", { email: "person@example.com", extra: true })).status).toBe(400);
  expect((await post("", { email: "x".repeat(3000) })).status).toBe(413);
  const cors = await app.request("http://localhost:3000/v1/waitlists/linux", {
    method: "OPTIONS",
    headers: { origin },
  });
  expect(cors.status).toBe(204);
  expect(cors.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  expect(cors.headers.get("Access-Control-Allow-Credentials")).toBeNull();
});
test("disabled and allowlisted staging do not accept unintended membership", async () => {
  app = build({ WAITLIST_ENABLED: "false" });
  expect((await post("", { email: "person@example.com" })).status).toBe(404);
  app = build({ SIGNUP_EMAIL_ALLOWLIST: "owner@example.com" });
  expect((await post("", { email: "person@example.com" })).status).toBe(202);
  expect((await f.db.sql`SELECT id FROM linux_waitlist`).length).toBe(0);
});
test("global request budget is shared across instances and separate from OTP delivery budget", async () => {
  app = build({ WAITLIST_REQUESTS_PER_DAY: "1" });
  expect((await post("", { email: "one@example.com" })).status).toBe(202);
  app = build({ WAITLIST_REQUESTS_PER_DAY: "1" });
  const r = await post("", { email: "two@example.com" });
  expect(r.status).toBe(429);
  expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
  const rows = await f.db.sql`SELECT key FROM abuse_bucket`;
  for (const row of rows) expect(row.key).toMatch(/^[a-f0-9]{64}$/);
  const { privateKey } = await import("../../platform/abuse");
  const otpKey = privateKey(config().ABUSE_SECRET, "otp-delivery-minute:v1", "all");
  expect(rows.some((row) => row.key === otpKey)).toBe(false);
});
test("cleanup removes only legacy expired pending requests", async () => {
  await legacy("pending@example.com", true);
  const proof = await legacy("confirmed@example.com");
  await post("/confirm", { token: proof });
  await post("", { email: "single@example.com" });
  await f.db
    .sql`UPDATE linux_waitlist SET expires_at=now()-interval '7 days' WHERE confirmed_at IS NOT NULL`;
  await cleanupWaitlist(f.db);
  const rows = await f.db.sql`SELECT email FROM linux_waitlist ORDER BY email`;
  expect(Array.from(rows)).toEqual([
    { email: "confirmed@example.com" },
    { email: "single@example.com" },
  ]);
});
test("in-flight body reads are bounded and aborted reads release capacity", async () => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests = [0, 1].map(() =>
    app.fetch(
      new Request("http://localhost:3000/v1/waitlists/linux", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            controllers.push(c);
            c.enqueue(new TextEncoder().encode("{"));
          },
        }),
      }),
    ),
  );
  try {
    await Bun.sleep(20);
    const excess = await post("", { email: "third@example.com" });
    expect(excess.status).toBe(503);
    expect(excess.headers.get("Retry-After")).toBe("1");
  } finally {
    for (const c of controllers) c.close();
  }
  expect((await Promise.all(requests)).map((r) => r.status)).toEqual([400, 400]);
  expect((await post("", { email: "third@example.com" })).status).toBe(202);
});
test("slow chunked bodies are cancelled at the deadline", async () => {
  let cancelled = false;
  const r = await app.fetch(
    new Request("http://localhost:3000/v1/waitlists/linux", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  expect(r.status).toBe(408);
  expect(cancelled).toBe(true);
}, 10000);
test("upgrade preserves verified subscriptions and never enrolls legacy pending addresses", async () => {
  await f.db.sql.begin(async (tx) => {
    await tx`CREATE SCHEMA waitlist_upgrade_test`;
    await tx`SET LOCAL search_path=waitlist_upgrade_test`;
    await tx.unsafe(
      await Bun.file(
        new URL("../../../migrations/0012_linux_waitlist.sql", import.meta.url),
      ).text(),
    );
    await tx`INSERT INTO linux_waitlist(id,email,confirmed_at,confirmation_hash,expires_at,consent_version)
      SELECT gen_random_uuid(),n||'@example.com',CASE WHEN n=1 THEN now() ELSE NULL END,md5(n::text)||md5(n::text),now()+interval '1 day','linux-release-v1' FROM generate_series(1,3)n`;
    await tx.unsafe(
      await Bun.file(
        new URL("../../../migrations/0013_linux_waitlist_single_opt_in.sql", import.meta.url),
      ).text(),
    );
    const [row] =
      await tx`SELECT count(*)::int total,count(subscribed_at)::int subscribed,count(confirmed_at)::int confirmed FROM linux_waitlist`;
    expect(row).toEqual({ total: 3, subscribed: 1, confirmed: 1 });
    await tx`DROP SCHEMA waitlist_upgrade_test CASCADE`;
  });
});
