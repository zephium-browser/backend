import { parseCookies } from "better-auth/cookies";
import type postgres from "postgres";
import { privateKey } from "../../platform/abuse";
import { AppError } from "../../platform/errors";
import { emailNetwork } from "../../platform/ip-bucket";

async function consume(sql: postgres.Sql, key: string, seconds: number, maximum: number) {
  const [r] = await sql`INSERT INTO admin_auth_throttle(key,count,expires_at)
    VALUES (${key},1,clock_timestamp()+${seconds}*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN admin_auth_throttle.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(admin_auth_throttle.count+1,${maximum + 1}) END,
    expires_at=CASE WHEN admin_auth_throttle.expires_at<=clock_timestamp() THEN clock_timestamp()+${seconds}*interval '1 second' ELSE admin_auth_throttle.expires_at END
    RETURNING count,greatest(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::integer AS retry`;
  if (!r || r.count > maximum) throw new AppError("rate_limited", 429, r?.retry ?? 60);
}
/** Canonicalize exactly as Better Auth does; both credentials get independent buckets. */
export function adminFactorCredentials(cookie: string, secure: boolean): string[] {
  const prefix = `${secure ? "__Secure-" : ""}zephium-admin.`;
  const names = [`${prefix}session_token`, `${prefix}two_factor`];
  const seen = new Set<string>();
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!names.includes(name)) continue;
    if (seen.has(name)) throw new AppError("invalid_request");
    seen.add(name);
  }
  // Percent encoding and optional quotes do not change a signed credential.
  const parsed = parseCookies(cookie);
  // The underlying HTTP cookie reader tolerates malformed opening quotes more
  // broadly than this public parser. Reject dropped auth fields, never skip their budget.
  if ([...seen].some((name) => !parsed.has(name))) throw new AppError("invalid_request");
  return names.flatMap((name) => {
    const value = parsed.get(name);
    return value ? [`${name}:${value}`] : [];
  });
}

export async function limitAdminAuth(
  sql: postgres.Sql,
  secret: string,
  ip: string,
  path: string,
  body: unknown,
  cookie: string,
  secure = true,
) {
  if (path === "/auth/sign-out") {
    // Revocation is independent of login/MFA abuse budgets. A separate aggregate
    // bucket still bounds address cardinality and work on the public logout route.
    await consume(sql, privateKey(secret, "admin-logout-global", "all"), 60, 60);
    await consume(sql, privateKey(secret, "admin-logout-network", emailNetwork(ip)), 60, 20);
    return;
  }
  // Aggregate limiter bounds cardinality of the subsequent address buckets.
  await consume(sql, privateKey(secret, "admin-auth-global", "all"), 60, 60);
  await consume(sql, privateKey(secret, "admin-auth-network", emailNetwork(ip)), 300, 20);
  if (path === "/auth/sign-in/email") {
    const email =
      body && typeof body === "object" && "email" in body && typeof body.email === "string"
        ? body.email.trim().toLowerCase().slice(0, 254)
        : "invalid";
    await consume(sql, privateKey(secret, "admin-login", email), 900, 10);
  } else if (path.startsWith("/auth/two-factor/")) {
    // An invalid session cookie must not mask a valid challenge, or vice versa.
    // The socket network limit also covers requests without either credential.
    for (const credential of adminFactorCredentials(cookie, secure)) {
      await consume(sql, privateKey(secret, "admin-factor", credential), 300, 5);
    }
  }
}
export async function limitAdminReads(
  sql: postgres.Sql,
  secret: string,
  operator: string,
  bulk = false,
) {
  await consume(
    sql,
    privateKey(secret, bulk ? "admin-export" : "admin-report", operator),
    60,
    bulk ? 120 : 90,
  );
}
export async function cleanAdminAuth(sql: postgres.Sql) {
  await sql`DELETE FROM admin_audit_event WHERE id IN (SELECT id FROM admin_audit_event WHERE created_at<clock_timestamp()-interval '400 days' LIMIT 1000)`;
  // Bound each deletion; this maintenance uses the separate auth role only.
  await sql`DELETE FROM admin_auth_throttle WHERE key IN (SELECT key FROM admin_auth_throttle WHERE expires_at<clock_timestamp() LIMIT 1000)`;
  await sql`DELETE FROM admin_auth_verification WHERE id IN (SELECT id FROM admin_auth_verification WHERE expires_at<clock_timestamp() LIMIT 1000)`;
  await sql`DELETE FROM admin_auth_session WHERE id IN (SELECT id FROM admin_auth_session WHERE expires_at<clock_timestamp() LIMIT 1000)`;
}
