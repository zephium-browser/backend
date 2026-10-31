import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  ADMIN_ORIGIN: z.url(),
  ADMIN_AUTH_SECRET: z.string().min(48),
  ADMIN_AUTH_DATABASE_URL: z.string().startsWith("postgres"),
  ADMIN_READ_DATABASE_URL: z.string().startsWith("postgres"),
  ADMIN_ACCESS_MODE: z.enum(["off", "cloudflare"]).default("off"),
  ADMIN_ACCESS_ISSUER: z.string().default(""),
  ADMIN_ACCESS_AUDIENCE: z.string().default(""),
  ADMIN_ACCESS_EMAILS: z.string().default(""),
  ADMIN_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  ADMIN_TRUSTED_PROXY_CIDRS: z.string().default(""),
  ADMIN_TRUSTED_CLOUDFLARE_CIDRS: z.string().default(""),
});
export type AdminConfig = z.infer<typeof schema>;
export function readAdminConfig(
  env: Record<string, string | undefined> = process.env,
): AdminConfig {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid admin configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = result.data;
  const url = new URL(c.ADMIN_ORIGIN);
  if (
    url.origin !== c.ADMIN_ORIGIN ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        c.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Admin requires an exact HTTPS origin (loopback HTTP allowed only outside production)",
    );
  // An internet-reachable console must opt out of the Access perimeter deliberately.
  if (c.NODE_ENV === "production" && !env.ADMIN_ACCESS_MODE)
    throw new Error("Production admin requires ADMIN_ACCESS_MODE=cloudflare (or an explicit off)");
  if (c.NODE_ENV === "production" && c.ADMIN_AUTH_DATABASE_URL === c.ADMIN_READ_DATABASE_URL)
    throw new Error("Admin requires separate authentication and read-only database roles");
  if (c.ADMIN_ACCESS_MODE === "cloudflare") {
    if (
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(
        c.ADMIN_ACCESS_ISSUER,
      ) ||
      !/^[a-f0-9]{64}$/.test(c.ADMIN_ACCESS_AUDIENCE)
    )
      throw new Error(
        "Admin Access requires the exact Cloudflare team issuer and application audience",
      );
    const emails = c.ADMIN_ACCESS_EMAILS.split(",").map((email) => email.trim().toLowerCase());
    if (emails.length > 20 || emails.some((email) => !z.email().max(254).safeParse(email).success))
      throw new Error("Admin Access requires an explicit operator email allowlist");
    c.ADMIN_ACCESS_EMAILS = [...new Set(emails)].join(",");
  } else if (c.ADMIN_ACCESS_ISSUER || c.ADMIN_ACCESS_AUDIENCE || c.ADMIN_ACCESS_EMAILS) {
    throw new Error("Admin Access settings require cloudflare mode");
  }
  return c;
}
