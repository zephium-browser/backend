import { api, type JobQueue } from "../api";
import { Badge, type Tone } from "../components/Badge";
import { Card } from "../components/Card";
import { Kpi, KpiRow } from "../components/Kpi";
import { PageHeader } from "../components/PageHeader";
import { Async, KpiSkeleton, Skeleton } from "../components/States";
import { Table } from "../components/Table";
import { count, duration, humanize } from "../format";
import { useResource } from "../hooks";

const DESCRIPTIONS: Record<string, string> = {
  subscription_sync: "Reconciling subscriptions with the billing provider",
  orders: "Recording paid orders",
  billing_contacts: "Syncing customer billing contacts",
  plan_changes: "Applying plan changes",
  usage_export: "Delivering usage records",
  unconfirmed_usage: "Requests waiting for provider cost confirmation",
  account_deletion: "Accounts waiting to be deleted",
};

export type QueueHealth = "healthy" | "backlog" | "exhausted";
export function queueHealth(queue: JobQueue): QueueHealth {
  if (queue.exhausted > 0) return "exhausted";
  return queue.pending > 0 || queue.retrying > 0 ? "backlog" : "healthy";
}
const HEALTH: Record<QueueHealth, { tone: Tone; text: string }> = {
  healthy: { tone: "ok", text: "Healthy" },
  backlog: { tone: "warn", text: "Backlog" },
  exhausted: { tone: "critical", text: "Exhausted" },
};

export function JobsView() {
  const res = useResource("jobs", (signal) => api.jobs(signal));
  return (
    <>
      <PageHeader
        title="Background jobs"
        subtitle="Durable queues that keep billing and usage in sync. A backlog drains on its own; exhausted jobs keep retrying hourly but need attention."
        loadedAt={res.loadedAt}
        refreshing={res.refreshing}
        onRefresh={res.reload}
      />
      <Async
        res={res}
        title="Job health could not be loaded"
        skeleton={
          <>
            <KpiSkeleton count={3} />
            <Card title="Queues">
              <Skeleton lines={6} />
            </Card>
          </>
        }
      >
        {(data) => {
          const total = (pick: (queue: JobQueue) => number) =>
            data.queues.reduce((sum, queue) => sum + pick(queue), 0);
          const exhausted = total((queue) => queue.exhausted);
          return (
            <>
              <KpiRow label="Queue totals">
                <Kpi label="Pending" value={count(total((queue) => queue.pending))} />
                <Kpi label="Retrying" value={count(total((queue) => queue.retrying))} />
                <Kpi
                  label="Exhausted"
                  value={count(exhausted)}
                  tone={exhausted > 0 ? "critical" : "ok"}
                  note={exhausted > 0 ? "Needs attention" : "None"}
                />
              </KpiRow>
              <Card title="Queues" flush>
                <Table
                  caption="Background job queues"
                  rows={data.queues}
                  rowKey={(row) => row.queue}
                  empty="No queues reported"
                  columns={[
                    {
                      id: "queue",
                      header: "Queue",
                      cell: (row) => (
                        <>
                          <span class="cell-main">{humanize(row.queue)}</span>
                          <span class="cell-sub">{DESCRIPTIONS[row.queue] ?? row.queue}</span>
                        </>
                      ),
                    },
                    {
                      id: "status",
                      header: "Status",
                      cell: (row) => {
                        const health = HEALTH[queueHealth(row)];
                        return <Badge tone={health.tone}>{health.text}</Badge>;
                      },
                    },
                    {
                      id: "pending",
                      header: "Pending",
                      align: "end",
                      cell: (row) => count(row.pending),
                    },
                    {
                      id: "retrying",
                      header: "Retrying",
                      align: "end",
                      cell: (row) => count(row.retrying),
                    },
                    {
                      id: "exhausted",
                      header: "Exhausted",
                      align: "end",
                      cell: (row) => count(row.exhausted),
                    },
                    {
                      id: "oldest",
                      header: "Oldest due",
                      align: "end",
                      nowrap: true,
                      cell: (row) =>
                        row.oldest_due_seconds === null ? (
                          <span class="muted">—</span>
                        ) : (
                          `${duration(row.oldest_due_seconds)} ago`
                        ),
                    },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </Async>
    </>
  );
}
