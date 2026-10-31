import type { Database } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";
import { applyTopup } from "../credits";
import type { CloudPolicy } from "../policy";
import type { BillingProvider } from "./provider";
export async function processOrder(db: Database, p: CloudPolicy, provider: BillingProvider) {
  const fetchOrder = provider.order?.bind(provider);
  if (!fetchOrder) return false;
  return await db.sql.begin(async (tx) => {
    const [job] =
      await tx`SELECT * FROM billing_order_job WHERE requested>processed AND next_attempt<=now() ORDER BY next_attempt FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!job) return false;
    try {
      const order = await fetchOrder(job.order_id);
      if (order.userId !== job.user_id || order.id !== job.order_id)
        throw new Error("Order identity mismatch");
      await applyTopup(db, p, order);
      await tx`UPDATE billing_order_job SET processed=${job.requested},attempts=0 WHERE order_id=${job.order_id}`;
    } catch {
      const attempts = Number(job.attempts) + 1;
      await tx`UPDATE billing_order_job SET attempts=${attempts},next_attempt=now()+${Math.min(3600, 15 * 2 ** attempts)}*interval '1 second' WHERE order_id=${job.order_id}`;
      operationalEvent(attempts >= 10 ? "billing_order_exhausted" : "billing_order_retry");
    }
    return true;
  });
}
