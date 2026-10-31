import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { enforce, privateKey, retryAfterSeconds } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError, errorFields, errorResponse, operationalEvent } from "../../platform/errors";
import { canonicalIp } from "../../platform/ip-bucket";
import type { Auth } from "./auth";
import { eligibilitySecret, normalizeEmail, resolveEligibilityKey } from "./eligibility";
import { admitEmailSend, limitSignInSend } from "./email-limits";
import { signupEmailAllowed } from "./policy";

const email = z.string().transform(normalizeEmail);
const sendBody = z.object({ email, type: z.literal("sign-in") }).strict();
const signInBody = z
  .object({ email, otp: z.string().regex(/^\d{6}$/), device: z.string().optional() })
  .strict();
const accepted = { accepted: true } as const;
type AuthPath = "/sign-in/email-otp";
type ExistingUser = { id: string; lifecycle: string } | undefined;

function deviceLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || Array.from(value).length > 64 || /\p{C}/u.test(value))
    throw new AppError("invalid_request", 400);
  return value;
}
function disposableDomains(config: Config): Set<string> {
  if (config.BLOCK_DISPOSABLE_EMAIL !== "true") return new Set();
  try {
    const domains = new Set(
      readFileSync(config.DISPOSABLE_EMAIL_DOMAINS_FILE, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line !== "" && !line.startsWith("#")),
    );
    if (config.NODE_ENV === "production" && domains.size === 0)
      throw new Error("Disposable email domain data unavailable");
    return domains;
  } catch {
    if (config.NODE_ENV === "production")
      throw new Error("Disposable email domain data unavailable");
    return new Set();
  }
}

