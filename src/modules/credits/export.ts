import type { Database } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";

/** The sink must deduplicate payload.externalId when an acknowledgement is lost. */
export type IngestUsage = (payload: Record<string, unknown>) => Promise<void>;

export async function exportUsage(db: Database, ingestUsage?: IngestUsage) {
  if (!ingestUsage) return false;
  return await db.sql.begin(async (tx) => {
    const [job] =
      await tx`SELECT * FROM cloud_outbox WHERE delivered_at IS NULL AND next_attempt<=now() ORDER BY next_attempt FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!job) return false;
    try {
      // The same externalId is retried after a lost acknowledgement.
      await ingestUsage(job.payload);
      await tx`UPDATE cloud_outbox SET delivered_at=now() WHERE request_id=${job.request_id}`;
    } catch {
      const attempts = Number(job.attempts) + 1;
      await tx`UPDATE cloud_outbox SET attempts=${attempts},next_attempt=now()+${Math.min(3600, 15 * 2 ** attempts)}*interval '1 second' WHERE request_id=${job.request_id}`;
      operationalEvent(attempts >= 10 ? "usage_export_exhausted" : "usage_export_retry");
    }
    return true;
  });
}
