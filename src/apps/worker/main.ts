import { rename, writeFile } from "node:fs/promises";
import {
  cleanup,
  polarProvider,
  processContactSync,
  processOrder,
  processPlanChange,
  workOnce,
} from "../../modules/billing";
import { budgetNearLimit, exportUsage, recoverRequests } from "../../modules/credits";
import { assertActivePolicy, loadPolicy } from "../../modules/policy";
import { cleanupWaitlist } from "../../modules/waitlist";
import { readWorkerConfig } from "../../platform/config";
import { createDatabase } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";
import { sendOperationalNotification } from "../../platform/notifications";
import { WorkerAlerts } from "./alerts";

const config = readWorkerConfig();
const db = createDatabase(config);
const provider = polarProvider(config);
const ingestUsage = provider.ingestUsage?.bind(provider);
const policy = await loadPolicy(config.CLOUD_CONFIG_PATH);
if (config.DEPLOYMENT_MODE === "hosted" && policy.selfHostedPlan)
  throw new Error("Hosted deployment cannot select a self-hosted plan");
await assertActivePolicy(db, policy);
const products = [
  ...policy.subscriptions.map((p) => p.productId),
  config.POLAR_MONTHLY_PRODUCT_ID,
  config.POLAR_YEARLY_PRODUCT_ID,
].filter((v): v is string => !!v);
const ranks = Object.fromEntries(
  policy.subscriptions.map((s) => [
    s.productId,
    policy.plans.find((p) => p.id === s.plan)?.rank ?? 0,
  ]),
);
let stopped = false;
let lastCleanup = 0;
let lastHealth = 0;
const operationsWebhook = config.OPERATIONS_WEBHOOK;
const alerts = operationsWebhook
  ? new WorkerAlerts(
      (message) => sendOperationalNotification(operationsWebhook, message),
      () => operationalEvent("worker_alert_delivery_failed"),
    )
  : undefined;
let lastRecovery = 0;
if (
  config.NODE_ENV === "production" &&
  config.DEPLOYMENT_MODE === "hosted" &&
  !config.OPERATIONS_WEBHOOK
)
  throw new Error("Worker requires an operational alert destination");
process.once("SIGTERM", () => {
  stopped = true;
});
process.once("SIGINT", () => {
  stopped = true;
});
try {
  while (!stopped) {
    try {
      const [current] = await db.sql`SELECT revision FROM cloud_active_policy WHERE singleton=true`;
      if (current?.revision !== policy.revision) {
        operationalEvent("cloud_policy_restart_required");
        process.exitCode = 1;
        break;
      }
      if (Date.now() - lastHealth > 60_000) {
        const [status] =
          await db.sql`SELECT EXISTS(SELECT 1 FROM billing_plan_change WHERE attempts>=10 AND state IN ('executing','uncertain')) OR EXISTS(SELECT 1 FROM billing_customer WHERE attempts >= 10) OR EXISTS(SELECT 1 FROM billing_order_job WHERE attempts>=10 AND requested>processed) OR EXISTS(SELECT 1 FROM cloud_outbox WHERE attempts>=10 AND delivered_at IS NULL) AS exhausted, EXISTS(SELECT 1 FROM billing_contact_job j JOIN auth_user u ON u.id=j.user_id WHERE j.attempts>=10 AND j.requested>j.processed AND u.lifecycle='active') AS contact_exhausted`;
        const health = { time: Date.now(), ready: !status?.exhausted };
        await writeFile("/tmp/zephium-worker-health.tmp", JSON.stringify(health), { mode: 0o600 });
        await rename("/tmp/zephium-worker-health.tmp", "/tmp/zephium-worker-health.json");
        lastHealth = Date.now();
        await alerts?.scan({
          billing: Boolean(status?.exhausted),
          contact: Boolean(status?.contact_exhausted),
        });
        try {
          const budgetWarning = await budgetNearLimit(db, policy);
          await alerts?.scan({ budget: budgetWarning });
        } catch {
          operationalEvent("worker_budget_check_failed");
        }
      }
      if (Date.now() - lastCleanup > 3600_000) {
        await cleanup(db);
        await cleanupWaitlist(db);
        lastCleanup = Date.now();
      }
      if (Date.now() - lastRecovery > 5000) {
        await recoverRequests(db);
        lastRecovery = Date.now();
      }
      const planChanged = config.POLAR_ACCESS_TOKEN
        ? await processPlanChange(db, provider, policy)
        : false;
      const orderWorked = config.POLAR_ACCESS_TOKEN
        ? await processOrder(db, policy, provider)
        : false;
      const contactWorked = config.POLAR_ACCESS_TOKEN
        ? await processContactSync(db, provider)
        : false;
      const exported = config.POLAR_ACCESS_TOKEN ? await exportUsage(db, ingestUsage) : false;
      const reconciled = await workOnce(db, provider, products, ranks);
      if (planChanged || orderWorked || contactWorked || exported || reconciled) continue;
    } catch {
      operationalEvent("worker_iteration_failed");
    }
    await Bun.sleep(1000);
  }
} finally {
  await db.close();
}
