import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { TransactionSql } from "postgres";
import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError, operationalEvent } from "../../platform/errors";
import type { Mailer } from "./auth";
import type { AccountMutationHooks } from "./contracts";
import { eligibilityKey, eligibilitySecret, grantMailboxKey, normalizeEmail } from "./eligibility";
import { admitEmailSend } from "./email-limits";
import { bindGrantMailbox, lockGrantGrouping } from "./grant-mailboxes";
import { signupEmailAllowed } from "./policy";
import { assertMutationSession } from "./session";

export type ActionAuthorization = {
  sessionId: string;
  beforeAccountMutation: AccountMutationHooks["beforeAccountMutation"];
};

export type ActionPurpose = "deletion" | "email-change";
export interface ActionCodeInput {
  userId: string;
  purpose: ActionPurpose;
  destinationEmail?: string;
}
export interface ConsumeActionCodeInput extends ActionCodeInput {
  otp: string;
}

function destination(input: ActionCodeInput, currentEmail: string): string {
  if (input.purpose === "deletion") {
    if (input.destinationEmail !== undefined) throw new AppError("invalid_request");
    return normalizeEmail(currentEmail);
  }
  if (input.destinationEmail === undefined) throw new AppError("invalid_request");
  const next = normalizeEmail(input.destinationEmail);
  if (next === normalizeEmail(currentEmail)) throw new AppError("invalid_request");
  return next;
}
function actionKey(config: Config, input: ActionCodeInput, address: string): string {
  return privateKey(
    config.AUTH_SECRET,
    `action-destination:${input.purpose}:${input.userId}`,
    address,
  );
}
function codeHash(config: Config, input: ActionCodeInput, key: string, code: string): string {
  return createHmac("sha256", config.AUTH_SECRET)
    .update(`${input.purpose}\0${input.userId}\0${key}\0${code}`)
    .digest("hex");
}
function sameHash(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function ownerLimitKey(config: Config, input: ActionCodeInput, kind: string): string {
  return privateKey(config.ABUSE_SECRET, `action:${kind}:${input.purpose}`, input.userId);
}

/** Stores one short-lived code per owner and purpose, with no plaintext at rest. */
export async function requestActionCode(
  config: Config,
  db: Database,
  mailer: Mailer,
  input: ActionCodeInput,
  authorization?: ActionAuthorization,
): Promise<void> {
  await enforce(db, ownerLimitKey(config, input, "send"), 900, 3);
  await enforce(db, ownerLimitKey(config, input, "cooldown"), 60, 1);
  await admitEmailSend(config, db);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const address = await db.sql.begin(async (tx) => {
    await authorization?.beforeAccountMutation(tx, input.userId);
    const [user] =
      await tx`SELECT email,lifecycle FROM auth_user WHERE id=${input.userId} FOR UPDATE`;
    if (user?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
    if (authorization)
      await assertMutationSession(
        tx,
        input.userId,
        authorization.sessionId,
        input.purpose === "email-change",
      );
    const address = destination(input, String(user.email));
    if (input.purpose === "email-change" && !signupEmailAllowed(config, address)) return null;
    const key = actionKey(config, input, address);
    const hash = codeHash(config, input, key, code);
    await tx`DELETE FROM action_otp WHERE owner_user_id=${input.userId} AND purpose=${input.purpose}`;
    await tx`INSERT INTO action_otp(owner_user_id,purpose,destination_key,otp_hash,expires_at)
      VALUES (${input.userId},${input.purpose},${key},${hash},clock_timestamp()+interval '5 minutes')`;
    return address;
  });
  if (address === null) return;
  try {
    await mailer.sendOTP(address, code, input.purpose);
  } catch (error) {
    const key = actionKey(config, input, address);
    const hash = codeHash(config, input, key, code);
    await db.sql`DELETE FROM action_otp WHERE owner_user_id=${input.userId}
      AND purpose=${input.purpose} AND destination_key=${key} AND otp_hash=${hash}`;
    operationalEvent("action_code_delivery_failed");
    throw new AppError(
      "email_unavailable",
      503,
      error instanceof AppError ? (error.retryAfter ?? 1) : 1,
    );
  }
}

async function associateDestination(
  tx: TransactionSql,
  config: Config,
  originalEmail: string,
  originalKey: string | null,
  newEmail: string,
) {
  await lockGrantGrouping(tx);
  const secret = eligibilitySecret(config);
  const sourceKey = originalKey ?? eligibilityKey(secret, originalEmail);
  const target = eligibilityKey(secret, newEmail);
  await tx`INSERT INTO email_eligibility(key) VALUES (${sourceKey}) ON CONFLICT DO NOTHING`;
  const [sourceAlias] =
    await tx`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${sourceKey}`;
  const source = sourceAlias?.canonical_key ?? sourceKey;
  const [prior] = await tx`SELECT welcome_claimed_at,signup_claimed_at,free_anchor,free_period_end
    FROM email_eligibility WHERE key=${source} FOR UPDATE`;
  if (!prior) throw new AppError("unavailable", 503);
  await bindGrantMailbox(tx, source, grantMailboxKey(secret, originalEmail));
  if (target === source) return;
  await tx`INSERT INTO email_eligibility(key) VALUES (${target}) ON CONFLICT DO NOTHING`;
  const [existingAlias] =
    await tx`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${target} FOR UPDATE`;
  if (existingAlias && existingAlias.canonical_key !== source)
    throw new AppError("eligibility_conflict", 409);
  const [targetRow] =
    await tx`SELECT welcome_claimed_at,signup_claimed_at,free_anchor,free_period_end
    FROM email_eligibility WHERE key=${target} FOR UPDATE`;
  if (
    !existingAlias &&
    (targetRow?.welcome_claimed_at ||
      targetRow?.signup_claimed_at ||
      targetRow?.free_anchor ||
      targetRow?.free_period_end)
  )
    throw new AppError("eligibility_conflict", 409);
  const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
  const claimed = prior.welcome_claimed_at ?? clock?.db_now;
  await tx`UPDATE email_eligibility SET
    welcome_claimed_at=coalesce(welcome_claimed_at,${new Date(claimed).toISOString()}::timestamptz),
    signup_claimed_at=coalesce(signup_claimed_at,${prior.signup_claimed_at ? new Date(prior.signup_claimed_at).toISOString() : null}::timestamptz),
    free_anchor=coalesce(free_anchor,${prior.free_anchor ? new Date(prior.free_anchor).toISOString() : null}::timestamptz),
    free_period_end=greatest(free_period_end,${prior.free_period_end ? new Date(prior.free_period_end).toISOString() : null}::timestamptz)
    WHERE key=${target}`;
  await tx`INSERT INTO email_eligibility_alias(alias_key,canonical_key) VALUES (${target},${source})
    ON CONFLICT(alias_key) DO NOTHING`;
  await bindGrantMailbox(tx, source, grantMailboxKey(secret, newEmail));
}

/** Successful consume and effect commit together; bad attempts commit before the 401. */
export async function consumeActionCode<T = void>(
  config: Config,
  db: Database,
  input: ConsumeActionCodeInput,
  effect?: (tx: TransactionSql) => Promise<T>,
  authorization?: ActionAuthorization,
): Promise<T> {
  if (!/^\d{6}$/.test(input.otp)) throw new AppError("invalid_code", 401);
  if (input.purpose === "email-change" && !effect) throw new AppError("invalid_request");
  await enforce(db, ownerLimitKey(config, input, "verify"), 300, 5);
  await enforce(db, ownerLimitKey(config, input, "verify-day"), 86400, 30);
  const outcome = await db.sql.begin(async (tx) => {
    // Sign-in uses the same keyed per-email advisory lock. Acquire both addresses
    // before billing/user row locks, in a stable order across competing changes.
    const [preliminary] = await tx`SELECT email FROM auth_user WHERE id=${input.userId}`;
    if (!preliminary) return { valid: false as const };
    const oldEmail = normalizeEmail(String(preliminary.email));
    const nextEmail = destination(input, oldEmail);
    if (input.purpose === "email-change" && !signupEmailAllowed(config, nextEmail))
      return { valid: false as const };
    const locks = [
      ...new Set(
        [oldEmail, nextEmail].map((address) => privateKey(config.ABUSE_SECRET, "email", address)),
      ),
    ].sort();
    for (const key of locks) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await authorization?.beforeAccountMutation(tx, input.userId);
    const [user] =
      await tx`SELECT email,lifecycle,eligibility_key FROM auth_user WHERE id=${input.userId} FOR UPDATE`;
    if (user?.lifecycle !== "active" || normalizeEmail(String(user.email)) !== oldEmail)
      return { valid: false as const };
    if (authorization)
      await assertMutationSession(
        tx,
        input.userId,
        authorization.sessionId,
        input.purpose === "email-change",
      );
    const address = destination(input, String(user.email));
    const key = actionKey(config, input, address);
    const [row] = await tx`SELECT otp_hash,attempts,expires_at FROM action_otp
      WHERE owner_user_id=${input.userId} AND purpose=${input.purpose} AND destination_key=${key} FOR UPDATE`;
    const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
    if (!row || Number(row.attempts) >= 5 || new Date(row.expires_at) <= new Date(clock?.db_now))
      return { valid: false as const };
    if (!sameHash(String(row.otp_hash), codeHash(config, input, key, input.otp))) {
      await tx`UPDATE action_otp SET attempts=attempts+1
        WHERE owner_user_id=${input.userId} AND purpose=${input.purpose} AND destination_key=${key}`;
      return { valid: false as const };
    }
    await tx`DELETE FROM action_otp
      WHERE owner_user_id=${input.userId} AND purpose=${input.purpose} AND destination_key=${key}`;
    await associateDestination(
      tx,
      config,
      String(user.email),
      user.eligibility_key ?? null,
      address,
    );
    const value = effect ? await effect(tx) : (undefined as T);
    return { valid: true as const, value };
  });
  if (!outcome.valid) throw new AppError("invalid_code", 401);
  return outcome.value;
}
