import { z } from "zod";

const optionalSecret = z.string().min(1).optional();
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEPLOYMENT_MODE: z.enum(["hosted", "self_hosted"]).default("hosted"),
  WAITLIST_ENABLED: z.enum(["true", "false"]).default("false"),
  WAITLIST_WEB_ORIGIN: z.url().default("https://zephium.app"),
  WAITLIST_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(30),
  WAITLIST_REQUESTS_PER_DAY: z.coerce.number().int().min(1).max(100000).default(1000),
  SIGNUP_OPEN: z.enum(["true", "false"]).default("true"),
  // Empty permits all addresses; staging can restrict identity to exact addresses.
  SIGNUP_EMAIL_ALLOWLIST: z
    .string()
    .max(26000)
    .default("")
    .refine((value) =>
      value
        .split(",")
        .filter((entry) => entry.trim() !== "")
        .every((entry) => z.email().max(254).safeParse(entry.trim().toLowerCase()).success),
    ),
  OTP_SENDS_PER_NETWORK_PER_15_MIN: z.coerce.number().int().min(3).max(10000).default(30),
  EMAIL_SENDS_PER_MINUTE: z.coerce.number().int().min(1).max(60000).default(300),
  EMAIL_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(16).default(16),
  SIGNUP_PER_IP_PER_DAY: z.coerce.number().int().min(1).max(10000).default(3),
  ELIGIBILITY_SECRET: z.string().min(32).optional(),
  BLOCK_DISPOSABLE_EMAIL: z.enum(["true", "false"]).default("true"),
  DISPOSABLE_EMAIL_DOMAINS_FILE: z.string().default("config/disposable-email-domains.txt"),
  SOURCE_URL: z.url().startsWith("https://").optional(),
  CLIENT_MIN_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
    .default("1.0.0"),
  CLIENT_NOTICE_ID: z.string().max(100).optional(),
  CLIENT_NOTICE_TEXT: z.string().max(500).optional(),
  CLIENT_NOTICE_SEVERITY: z.enum(["info", "warning"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_ORIGIN: z.url().default("http://localhost:3000"),
  TRUSTED_ORIGINS: z.string().default("http://localhost:3000"),
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  // Empty by default: enable only behind an origin route restricted to Cloudflare.
  TRUSTED_CLOUDFLARE_CIDRS: z.string().default(""),
  DATABASE_URL: z.string().startsWith("postgres"),
  DATABASE_CA_FILE: optionalSecret,
  DB_POOL_SIZE: z.coerce.number().int().min(4).max(30).default(10),
  AUTH_SECRET: z.string().min(32),
  ABUSE_SECRET: z.string().min(32),
  RESEND_API_KEY: optionalSecret,
  OPERATIONS_WEBHOOK: z.url().startsWith("https://").optional(),
  EMAIL_FROM: z.string().default("Zephium <login@auth.zephium.app>"),
  POLAR_ACCESS_TOKEN: optionalSecret,
  POLAR_WEBHOOK_SECRET: optionalSecret,
  POLAR_WEBHOOK_FORMAT: z.enum(["standard", "legacy"]).default("standard"),
  POLAR_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  POLAR_MONTHLY_PRODUCT_ID: z.uuid().optional(),
  POLAR_YEARLY_PRODUCT_ID: z.uuid().optional(),
  BILLING_ENABLED: z.enum(["true", "false"]).default("false"),
  BILLING_SUCCESS_URL: z.url().default("https://zephium.app/billing/return"),
  BILLING_RETURN_URL: z.url().default("https://zephium.app/billing/return"),
  CLOUD_CONFIG_PATH: z.string().default("config/cloud.json"),
  CLOUD_OPENAI_KEY: optionalSecret,
  CLOUD_ANTHROPIC_KEY: optionalSecret,
  CLOUD_GOOGLE_KEY: optionalSecret,
  CLOUD_OPENROUTER_KEY: optionalSecret,
  CLOUD_DEEPSEEK_KEY: optionalSecret,
  CLOUD_TYPESAFE_KEY: optionalSecret,
});
export type Config = z.infer<typeof schema>;
const workerSchema = schema.pick({
  NODE_ENV: true,
  DEPLOYMENT_MODE: true,
  BILLING_ENABLED: true,
  BILLING_SUCCESS_URL: true,
  DATABASE_URL: true,
  DATABASE_CA_FILE: true,
  DB_POOL_SIZE: true,
  POLAR_ACCESS_TOKEN: true,
  POLAR_ENVIRONMENT: true,
  BILLING_RETURN_URL: true,
  POLAR_MONTHLY_PRODUCT_ID: true,
  POLAR_YEARLY_PRODUCT_ID: true,
  CLOUD_CONFIG_PATH: true,
  OPERATIONS_WEBHOOK: true,
});
export function readWorkerConfig(env: Record<string, string | undefined> = process.env) {
  const result = workerSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!result.success)
    throw new Error(
      `Invalid worker configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  return result.data;
}
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = result.data;
  if (c.DEPLOYMENT_MODE === "self_hosted" && env.BLOCK_DISPOSABLE_EMAIL === undefined)
    c.BLOCK_DISPOSABLE_EMAIL = "false";
  if (c.NODE_ENV === "production" && c.DEPLOYMENT_MODE === "hosted" && !c.ELIGIBILITY_SECRET)
    throw new Error("Hosted production requires a stable ELIGIBILITY_SECRET");
  if (c.ELIGIBILITY_SECRET && [c.AUTH_SECRET, c.ABUSE_SECRET].includes(c.ELIGIBILITY_SECRET))
    throw new Error("Eligibility secret must be independent");
  if (!!c.CLIENT_NOTICE_ID !== !!c.CLIENT_NOTICE_TEXT)
    throw new Error("Client notice requires id and text");
  if (c.DEPLOYMENT_MODE === "self_hosted" && c.BILLING_ENABLED === "true")
    throw new Error("Self-hosted deployment does not use Zephium billing");
  if (c.AUTH_SECRET === c.ABUSE_SECRET) throw new Error("Secrets must be independent");
  const waitlistOrigin = new URL(c.WAITLIST_WEB_ORIGIN);
  if (
    waitlistOrigin.origin !== c.WAITLIST_WEB_ORIGIN ||
    waitlistOrigin.username ||
    waitlistOrigin.password ||
    (waitlistOrigin.protocol !== "https:" &&
      !(
        c.NODE_ENV !== "production" &&
        waitlistOrigin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(waitlistOrigin.hostname)
      ))
  )
    throw new Error("Waitlist requires an exact HTTPS website origin");
  const origins = c.TRUSTED_ORIGINS.split(",");
  for (const origin of [c.API_ORIGIN, ...origins]) {
    if (new URL(origin).origin !== origin || origin.includes("*"))
      throw new Error("Origins must be exact");
  }
  if (
    c.NODE_ENV === "production" &&
    (!c.API_ORIGIN.startsWith("https://") ||
      origins.some((o) => !o.startsWith("https://")) ||
      !c.RESEND_API_KEY)
  )
    throw new Error("Production requires HTTPS and email delivery");
  if (c.BILLING_ENABLED === "true" && (!c.POLAR_ACCESS_TOKEN || !c.POLAR_WEBHOOK_SECRET))
    throw new Error("Billing configuration incomplete");
  if (
    c.NODE_ENV !== "test" &&
    [c.BILLING_RETURN_URL, c.BILLING_SUCCESS_URL].some((url) => !url.startsWith("https://"))
  )
    throw new Error("Billing return URL requires HTTPS");
  return c;
}
