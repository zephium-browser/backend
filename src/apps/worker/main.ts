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
if (
  config.NODE_ENV === "production" &&
  config.DEPLOYMENT_MODE === "hosted" &&
  !config.OPERATIONS_WEBHOOK
)
  throw new Error("Worker requires an operational alert destination");
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
const operationsWebhook = config.OPERATIONS_WEBHOOK;
const alerts = operationsWebhook
  ? new WorkerAlerts(
      (message) => sendOperationalNotification(operationsWebhook, message),
      () => operationalEvent("worker_alert_delivery_failed"),
    )
  : undefined;
const billing = !!config.POLAR_ACCESS_TOKEN;

/**
 * Each task fails independently: a broken cleanup or recovery step must never
 * stop billing reconciliation. A task that keeps failing marks the worker
 * unready and alerts, instead of silently retrying behind a healthy status.
 */
type Task = {
  name: string;
  every: number;
  run: () => Promise<boolean | undefined | void>;
  last: number;
  failures: number;
};
const failingAfter = 5;
const tasks: Task[] = [
  { name: "cleanup", every: 3600_000, run: () => cleanup(db) },
  { name: "waitlist_cleanup", every: 3600_000, run: () => cleanupWaitlist(db) },
  { name: "request_recovery", every: 5000, run: () => recoverRequests(db) },
  ...(billing
    ? [
        { name: "plan_changes", every: 0, run: () => processPlanChange(db, provider, policy) },
        { name: "orders", every: 0, run: () => processOrder(db, policy, provider) },
        { name: "contacts", every: 0, run: () => processContactSync(db, provider) },
        { name: "usage_export", every: 0, run: () => exportUsage(db, ingestUsage) },
      ]
    : []),
  { name: "reconcile", every: 0, run: () => workOnce(db, provider, products, ranks) },
].map((task) => ({ ...task, last: 0, failures: 0 }));

/** Returns true when any queue made progress, so the loop can continue without sleeping. */
async function runTasks(): Promise<boolean> {
  let worked = false;
  for (const task of tasks) {
    if (stopped) break;
    if (task.every && Date.now() - task.last < task.every) continue;
    // Periodic tasks advance their schedule even on failure; queues retry next tick.
    task.last = Date.now();
    try {
      if ((await task.run()) === true) worked = true;
      task.failures = 0;
    } catch {
      task.failures++;
      operationalEvent(`worker_${task.name}_failed`);
    }
  }
  return worked;
}

let lastHealth = 0;
let lastHeartbeat = 0;
async function reportHealth(): Promise<void> {
  const [status] =
    await db.sql`SELECT EXISTS(SELECT 1 FROM billing_plan_change WHERE attempts>=10 AND state IN ('executing','uncertain')) OR EXISTS(SELECT 1 FROM billing_customer WHERE attempts >= 10) OR EXISTS(SELECT 1 FROM billing_order_job WHERE attempts>=10 AND requested>processed) OR EXISTS(SELECT 1 FROM cloud_outbox WHERE attempts>=10 AND delivered_at IS NULL) AS exhausted, EXISTS(SELECT 1 FROM billing_contact_job j JOIN auth_user u ON u.id=j.user_id WHERE j.attempts>=10 AND j.requested>j.processed AND u.lifecycle='active') AS contact_exhausted`;
  const failing = tasks.filter((task) => task.failures >= failingAfter).map((task) => task.name);
  const ready = !status?.exhausted && failing.length === 0;
  await writeFile(
    "/tmp/zephium-worker-health.tmp",
    JSON.stringify({ time: Date.now(), ready, failing }),
    { mode: 0o600 },
  );
  await rename("/tmp/zephium-worker-health.tmp", "/tmp/zephium-worker-health.json");
  let budget: boolean | undefined;
  try {
    budget = await budgetNearLimit(db, policy);
  } catch {
    operationalEvent("worker_budget_check_failed");
  }
  await alerts?.scan({
    billing: Boolean(status?.exhausted),
    contact: Boolean(status?.contact_exhausted),
    worker: failing.length > 0,
    ...(budget === undefined ? {} : { budget }),
  });
  // An external dead-man check alerts when these pings stop (dead host, stuck loop).
  if (config.WORKER_HEARTBEAT_URL && ready && Date.now() - lastHeartbeat >= 60_000) {
    try {
      const response = await fetch(config.WORKER_HEARTBEAT_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      if (response.ok) lastHeartbeat = Date.now();
      else operationalEvent("worker_heartbeat_failed");
    } catch {
      operationalEvent("worker_heartbeat_failed");
    }
  }
}

let stopped = false;
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
    } catch {
      operationalEvent("worker_database_unavailable");
      await Bun.sleep(1000);
      continue;
    }
    if (Date.now() - lastHealth > 60_000) {
      try {
        await reportHealth();
        lastHealth = Date.now();
      } catch {
        operationalEvent("worker_health_failed");
      }
    }
    if (!(await runTasks())) await Bun.sleep(1000);
  }
} finally {
  await db.close();
}