/** Mount at /api/auth; the caller must supply a trusted socket-derived IP in production. */
export function createIdentityRoutes(
  config: Config,
  db: Database,
  auth: Auth,
  clientIp?: (request: Request) => string,
) {
  if (config.NODE_ENV === "production" && !clientIp)
    throw new Error("Trusted client IP resolver required for identity routes");
  const blockedDomains = disposableDomains(config);
  const eligibilitySecretValue = eligibilitySecret(config);
  const app = new Hono();
  // Leave a quarter of the pool for authenticated traffic during a sign-in burst.
  const capacity = Math.max(3, Math.ceil(config.DB_POOL_SIZE * 0.75));
  let active = 0;
  app.use("*", async (_c, next) => {
    if (active >= capacity) return errorResponse(new AppError("rate_limited", 429, 1));
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });

  async function parse<T extends z.ZodType>(
    c: { req: { header(name: string): string | undefined; json(): Promise<unknown> } },
    schema: T,
  ): Promise<z.output<T>> {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
      throw new AppError("invalid_request", 400);
    return schema.parse(await c.req.json());
  }
  function emailKey(value: string) {
    return privateKey(config.ABUSE_SECRET, "email", value);
  }
  async function limitSend(value: string) {
    const key = emailKey(value);
    await enforce(db, privateKey(config.ABUSE_SECRET, "otp-send", key), 900, 3);
    await enforce(db, privateKey(config.ABUSE_SECRET, "otp-cooldown", key), 60, 1);
  }
  async function limitAttempt(value: string) {
    await enforce(db, privateKey(config.ABUSE_SECRET, "otp-verify", emailKey(value)), 300, 5);
    // The five-minute window alone allows ~1,440 guesses a day against one mailbox.
    await enforce(
      db,
      privateKey(config.ABUSE_SECRET, "otp-verify-day", emailKey(value)),
      86400,
      30,
    );
  }
  async function withEmailLock<T>(
    value: string,
    action: (tx: TransactionSql, user: ExistingUser) => Promise<T>,
  ): Promise<T> {
    const key = emailKey(value);
    return (await db.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const [user] = await tx<
        ExistingUser[]
      >`SELECT id,lifecycle FROM auth_user WHERE email=${value}`;
      return action(tx, user);
    })) as T;
  }
  async function invoke(
    path: AuthPath,
    body: object,
    sourceHeaders: Headers,
    handler: Auth["handler"],
  ): Promise<Response> {
    const headers = new Headers(sourceHeaders);
    for (const name of [
      "content-length",
      "cookie",
      "authorization",
      "user-agent",
      "x-zephium-device",
    ])
      headers.delete(name);
    headers.set("content-type", "application/json");
    return handler(
      new Request(`${config.API_ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }
  function libraryError(response: Response) {
    const retry = retryAfterSeconds(
      response.headers.get("Retry-After") ?? response.headers.get("X-Retry-After"),
    );
    if (response.status >= 500) throw new AppError("unavailable", 503, retry);
    if (response.status === 429) throw new AppError("rate_limited", 429, retry ?? 1);
  }
  function newAccountAllowed(address: string): boolean {
    if (config.SIGNUP_OPEN !== "true") return false;
    if (config.BLOCK_DISPOSABLE_EMAIL !== "true") return true;
    let domain = address.split("@")[1] ?? "";
    while (domain.includes(".")) {
      if (blockedDomains.has(domain)) return false;
      domain = domain.slice(domain.indexOf(".") + 1);
    }
    return true;
  }
  async function admitNewAccount(tx: TransactionSql, request: Request) {
    const ip = canonicalIp(clientIp?.(request) ?? "127.0.0.1");
    const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
    const now = new Date(clock?.db_now);
    const day = now.toISOString().slice(0, 10);
    const end = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000);
    const key = privateKey(config.ABUSE_SECRET, "signup-ip-day", `${ip}\0${day}`);
    const [result] = await tx<{ count: number; retry_after: number }[]>`
      INSERT INTO abuse_bucket(key,count,expires_at) VALUES (${key},1,${end.toISOString()})
      ON CONFLICT(key) DO UPDATE SET count=LEAST(abuse_bucket.count+1,${config.SIGNUP_PER_IP_PER_DAY + 1}),expires_at=excluded.expires_at
      RETURNING count,greatest(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::integer AS retry_after`;
    if (!result || result.count > config.SIGNUP_PER_IP_PER_DAY)
      throw new AppError("rate_limited", 429, result?.retry_after ?? 1);
    return key;
  }

  app.post("/email-otp/send-verification-otp", async (c) => {
    const body = await parse(c, sendBody);
    await limitSignInSend(config, db, clientIp?.(c.req.raw) ?? "127.0.0.1");
    await limitSend(body.email);
    await admitEmailSend(config, db);
    return withEmailLock(body.email, async (_tx, user) => {
      if (
        !signupEmailAllowed(config, body.email) ||
        user?.lifecycle === "deleting" ||
        (!user && !newAccountAllowed(body.email))
      )
        return c.json(accepted, 202);
      await auth.sendSignInOTP(body.email);
      return c.json(accepted, 202);
    });
  });

  app.post("/sign-in/email-otp", async (c) => {
    const body = await parse(c, signInBody);
    const bodyDevice = deviceLabel(body.device);
    const headerDevice = deviceLabel(c.req.header("x-zephium-device"));
    if (bodyDevice && headerDevice && bodyDevice !== headerDevice)
      throw new AppError("invalid_request", 400);
    const device = bodyDevice ?? headerDevice;
    await limitAttempt(body.email);
    return await withEmailLock(body.email, async (tx, user) => {
      if (
        !signupEmailAllowed(config, body.email) ||
        user?.lifecycle === "deleting" ||
        (!user && !newAccountAllowed(body.email))
      )
        return errorResponse(new AppError("invalid_code", 401));
      const admissionKey = !user ? await admitNewAccount(tx, c.req.raw) : null;
      const response = await auth.withTransaction(tx, (transactionAuth) =>
        invoke(
          "/sign-in/email-otp",
          {
            email: body.email,
            otp: body.otp,
            name: "",
          },
          c.req.raw.headers,
          transactionAuth.handler,
        ),
      );
      libraryError(response);
      if (!response.ok) {
        // Commit the library's bounded bad-code attempt while undoing only
        // provisional signup admission. The IP bucket is locked by this tx.
        if (admissionKey) {
          await tx`DELETE FROM abuse_bucket WHERE key=${admissionKey} AND count=1`;
          await tx`UPDATE abuse_bucket SET count=count-1 WHERE key=${admissionKey}`;
        }
        return errorResponse(new AppError("invalid_code", 401));
      }
      const result = (await response.clone().json()) as {
        token?: unknown;
        user?: { id?: unknown };
      };
      if (typeof result.token !== "string" || typeof result.user?.id !== "string")
        throw new AppError("unavailable", 503);
      // Account locks precede the shared mailbox-eligibility fence.
      await tx`SELECT id FROM auth_user WHERE id=${result.user.id} FOR UPDATE`;
      const key = await resolveEligibilityKey(tx, eligibilitySecretValue, body.email);
      await tx`UPDATE auth_user SET eligibility_key=coalesce(eligibility_key,${key})
          WHERE id=${result.user.id} AND email=${body.email}`;
      if (device) {
        await tx`UPDATE auth_session SET device=${device}
            WHERE token=${result.token} AND user_id=${result.user.id}`;
      }
      return response;
    });
  });

  app.onError((error, c) => {
    const appError =
      error instanceof AppError
        ? error
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? new AppError("invalid_request", 400)
          : new AppError("unavailable", 503);
    if (appError.status >= 500)
      operationalEvent("identity_request_failed", {
        route: c.req.routePath,
        code: appError.code,
        ...(error instanceof AppError ? {} : errorFields(error)),
      });
    return errorResponse(appError);
  });
  return app;
}
