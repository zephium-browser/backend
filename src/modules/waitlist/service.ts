import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { emailNetwork } from "../../platform/ip-bucket";

/** Created only by the eventual launch sender; never returned by public signup. */
export function waitlistUnsubscribeUrl(config: Config, id: string): string {
  z.uuid().parse(id);
  const url = new URL("/linux/unsubscribe", config.WAITLIST_WEB_ORIGIN);
  url.hash = new URLSearchParams({
    token: `${id}.${privateKey(config.AUTH_SECRET, "linux-waitlist-unsubscribe:v1", id)}`,
  }).toString();
  return url.href;
}
/** Human-click unsubscribe header; do not advertise RFC 8058 POST without its separate handler. */
export function waitlistUnsubscribeHeaders(config: Config, id: string): Record<string, string> {
  return { "List-Unsubscribe": `<${waitlistUnsubscribeUrl(config, id)}>` };
}
export function createWaitlistService(config: Config, db: Database) {
  const unsubscribeSignature = (id: string) =>
    privateKey(config.AUTH_SECRET, "linux-waitlist-unsubscribe:v1", id);
  return {
    async join(input: unknown, ip: string) {
      const { email, website } = z
        .object({
          email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
          website: z.string().max(200).optional(),
        })
        .strict()
        .parse(input);
      const key = (kind: string, value: string) =>
        privateKey(config.ABUSE_SECRET, `linux-waitlist:${kind}`, value);
      await enforce(db, key("network", emailNetwork(ip)), 900, 5);
      await enforce(db, key("minute", "all"), 60, config.WAITLIST_REQUESTS_PER_MINUTE);
      await enforce(db, key("day", "all"), 86400, config.WAITLIST_REQUESTS_PER_DAY);
      // A filled honeypot gets the same response but cannot create membership.
      if (website?.trim()) return;
      await enforce(db, key("email", email), 900, 3);
      await enforce(db, key("cooldown", email), 60, 1);
      const invited = config.SIGNUP_EMAIL_ALLOWLIST.split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      if (invited.length && !invited.includes(email)) return;
      // A submission records consent, not verified mailbox ownership. No mail is sent.
      // Preserve existing membership IDs and consent dates on duplicates.
      await db.sql`INSERT INTO linux_waitlist(id,email,subscribed_at,consent_version)
        VALUES (${randomUUID()},${email},now(),'linux-release-single-opt-in-v1')
        ON CONFLICT(email) DO UPDATE SET subscribed_at=now(),
          consent_version='linux-release-single-opt-in-v1',confirmation_hash=NULL,expires_at=NULL
        WHERE linux_waitlist.subscribed_at IS NULL AND linux_waitlist.confirmed_at IS NULL`;
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
      const rows = await db.sql`UPDATE linux_waitlist SET confirmed_at=coalesce(confirmed_at,now()),
        subscribed_at=coalesce(subscribed_at,now())
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
  await db.sql`SELECT id,email,created_at,confirmed_at,subscribed_at,confirmation_hash,expires_at,consent_version FROM linux_waitlist LIMIT 0`;
}
export async function cleanupWaitlist(db: Database): Promise<void> {
  const [schema] = await db.sql`SELECT to_regclass('public.linux_waitlist') IS NOT NULL AS present`;
  if (!schema?.present) return;
  await db.sql`DELETE FROM linux_waitlist WHERE id IN (
    SELECT id FROM linux_waitlist WHERE confirmed_at IS NULL AND subscribed_at IS NULL AND expires_at<now()-interval '6 days'
    ORDER BY expires_at LIMIT 1000)`;
}
