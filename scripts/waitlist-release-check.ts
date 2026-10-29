import { waitlistUnsubscribeUrl } from "../src/modules/waitlist";
import { readConfig } from "../src/platform/config";
import { createDatabase } from "../src/platform/db";

// Explicit, one-off operator check. Never run on ordinary startup or scheduled jobs.
// It creates and removes only the named test membership; no email/account/payment.
const [target, email] = process.argv.slice(2);
const config = readConfig();
if (
  !target ||
  !email ||
  target !== config.API_ORIGIN ||
  !["https://api.zephium.app", "https://staging-api.zephium.app"].includes(target) ||
  !["info@zephium.app", "founder@zephium.app", "3nnigma.dev@gmail.com"].includes(email) ||
  config.WAITLIST_ENABLED !== "true"
)
  throw new Error("Explicit approved origin, test email and enabled waitlist required");
const db = createDatabase(config);
let cleanupToken: string | undefined;
let signupAttempted = false;
async function call(
  label: string,
  method: string,
  suffix: string,
  body: unknown,
  expected: number,
) {
  const headers: Record<string, string> = {
    Origin: config.WAITLIST_WEB_ORIGIN,
    "User-Agent": "Zephium-Waitlist-Qualification/1.0",
  };
  if (method === "OPTIONS") {
    headers["Access-Control-Request-Method"] = "POST";
    headers["Access-Control-Request-Headers"] = "content-type";
  } else headers["Content-Type"] = "application/json";
  const r = await fetch(`${target}/v1/waitlists/linux${suffix}`, {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  // Request bodies and unsubscribe tokens are deliberately never printed.
  console.log(`\n${label}\nHTTP ${r.status}`);
  for (const [name, value] of r.headers)
    console.log(`${name}: ${name === "set-cookie" ? "[redacted]" : value}`);
  console.log(`\n${text.slice(0, 4096)}`);
  if (
    r.status !== expected ||
    r.headers.get("Access-Control-Allow-Origin") !== config.WAITLIST_WEB_ORIGIN ||
    r.headers.has("Access-Control-Allow-Credentials") ||
    !r.headers.get("Access-Control-Expose-Headers")?.toLowerCase().includes("retry-after")
  )
    throw new Error(`Qualification failed: ${label}`);
  if (expected === 429 && !(Number(r.headers.get("Retry-After")) > 0))
    throw new Error("Missing retry delay");
}
try {
  const existing = await db.sql`SELECT id FROM linux_waitlist WHERE email=${email}`;
  if (existing.length) throw new Error("Test address already subscribed; refusing to modify it");
  await call("preflight", "OPTIONS", "", undefined, 204);
  await call("invalid email", "POST", "", { email: "invalid" }, 400);
  signupAttempted = true;
  await call("single-step signup", "POST", "", { email, website: "" }, 202);
  const [row] =
    await db.sql`SELECT id,subscribed_at,confirmed_at,confirmation_hash FROM linux_waitlist WHERE email=${email}`;
  if (!row?.id) throw new Error("Test membership missing");
  cleanupToken =
    new URLSearchParams(new URL(waitlistUnsubscribeUrl(config, row.id)).hash.slice(1)).get(
      "token",
    ) ?? undefined;
  if (!cleanupToken || !row.subscribed_at || row.confirmed_at || row.confirmation_hash)
    throw new Error("Unexpected membership state");
  await call("duplicate cooldown", "POST", "", { email, website: "" }, 429);
  await call("unknown token", "POST", "/unsubscribe", { token: "unknown" }, 400);
  await call("unsubscribe", "POST", "/unsubscribe", { token: cleanupToken }, 200);
  await call("unsubscribe replay", "POST", "/unsubscribe", { token: cleanupToken }, 200);
  if ((await db.sql`SELECT id FROM linux_waitlist WHERE email=${email}`).length)
    throw new Error("Test membership not removed");
  cleanupToken = undefined;
  signupAttempted = false;
  console.log("Waitlist qualification passed; test membership removed.");
} finally {
  if (signupAttempted && !cleanupToken) {
    try {
      const [row] = await db.sql`SELECT id FROM linux_waitlist WHERE email=${email}`;
      if (row?.id)
        cleanupToken =
          new URLSearchParams(new URL(waitlistUnsubscribeUrl(config, row.id)).hash.slice(1)).get(
            "token",
          ) ?? undefined;
    } catch {
      console.error("Test membership lookup requires operator attention");
    }
  }
  if (cleanupToken) {
    try {
      await call("cleanup", "POST", "/unsubscribe", { token: cleanupToken }, 200);
    } catch {
      console.error("Test membership cleanup requires operator attention");
    }
  }
  await db.close();
}
