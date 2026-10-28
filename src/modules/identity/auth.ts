import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/postgres-js";
import type { TransactionSql } from "postgres";
import { consume, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { deliverEmail } from "../../platform/email";
import { AppError, operationalEvent } from "../../platform/errors";
import { otpEmailLogo, renderOTPEmail } from "./emails/otp";
import * as schema from "./schema";

export interface Mailer {
  sendOTP(
    email: string,
    otp: string,
    purpose?: "sign-in" | "deletion" | "email-change",
  ): Promise<void>;
}
/** Reject excess work immediately; no plaintext OTP is queued or retried in the background. */
export function boundedMailer(mailer: Mailer, maxInFlight: number): Mailer {
  let active = 0;
  let retryAt = 0;
  return {
    async sendOTP(email, otp, purpose) {
      const now = Date.now();
      if (retryAt > now) throw new AppError("email_unavailable", 503, (retryAt - now) / 1000);
      if (active >= maxInFlight) throw new AppError("email_unavailable", 503, 1);
      active++;
      try {
        await mailer.sendOTP(email, otp, purpose);
      } catch (error) {
        const retry = error instanceof AppError ? (error.retryAfter ?? 1) : 1;
        retryAt = Math.max(retryAt, Date.now() + retry * 1000);
        throw new AppError("email_unavailable", 503, retry);
      } finally {
        active--;
      }
    },
  };
}
export function resendMailer(
  config: Config,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Mailer {
  return boundedMailer(
    {
      async sendOTP(email, otp, purpose) {
        await deliverEmail(
          config,
          {
            to: email,
            ...renderOTPEmail(otp, purpose),
            attachments: [otpEmailLogo],
          },
          transport,
        );
      },
    },
    config.EMAIL_MAX_IN_FLIGHT,
  );
}
function createAuthInstance(
  config: Config,
  db: { sql: Database["sql"]; orm: Parameters<typeof drizzleAdapter>[0] },
  mailer: Mailer,
) {
  return betterAuth({
    appName: "Zephium",
    baseURL: config.API_ORIGIN,
    basePath: "/api/auth",
    secret: config.AUTH_SECRET,
    trustedOrigins: config.TRUSTED_ORIGINS.split(","),
    database: drizzleAdapter(db.orm, { provider: "pg", schema }),
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
    advanced: {
      database: { generateId: () => randomUUID() },
      ipAddress: { disableIpTracking: true },
      useSecureCookies: config.NODE_ENV === "production",
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 600,
      cookieCache: { enabled: false },
    },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    rateLimit: {
      enabled: true,
      customStorage: {
        consume: (key, rule) =>
          consume(db, privateKey(config.ABUSE_SECRET, "auth", key), rule.window, rule.max),
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (s) => {
            const [u] =
              await db.sql`SELECT lifecycle,email_verified FROM auth_user WHERE id=${s.userId}`;
            if (u?.lifecycle !== "active" || !u.email_verified) return false;
            return { data: { ...s, ipAddress: null, userAgent: null } };
          },
        },
      },
    },
    plugins: [
      bearer({ requireSignature: true }),
      emailOTP({
        otpLength: 6,
        disableSignUp: false,
        expiresIn: 300,
        allowedAttempts: 5,
        storeOTP: {
          hash: async (otp) => privateKey(config.AUTH_SECRET, "sign-in-otp-storage:v1", otp),
        },
        resendStrategy: "rotate",
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") throw new AppError("unsupported_auth_operation");
          await mailer.sendOTP(email, otp, type);
        },
      }),
    ],
  });
}
export function createAuth(config: Config, db: Database, mailer: Mailer) {
  const auth = createAuthInstance(config, db, mailer);
  return Object.assign(auth, {
    async withTransaction<T>(
      tx: TransactionSql,
      operation: (auth: ReturnType<typeof createAuthInstance>) => Promise<T>,
    ): Promise<T> {
      // Postgres exposes query methods on its transaction client. Drizzle also
      // requires serializer options; clone those so its initialization cannot
      // change the shared connection-pool configuration. Better Auth receives
      // this transaction-bound Drizzle adapter through its public database API.
      const client = Object.assign(tx, {
        options: {
          ...db.sql.options,
          parsers: { ...db.sql.options.parsers },
          serializers: { ...db.sql.options.serializers },
        },
      });
      const scoped = {
        ...db,
        sql: tx as unknown as Database["sql"],
        orm: drizzle(client as unknown as Database["sql"], { schema }),
      };
      return operation(createAuthInstance(config, scoped, mailer));
    },
    // Better Auth's email send callback swallows failures. Its supported server-only
    // creation API lets our public boundary await delivery and report backpressure.
    async sendSignInOTP(email: string): Promise<void> {
      // The public route holds the per-email advisory lock across rotation and delivery.
      await db.sql`DELETE FROM auth_verification WHERE identifier=${`sign-in-otp-${email}`}`;
      const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
      try {
        await mailer.sendOTP(email, otp, "sign-in");
      } catch (error) {
        const stored = `${privateKey(config.AUTH_SECRET, "sign-in-otp-storage:v1", otp)}:0`;
        await db.sql`DELETE FROM auth_verification
          WHERE identifier=${`sign-in-otp-${email}`} AND value=${stored}`;
        operationalEvent("otp_delivery_failed");
        if (error instanceof AppError) throw error;
        throw new AppError("email_unavailable", 503, 1);
      }
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
