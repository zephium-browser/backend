import { api, type Jobs, type Overview } from "../api";
import { Badge } from "../components/Badge";
import { Card, Facts } from "../components/Card";
import { Kpi, KpiRow } from "../components/Kpi";
import { Meter } from "../components/Meter";
import { PageHeader, Segmented } from "../components/PageHeader";
import { Async, EmptyState, KpiSkeleton, Skeleton } from "../components/States";
import { Table } from "../components/Table";
import { count, credits, integer, rate, usd } from "../format";
import { type Resource, useResource } from "../hooks";
import { type OverviewDays, toHash } from "../router";

const PERIODS: { days: OverviewDays; text: string; phrase: string }[] = [
  { days: 1, text: "24 hours", phrase: "last 24 hours" },
  { days: 7, text: "7 days", phrase: "last 7 days" },
  { days: 30, text: "30 days", phrase: "last 30 days" },
];

export function OverviewView({ days }: { days: OverviewDays }) {
  const res = useResource(`overview:${days}`, (signal) => api.overview(days, signal));
  const jobs = useResource("jobs:summary", (signal) => api.jobs(signal));
  const phrase = PERIODS.find((period) => period.days === days)?.phrase ?? `last ${days} days`;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Usage and billing for the ${phrase}. Budgets are for the current UTC day.`}
        asOf={res.data?.as_of ?? null}
        loadedAt={res.loadedAt}
        refreshing={res.refreshing || jobs.refreshing}
        onRefresh={() => {
          res.reload();
          jobs.reload();
        }}
      >
        <Segmented
          label="Reporting period"
          options={PERIODS.map((period) => ({
            text: period.text,
            href: toHash({ name: "overview", days: period.days }),
            current: period.days === days,
          }))}
        />
      </PageHeader>
      <Async
        res={res}
        title="The overview could not be loaded"
        skeleton={
          <>
            <KpiSkeleton />
            <div class="grid grid-2">
              <Card title="Budget">
                <Skeleton lines={4} />
              </Card>
              <Card title="Requests">
                <Skeleton lines={4} />
              </Card>
            </div>
          </>
        }
      >
        {(data) => <OverviewBody data={data} jobs={jobs} period={phrase} />}
      </Async>
    </>
  );
}

function OverviewBody({
  data,
  jobs,
  period,
}: {
  data: Overview;
  jobs: Resource<Jobs>;
  period: string;
}) {
  const unknown = integer(data.usage.unknown_cost_calls) ?? 0n;
  const stopped = integer(data.usage.stopped) ?? 0n;
  return (
    <>
      <KpiRow label="Key metrics">
        <Kpi
          label="Total users"
          value={count(data.users.total)}
          note={`+${count(data.users.new)} in the ${period}`}
        />
        <Kpi
          label="Active AI users"
          value={count(data.usage.active_users)}
          note={`${count(data.usage.calls)} requests`}
        />
        <Kpi
          label="Paying subscriptions"
          value={count(data.billing.active_subscriptions)}
          note="Stored billing state"
        />
        <Kpi
          label="Charged credits"
          value={credits(data.usage.charged_units, data.credit_units)}
          note="Settled customer charges"
        />
        <Kpi
          label="Known provider cost"
          value={usd(data.usage.provider_cost_usd_micros)}
          tone={unknown > 0n ? "warn" : "neutral"}
          note={
            unknown > 0n
              ? `+${count(unknown)} unconfirmed ${unknown === 1n ? "call" : "calls"}`
              : "Recorded cost, not an invoice"
          }
        />
      </KpiRow>

      <div class="grid grid-2">
        <Card
          title="Budget"
          description={
            data.budget
              ? `Spend against configured caps · UTC day ${data.budget.day}`
              : "Provider spend against caps"
          }
        >
          {data.budget ? (
            <div class="meters">
              <Meter label="Total" spent={data.budget.total.spent} cap={data.budget.total.cap} />
              <Meter label="Today" spent={data.budget.daily.spent} cap={data.budget.daily.cap} />
              <Meter
                label="Free plan today"
                spent={data.budget.free_daily.spent}
                cap={data.budget.free_daily.cap}
              />
              <p class="hint">
                Warns at 80% of a cap, critical at 100%. Scope {data.budget.scope}
                {data.policy_revision === null ? "" : `, policy revision ${data.policy_revision}`}.
              </p>
            </div>
          ) : (
            <EmptyState title="No budget policy in force">
              Cloud budgets appear here once an active cloud policy defines caps.
            </EmptyState>
          )}
        </Card>

        <Card title="Requests" description={`Outcomes for the ${period}`}>
          <Facts
            items={[
              { label: "Total requests", value: count(data.usage.calls) },
              { label: "Dispatched to a provider", value: count(data.usage.dispatched) },
              { label: "Settled", value: count(data.usage.settled) },
              {
                label: "Failed",
                value: (
                  <>
                    {count(data.usage.failed)}{" "}
                    <span class="muted">({rate(data.usage.failed, data.usage.calls)})</span>
                  </>
                ),
              },
              {
                label: "Stopped by customer",
                value: (
                  <>
                    {count(stopped)} <span class="muted">(not counted as failures)</span>
                  </>
                ),
              },
            ]}
          />
        </Card>
      </div>

      <Card
        title="Billing operations"
        description="Current state, independent of the reporting period"
      >
        <div class="ops">
          <Facts
            items={[
              { label: "Active subscriptions", value: count(data.billing.active_subscriptions) },
              { label: "Open checkouts", value: count(data.billing.open_checkouts) },
              {
                label: "Accounts being deleted",
                value:
                  (integer(data.users.deleting) ?? 0n) > 0n ? (
                    <a href={toHash({ name: "users", q: "", filter: "deleting" })}>
                      {count(data.users.deleting)}
                    </a>
                  ) : (
                    count(data.users.deleting)
                  ),
              },
              {
                label: "Pending jobs",
                value: <a href={toHash({ name: "jobs" })}>{count(data.billing.pending_jobs)}</a>,
              },
            ]}
          />
          <JobsStrip jobs={jobs} />
        </div>
      </Card>

      <div class="grid grid-wide">
        <Card title="Top models" description={`By requests, ${period}`} flush>
          <Table
            caption={`Top models by requests, ${period}`}
            rows={data.models}
            rowKey={(row) => row.model_id}
            empty="No model usage in this period"
            columns={[
              { id: "model", header: "Model", mono: true, cell: (row) => row.model_id },
              { id: "calls", header: "Requests", align: "end", cell: (row) => count(row.calls) },
              { id: "users", header: "Users", align: "end", cell: (row) => count(row.users) },
              {
                id: "failed",
                header: "Failed",
                align: "end",
                cell: (row) => count(row.failed),
              },
              {
                id: "credits",
                header: "Credits",
                align: "end",
                cell: (row) => credits(row.charged_units, data.credit_units),
              },
              {
                id: "cost",
                header: "Provider cost",
                align: "end",
                cell: (row) => usd(row.provider_cost_usd_micros),
              },
            ]}
          />
        </Card>
        <Card
          title="Top error codes"
          description={`Failed requests, ${period}. Customer stops are excluded.`}
          flush
        >
          <Table
            caption={`Top error codes, ${period}`}
            rows={data.errors}
            rowKey={(row) => row.code}
            empty="No request errors in this period"
            columns={[
              { id: "code", header: "Error code", mono: true, cell: (row) => row.code },
              { id: "count", header: "Count", align: "end", cell: (row) => count(row.count) },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

function JobsStrip({ jobs }: { jobs: Resource<Jobs> }) {
  return (
    <div class="ops-jobs">
      <h3 class="subhead">Background jobs</h3>
      <Async res={jobs} title="Job health could not be loaded" skeleton={<Skeleton lines={2} />}>
        {(data) => {
          const sum = (pick: (queue: Jobs["queues"][number]) => number) =>
            data.queues.reduce((total, queue) => total + pick(queue), 0);
          const exhausted = sum((queue) => queue.exhausted);
          const retrying = sum((queue) => queue.retrying);
          return exhausted > 0 ? (
            <p>
              <Badge tone="critical">{exhausted} exhausted</Badge>{" "}
              <a href={toHash({ name: "jobs" })}>Review queues</a>
            </p>
          ) : (
            <p>
              <Badge tone={retrying > 0 ? "warn" : "ok"}>
                {retrying > 0 ? `${retrying} retrying` : "All queues healthy"}
              </Badge>{" "}
              <a href={toHash({ name: "jobs" })}>Queue details</a>
            </p>
          );
        }}
      </Async>
    </div>
  );
}
