import { afterAll, beforeAll, expect, test } from "bun:test";
import { symmetricDecrypt } from "better-auth/crypto";
import { createAdminApp } from "../../src/apps/admin/app";
import { readAdminConfig } from "../../src/apps/admin/config";
import {
  assertAdminDatabasePrivileges,
  createAdminDatabase,
  createReportDatabase,
} from "../../src/modules/admin/database";
import { provisionAdminOperator } from "../../src/modules/admin/operators";
import { adminFactorCredentials, limitAdminAuth } from "../../src/modules/admin/security";
import { testDatabase } from "../support/admin-database";

let f: Awaited<ReturnType<typeof testDatabase>>;
let db: ReturnType<typeof createAdminDatabase>;
let reports: ReturnType<typeof createReportDatabase>;
let app: ReturnType<typeof createAdminApp>;
let config: ReturnType<typeof readAdminConfig>;
const origin = "https://admin.example.test";
const password = "a dedicated synthetic test admin password";
const email = "admin@example.test";
const cookies = new Map<string, string>();
const headers = () => ({ cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") });
async function request(path: string, body?: unknown, extras: RequestInit = {}) {
  const response = await app.fetch(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...headers(),
        origin,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...extras,
    }),
  );
  for (const entry of response.headers.getSetCookie()) {
    const [pair = ""] = entry.split(";");
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return response;
}
beforeAll(async () => {
  f = await testDatabase();
  await f.db.sql.unsafe(await Bun.file("deploy/postgres/admin-roles.sql").text());
  const urls = [];
  for (const role of ["zephium_admin_auth", "zephium_admin_report"]) {
    const pass = crypto.randomUUID().replaceAll("-", "");
    await f.db.sql.unsafe(`ALTER ROLE ${role} PASSWORD '${pass}'`);
    const url = new URL(f.config.DATABASE_URL);
    url.username = role;
    url.password = pass;
    urls.push(url.href);
  }
  config = readAdminConfig({
    NODE_ENV: "test",
    ADMIN_ORIGIN: origin,
    ADMIN_AUTH_SECRET: "independent-admin-secret-".repeat(3),
    ADMIN_AUTH_DATABASE_URL: urls[0],
    ADMIN_READ_DATABASE_URL: urls[1],
  });
  db = createAdminDatabase(config);
  reports = createReportDatabase(config.ADMIN_READ_DATABASE_URL);
  await assertAdminDatabasePrivileges(db.sql, reports);
  app = createAdminApp(
    config,
    db,
    reports,
    { html: "<!doctype html><title>Admin</title>", client: "export {};", css: "body{}" },
    () => "198.51.100.10",
  );
  await provisionAdminOperator(db, email, "Operator", password);
}, 30000);
afterAll(async () => {
  await Promise.all([db?.close(), reports?.end({ timeout: 5 })]);
  await f?.close();
});

test("real DB roles reject raw customer secrets, writes and cross-boundary access", async () => {
  await expect((async () => await reports`SELECT token FROM auth_session`)()).rejects.toThrow();
  await expect(
    (async () => await reports`SELECT * FROM admin_auth_two_factor`)(),
  ).rejects.toThrow();
  await expect((async () => await db.sql`SELECT * FROM admin_report_users`)()).rejects.toThrow();
  await expect((async () => await db.sql`SELECT * FROM auth_user`)()).rejects.toThrow();
  await expect(
    (async () => await reports`UPDATE admin_report_wallets SET suspended=true`)(),
  ).rejects.toThrow();
  const rows = await reports`SELECT * FROM admin_report_users`;
  expect(rows).toHaveLength(0);
  await expect(assertAdminDatabasePrivileges(f.db.sql, reports)).rejects.toThrow("least-privilege");
});

test("startup rejects inherited column writes on an otherwise permitted reporting view", async () => {
  await f.db.sql`CREATE ROLE report_writer NOLOGIN`;
  await f.db.sql`GRANT UPDATE(suspended) ON admin_report_wallets TO report_writer`;
  await f.db.sql`GRANT report_writer TO zephium_admin_report`;
  try {
    await expect(assertAdminDatabasePrivileges(db.sql, reports)).rejects.toThrow("SELECT-only");
  } finally {
    await f.db.sql`REVOKE report_writer FROM zephium_admin_report`;
  }
  await assertAdminDatabasePrivileges(db.sql, reports);
});

test("public HTTP surface fails closed with strict browser headers and no report access", async () => {
  const html = await request("/");
  expect(html.status).toBe(200);
  expect(html.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(html.headers.get("Cache-Control")).toBe("no-store");
  expect(html.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect((await request("/api/users")).status).toBe(401);
  expect((await request("/api/users", {})).status).toBe(404);
  expect((await request("/auth/sign-up/email", { email, password })).status).toBe(404);
  expect(
    (
      await request(
        "/auth/sign-in/email",
        { email, password },
        { headers: { origin: "https://evil.example", "content-type": "application/json" } },
      )
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/users", undefined, { headers: { "sec-fetch-site": "cross-site" } }))
      .status,
  ).toBe(403);
  expect((await request("/auth/sign-in/email?extra=1", { email, password })).status).toBe(404);
  expect((await request("/auth/sign-in/email", { email, password: "x".repeat(5000) })).status).toBe(
    413,
  );
  expect((await app.fetch(new Request("https://evil.example/"))).status).toBe(403);
});

test("password alone denied; real TOTP unlocks projected reports, audited and revoked on logout", async () => {
  const login = await request("/auth/sign-in/email", { email, password });
  expect(login.status).toBe(200);
  expect(await login.json()).not.toHaveProperty("token");
  expect((await request("/api/users")).status).toBe(403);
  const enrollment = await request("/auth/two-factor/enable", { password });
  expect(enrollment.status).toBe(200);
  const [factor] = await db.sql`SELECT secret FROM admin_auth_two_factor`;
  const secret = await symmetricDecrypt({ key: config.ADMIN_AUTH_SECRET, data: factor?.secret });
  const { code } = await app.auth.api.generateTOTP({ body: { secret } });
  expect((await request("/auth/two-factor/verify-totp", { code })).status).toBe(200);
  const session = await request("/api/session");
  expect(await session.json()).toMatchObject({ operator: { email, mfaVerified: true } });
  const report = await request("/api/overview?days=1");
  expect(report.status).toBe(200);
  expect(await report.json()).toMatchObject({ users: { total: 0 }, credit_units: "10000" });
  expect((await request("/api/users?q=&q=other")).status).toBe(400);
  const [audit] = await db.sql`SELECT action,target_id FROM admin_audit_event`;
  expect(audit).toEqual({ action: "overview", target_id: null });
  const previous = { ...headers(), origin };
  expect((await request("/auth/sign-out", {})).status).toBe(200);
  expect((await request("/api/users", undefined, { headers: previous })).status).toBe(401);
});

test("MFA rate identity ignores unrelated cookies, rejects duplicates and shares durable attempts", async () => {
  const base = "__Secure-zephium-admin.session_token=synthetic-signed-value";
  expect(adminFactorCredentials(`${base}; junk=1`, true)).toEqual(
    adminFactorCredentials(`junk=2; ${base}`, true),
  );
  expect(
    adminFactorCredentials(`${base}; __Secure-zephium-admin.two_factor=changed`, true),
  ).toEqual([
    "__Secure-zephium-admin.session_token:synthetic-signed-value",
    "__Secure-zephium-admin.two_factor:changed",
  ]);
  expect(() => adminFactorCredentials(`${base}; ${base}`, true)).toThrow();
  for (let i = 0; i < 5; i++)
    await limitAdminAuth(
      db.sql,
      config.ADMIN_AUTH_SECRET,
      "203.0.113.20",
      "/auth/two-factor/verify-totp",
      {},
      `${base}; junk=${i}`,
    );
  await expect(
    limitAdminAuth(
      db.sql,
      config.ADMIN_AUTH_SECRET,
      "203.0.113.20",
      "/auth/two-factor/verify-totp",
      {},
      `${base}; junk=extra`,
    ),
  ).rejects.toMatchObject({ status: 429 });
});

test("password hashing admission remains held until the library operation resolves", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = app.auth.handler;
  app.auth.handler = async () => {
    entered();
    await blocked;
    return new Response(JSON.stringify({ success: true }), {
      headers: { "content-type": "application/json" },
    });
  };
  const pending = request("/auth/sign-in/email", { email: "concurrent@example.test", password });
  await started;
  try {
    expect(
      (await request("/auth/sign-in/email", { email: "second@example.test", password })).status,
    ).toBe(503);
  } finally {
    release();
    await pending;
    app.auth.handler = original;
  }
});

test("enabled Access protects login, assets, reports and external health before database authentication", async () => {
  const gatedConfig = readAdminConfig({
    ...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, String(value)])),
    ADMIN_ACCESS_MODE: "cloudflare",
    ADMIN_ACCESS_ISSUER: "https://zephium-test.cloudflareaccess.com",
    ADMIN_ACCESS_AUDIENCE: "a".repeat(64),
    ADMIN_ACCESS_EMAILS: email,
  });
  const build = (peer: string) =>
    createAdminApp(
      gatedConfig,
      db,
      reports,
      { html: "private login", client: "", css: "" },
      () => peer,
    );
  const external = build("10.0.2.2");
  for (const path of [
    "/",
    "/assets/client.js",
    "/api/overview",
    "/auth/get-session",
    "/health/ready",
  ]) {
    const response = await external.fetch(
      new Request(origin + path, {
        headers: {
          ...headers(),
          "x-forwarded-for": "127.0.0.1",
          "cf-connecting-ip": "127.0.0.1",
          "cf-access-authenticated-user-email": email,
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("admin_access_required");
  }
  const local = build("127.0.0.1");
  expect((await local.fetch(new Request(`${origin}/health/ready`))).status).toBe(200);
  expect((await local.fetch(new Request(`${origin}/health/ready?extra=1`))).status).toBe(403);
  expect((await local.fetch(new Request(`${origin}/api/overview`))).status).toBe(403);
});

test("waitlist reporting retains MFA requirements and database-enforced projection", async () => {
  await expect(
    (async () => await reports`SELECT confirmation_hash FROM linux_waitlist`)(),
  ).rejects.toThrow();
  await expect(
    (async () => await reports`DELETE FROM admin_report_linux_waitlist`)(),
  ).rejects.toThrow();
  const r = await app.fetch(new Request(`${origin}/api/waitlists/linux`));
  expect(r.status).toBe(401);
  await f.db.sql`DROP VIEW admin_report_linux_waitlist`;
  const { reportLinuxWaitlist } = await import("../../src/modules/admin/waitlist");
  expect((await reportLinuxWaitlist(reports)).available).toBe(false);
});
