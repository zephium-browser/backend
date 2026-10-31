import type { ComponentChildren } from "preact";
import { type Activity, type ActivityPoint, api } from "../api";
import { Card } from "../components/Card";
import { Chart, type ChartExtra, type ChartSeries, DataToggle, Legend } from "../components/Chart";
import { PageHeader, Segmented } from "../components/PageHeader";
import { Async, Skeleton } from "../components/States";
import { type Column, Table } from "../components/Table";
import { compact, count, credits, microsToDollars, sumUnits, usd } from "../format";
import { useResource } from "../hooks";
import { type ActivityDays, toHash } from "../router";

const PERIODS: ActivityDays[] = [30, 90];

export function ActivityView({ days }: { days: ActivityDays }) {
  const res = useResource(`activity:${days}`, (signal) => api.activity(days, signal));
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Daily trends. Each day is a UTC calendar day, oldest first, with empty days included."
        loadedAt={res.loadedAt}
        refreshing={res.refreshing}
        onRefresh={res.reload}
      >
        <Segmented
          label="Period"
          options={PERIODS.map((value) => ({
            text: `${value} days`,
            href: toHash({ name: "activity", days: value }),
            current: value === days,
          }))}
        />
      </PageHeader>
      <Async
        res={res}
        title="Activity could not be loaded"
        skeleton={
          <div class="grid grid-2">
            {[0, 1, 2, 3].map((index) => (
              <Card key={index} title="Loading">
                <Skeleton lines={5} tall />
              </Card>
            ))}
          </div>
        }
      >
        {(data) => <ActivityBody data={data} />}
      </Async>
    </>
  );
}

function ChartCard({
  title,
  summary,
  legend,
  chart,
  tableLabel,
  columns,
  rows,
}: {
  title: string;
  summary: ComponentChildren;
  legend: Pick<ChartSeries, "id" | "label" | "tone">[];
  chart: ComponentChildren;
  tableLabel: string;
  columns: Column<ActivityPoint>[];
  rows: ActivityPoint[];
}) {
  return (
    <Card title={title} description={summary}>
      {legend.length > 1 ? <Legend series={legend} /> : null}
      {chart}
      <DataToggle label={`${tableLabel} data table`}>
        <Table
          caption={`${title}, one row per UTC day`}
          rows={[...rows].reverse()}
          rowKey={(row) => row.day}
          maxHeight
          columns={columns}
        />
      </DataToggle>
    </Card>
  );
}

const dayColumn: Column<ActivityPoint> = {
  id: "day",
  header: "Day (UTC)",
  nowrap: true,
  cell: (row) => row.day,
};

function ActivityBody({ data }: { data: Activity }) {
  const rows = data.series;
  const days = rows.map((row) => row.day);
  const units = data.credit_units;
  const ints = (pick: (row: ActivityPoint) => number) => rows.map(pick);
  const text = (values: number[]) => values.map((value) => count(value));

  const signups: ChartSeries = {
    id: "signups",
    label: "Signups",
    tone: "accent",
    values: ints((row) => row.signups),
    display: text(ints((row) => row.signups)),
  };
  const active: ChartSeries = {
    id: "active",
    label: "Active AI users",
    tone: "accent",
    values: ints((row) => row.active_users),
    display: text(ints((row) => row.active_users)),
  };
  const succeeded = ints((row) => Math.max(0, row.calls - row.failed - row.stopped));
  const calls: ChartSeries[] = [
    {
      id: "ok",
      label: "Succeeded or other",
      tone: "accent",
      values: succeeded,
      display: text(succeeded),
    },
    {
      id: "stopped",
      label: "Stopped by customer",
      tone: "muted",
      values: ints((row) => row.stopped),
      display: text(ints((row) => row.stopped)),
    },
    {
      id: "failed",
      label: "Failed",
      tone: "critical",
      values: ints((row) => row.failed),
      display: text(ints((row) => row.failed)),
    },
  ];
  const cost: ChartSeries = {
    id: "cost",
    label: "Known provider cost",
    tone: "accent",
    values: rows.map((row) => microsToDollars(row.provider_cost_usd_micros)),
    display: rows.map((row) => usd(row.provider_cost_usd_micros)),
  };

  const signupExtras: ChartExtra[] = [
    { label: "New paid subscriptions", display: text(ints((row) => row.new_paid)) },
  ];
  const callExtras: ChartExtra[] = [
    { label: "Total requests", display: text(ints((row) => row.calls)) },
  ];
  const costExtras: ChartExtra[] = [
    {
      label: "Charged credits",
      display: rows.map((row) => credits(row.charged_units, units)),
    },
  ];
  const total = (pick: (row: ActivityPoint) => number) =>
    count(rows.reduce((sum, row) => sum + pick(row), 0));
  const peak = Math.max(0, ...rows.map((row) => row.active_users));

  return (
    <div class="grid grid-2">
      <ChartCard
        title="Signups"
        summary={`${total((row) => row.signups)} new accounts, ${total((row) => row.new_paid)} new paid`}
        legend={[signups]}
        chart={
          <Chart
            title="Daily signups"
            days={days}
            series={[signups]}
            kind="bars"
            tick={compact}
            extras={signupExtras}
          />
        }
        tableLabel="signups"
        rows={rows}
        columns={[
          dayColumn,
          { id: "signups", header: "Signups", align: "end", cell: (row) => count(row.signups) },
          {
            id: "paid",
            header: "New paid",
            align: "end",
            cell: (row) => count(row.new_paid),
          },
        ]}
      />
      <ChartCard
        title="Active AI users"
        summary={`Peak ${count(peak)} users in a day`}
        legend={[active]}
        chart={
          <Chart
            title="Daily active AI users"
            days={days}
            series={[active]}
            kind="line"
            tick={compact}
          />
        }
        tableLabel="active users"
        rows={rows}
        columns={[
          dayColumn,
          {
            id: "active",
            header: "Active users",
            align: "end",
            cell: (row) => count(row.active_users),
          },
        ]}
      />
      <ChartCard
        title="AI requests"
        summary={`${total((row) => row.calls)} requests, ${total((row) => row.failed)} failed, ${total((row) => row.stopped)} stopped by customers`}
        legend={calls}
        chart={
          <Chart
            title="Daily AI requests by outcome"
            days={days}
            series={calls}
            kind="bars"
            stacked
            tick={compact}
            extras={callExtras}
          />
        }
        tableLabel="request"
        rows={rows}
        columns={[
          dayColumn,
          { id: "calls", header: "Requests", align: "end", cell: (row) => count(row.calls) },
          { id: "failed", header: "Failed", align: "end", cell: (row) => count(row.failed) },
          { id: "stopped", header: "Stopped", align: "end", cell: (row) => count(row.stopped) },
        ]}
      />
      <ChartCard
        title="Provider cost"
        summary={`${usd(sumUnits(rows.map((row) => row.provider_cost_usd_micros)))} known cost, ${credits(sumUnits(rows.map((row) => row.charged_units)), units)} credits charged`}
        legend={[cost]}
        chart={
          <Chart
            title="Daily known provider cost in US dollars"
            days={days}
            series={[cost]}
            kind="line"
            tick={(value) => `$${compact(value)}`}
            extras={costExtras}
          />
        }
        tableLabel="cost"
        rows={rows}
        columns={[
          dayColumn,
          {
            id: "cost",
            header: "Provider cost",
            align: "end",
            cell: (row) => usd(row.provider_cost_usd_micros),
          },
          {
            id: "credits",
            header: "Credits charged",
            align: "end",
            cell: (row) => credits(row.charged_units, units),
          },
        ]}
      />
    </div>
  );
}
