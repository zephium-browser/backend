import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { deliverEmail } from "../../platform/email";
import { AppError } from "../../platform/errors";
import { emailNetwork } from "../../platform/ip-bucket";

export type WaitlistMessage = { email: string; confirmationUrl: string; unsubscribeUrl: string };
export type WaitlistMailer = (message: WaitlistMessage) => Promise<void>;
export function waitlistMailer(config: Config): WaitlistMailer {
  return async ({ email, confirmationUrl, unsubscribeUrl }) =>
    deliverEmail(config, {
      to: email,
      subject: "Confirm your Zephium for Linux notification",
      text: [
        "Zephium for Linux",
        "",
        "Confirm that you want one email when Zephium for Linux is available:",
        confirmationUrl,
        "",
        "This confirmation link expires in 24 hours. It does not create a Zephium account or subscribe you to other announcements.",
        "",
        "If you did not request this, ignore this email. You will not be added without confirmation.",
        "",
        "Remove this request or unsubscribe:",
        unsubscribeUrl,
        "",
        "Zephium",
      ].join("\n"),
    });
}
export function createWaitlistService(config: Config, db: Database, send: WaitlistMailer) {
  let sending = 0;
  let retryAt = 0;
  const unsubscribeSignature = (id: string) =>
    privateKey(config.AUTH_SECRET, "linux-waitlist-unsubscribe:v1", id);
  return {
    async join(input: unknown, ip: string) {
      const { email } = z
        .object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) })
        .strict()
        .parse(input);
      const key = (kind: string, value: string) =>
        privateKey(config.ABUSE_SECRET, `linux-waitlist:${kind}`, value);
      await enforce(db, key("network", emailNetwork(ip)), 900, 5);
      await enforce(db, key("email", email), 900, 3);
      await enforce(db, key("cooldown", email), 60, 1);
      await enforce(db, key("minute", "all"), 60, config.WAITLIST_EMAILS_PER_MINUTE);
      await enforce(db, key("day", "all"), 86400, config.WAITLIST_EMAILS_PER_DAY);
      // Share the existing global transactional-email budget with sign-in and account mail.
      await enforce(
        db,
        privateKey(config.ABUSE_SECRET, "otp-delivery-minute:v1", "all"),
        60,
        config.EMAIL_SENDS_PER_MINUTE,
      );
      const invited = config.SIGNUP_EMAIL_ALLOWLIST.split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      if (invited.length && !invited.includes(email)) return;
      if (retryAt > Date.now())
        throw new AppError("email_unavailable", 503, (retryAt - Date.now()) / 1000);
      if (sending >= 2) throw new AppError("email_unavailable", 503, 1);
      sending++;
      const token = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      try {
        const [row] = await db.sql<
          { id: string }[]
        >`INSERT INTO linux_waitlist(id,email,confirmation_hash,expires_at,consent_version)
          VALUES (${randomUUID()},${email},${hash},now()+interval '24 hours','linux-release-v1')
          ON CONFLICT(email) DO UPDATE SET confirmation_hash=EXCLUDED.confirmation_hash,expires_at=EXCLUDED.expires_at
          RETURNING id`;
        if (!row) throw new AppError("unavailable", 503);
        const url = new URL("/linux/confirm", config.WAITLIST_WEB_ORIGIN);
        url.hash = new URLSearchParams({ token }).toString();
        const unsubscribe = new URL("/linux/confirm", config.WAITLIST_WEB_ORIGIN);
        unsubscribe.hash = new URLSearchParams({
          action: "unsubscribe",
          token: `${row.id}.${unsubscribeSignature(row.id)}`,
        }).toString();
        try {
          // Always send the same confirmation for valid requests, including existing members.
          await send({ email, confirmationUrl: url.href, unsubscribeUrl: unsubscribe.href });
        } catch (error) {
          const retry = error instanceof AppError ? (error.retryAfter ?? 1) : 1;
          retryAt = Math.max(retryAt, Date.now() + Math.min(3600, Math.max(1, retry)) * 1000);
          // Do not discard confirmed opt-in if a redundant confirmation failed to send.
          await db.sql`DELETE FROM linux_waitlist WHERE id=${row.id} AND confirmation_hash=${hash} AND confirmed_at IS NULL`;
          throw new AppError("email_unavailable", 503, retry);
        }
      } finally {
        sending--;
      }
    },
    async confirm(input: unknown, ip: string) {
      const { token } = z
        .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict()
        .parse(input);
      await enforce(
        db,
        privateKey(config.ABUSE_SECRET, "linux-waitlist-confirm", emailNetwork(ip)),
        60,
        30,
      );
      const hash = createHash("sha256").update(token).digest("hex");
      const rows = await db.sql`UPDATE linux_waitlist SET confirmed_at=coalesce(confirmed_at,now())
        WHERE confirmation_hash=${hash} AND expires_at>now() RETURNING id`;
      if (!rows.length) throw new AppError("invalid_or_expired_token", 400);
    },
    async unsubscribe(input: unknown, ip: string) {
      const { token } = z
        .object({ token: z.string().max(101) })
        .strict()
        .parse(input);
      await enforce(
        db,
        privateKey(config.ABUSE_SECRET, "linux-waitlist-unsubscribe", emailNetwork(ip)),
        60,
        30,
      );
      const [id = "", signature = "", extra] = token.split(".");
      if (
        extra ||
        !z.uuid().safeParse(id).success ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(
          Buffer.from(signature, "hex"),
          Buffer.from(unsubscribeSignature(id), "hex"),
        )
      )
        throw new AppError("invalid_or_expired_token", 400);
      await db.sql`DELETE FROM linux_waitlist WHERE id=${id}`;
    },
  };
}
export async function assertWaitlistReady(db: Database): Promise<void> {
  await db.sql`SELECT id,email,created_at,confirmed_at,confirmation_hash,expires_at,consent_version FROM linux_waitlist LIMIT 0`;
}
export async function cleanupWaitlist(db: Database): Promise<void> {
  const [schema] = await db.sql`SELECT to_regclass('public.linux_waitlist') IS NOT NULL AS present`;
  if (!schema?.present) return;
  await db.sql`DELETE FROM linux_waitlist WHERE id IN (
    SELECT id FROM linux_waitlist WHERE confirmed_at IS NULL AND expires_at<now()-interval '6 days'
    ORDER BY expires_at LIMIT 1000)`;
}
