import type { Database } from "../../platform/db";
import { eligibilityKey, grantMailboxKey } from "./eligibility";
import { bindGrantMailbox, lockGrantGrouping } from "./grant-mailboxes";

/**
 * Groups existing accounts under v1 grant eligibility. Idempotent and safe to rerun;
 * the API runs it at startup when migration 0011 has not been backfilled yet.
 */
export async function backfillGrantEligibility(db: Database, secret: string): Promise<number> {
  let cursor = "";
  let count = 0;
  while (true) {
    const result = await db.sql.begin(async (tx) => {
      // Account locks precede the grouping fence, matching online mutations.
      const rows = await tx`SELECT id,email,eligibility_key FROM auth_user
        WHERE id>${cursor} ORDER BY id LIMIT 100 FOR UPDATE`;
      await lockGrantGrouping(tx);
      for (const row of rows) {
        const exact = row.eligibility_key ?? eligibilityKey(secret, row.email);
        await tx`INSERT INTO email_eligibility(key) VALUES (${exact}) ON CONFLICT DO NOTHING`;
        const [alias] =
          await tx`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${exact}`;
        const identity = alias?.canonical_key ?? exact;
        // Also account for pre-eligibility installations. Import evidence of actual
        // issuance without changing a grant, a balance, or a paid entitlement.
        await tx`UPDATE email_eligibility e SET
          welcome_claimed_at=least(e.welcome_claimed_at,h.welcome_claimed_at),
          signup_claimed_at=least(e.signup_claimed_at,h.signup_claimed_at),
          free_anchor=least(e.free_anchor,h.free_anchor),
          free_period_end=greatest(e.free_period_end,h.free_period_end)
          FROM (SELECT min(g.created_at) FILTER (WHERE g.kind='welcome') AS welcome_claimed_at,
            min(g.created_at) FILTER (WHERE g.grant_key LIKE 'signup:%' AND g.plan_id=p.configuration->>'freePlan') AS signup_claimed_at,
            min(g.period_start) FILTER (WHERE g.kind='included' AND g.plan_id=p.configuration->>'freePlan') AS free_anchor,
            max(g.expires_at) FILTER (WHERE g.kind='included' AND g.plan_id=p.configuration->>'freePlan') AS free_period_end
            FROM credit_grant g JOIN cloud_policy p ON p.revision=g.policy_revision WHERE g.user_id=${row.id}) h
          WHERE e.key=${identity}`;
        await tx`UPDATE auth_user SET eligibility_key=${identity} WHERE id=${row.id} AND eligibility_key IS NULL`;
        await bindGrantMailbox(tx, identity, grantMailboxKey(secret, row.email));
      }
      if (rows.length < 100)
        await tx`UPDATE grant_eligibility_migration SET complete=true WHERE version=1`;
      return { count: rows.length, last: rows.at(-1)?.id as string | undefined };
    });
    count += result.count;
    if (result.count < 100) return count;
    if (!result.last) throw new Error("Backfill cursor missing");
    cursor = result.last;
  }
}

/** Completes the v1 backfill when needed; old API binaries must already be stopped. */
export async function prepareGrantEligibility(db: Database, secret: string): Promise<void> {
  const [state] = await db.sql`SELECT complete FROM grant_eligibility_migration WHERE version=1`;
  if (state?.complete) return;
  await backfillGrantEligibility(db, secret);
}
