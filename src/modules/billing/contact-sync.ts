import type { Database } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";
import { pendingPlanChange } from "./plan-changes";
import type { BillingProvider } from "./provider";

/**
 * Contact retries must never exhaust subscription reconciliation or alter entitlement.
 * The job is claimed with a short lease and Polar I/O runs outside any transaction,
 * so customer requests never wait on the provider behind the billing row lock.
 */
export async function processContactSync(
  db: Database,
  provider: BillingProvider,
): Promise<boolean> {
  const claimed = await db.sql.begin(async (tx) => {
    // Match identity's billing -> account -> contact-job lock order. The verified
    // address is read after the billing lock; a later change bumps `requested`.
    const [candidate] = await tx`SELECT b.user_id FROM billing_contact_job j
      JOIN billing_customer b ON b.user_id=j.user_id JOIN auth_user u ON u.id=j.user_id
      WHERE u.lifecycle='active' AND u.email_verified AND j.requested>j.processed AND j.next_attempt<=now()
      AND NOT EXISTS(SELECT 1 FROM billing_plan_change c WHERE c.user_id=j.user_id AND c.state IN ('queued','executing','uncertain'))
      ORDER BY j.next_attempt FOR UPDATE OF b SKIP LOCKED LIMIT 1`;
    if (!candidate || (await pendingPlanChange(tx, candidate.user_id))) return null;
    const [account] =
      await tx`SELECT email,email_verified,lifecycle FROM auth_user WHERE id=${candidate.user_id}`;
    if (account?.lifecycle !== "active" || !account.email_verified) return null;
    const [job] =
      await tx`SELECT requested,processed FROM billing_contact_job WHERE user_id=${candidate.user_id} FOR UPDATE`;
    if (!job || job.requested <= job.processed) return null;
    await tx`UPDATE billing_contact_job SET next_attempt=now()+interval '5 minutes' WHERE user_id=${candidate.user_id}`;
    return {
      userId: String(candidate.user_id),
      email: String(account.email),
      requested: Number(job.requested),
    };
  });
  if (!claimed) return false;
  try {
    const state = await provider.state(claimed.userId);
    if (state) {
      if (state.accountId !== claimed.userId) throw new Error("Contact identity mismatch");
      if (state.email === undefined) throw new Error("Contact state unavailable");
      if (state.email?.trim().toLowerCase() !== claimed.email.trim().toLowerCase()) {
        if (!provider.updateCustomerEmail) throw new Error("Contact update unavailable");
        // Setting one verified address by stable external ID is idempotent.
        // After an ambiguous response, the next state read may already match.
        await provider.updateCustomerEmail(claimed.userId, claimed.email);
      }
    }
    // A customer that does not exist is never created by contact synchronization.
    // A change queued during provider I/O keeps `requested` ahead and runs next.
    await db.sql`UPDATE billing_contact_job SET processed=greatest(processed,${claimed.requested}),attempts=0,
      next_attempt=CASE WHEN requested>${claimed.requested} THEN now() ELSE next_attempt END
      WHERE user_id=${claimed.userId}`;
  } catch {
    const [row] = await db.sql<{ attempts: number }[]>`
      UPDATE billing_contact_job SET attempts=attempts+1,
        next_attempt=now()+least(3600, 15*power(2, attempts+1))*interval '1 second'
      WHERE user_id=${claimed.userId} RETURNING attempts`;
    operationalEvent(
      Number(row?.attempts) >= 10 ? "billing_contact_exhausted" : "billing_contact_retry",
    );
  }
  return true;
}
