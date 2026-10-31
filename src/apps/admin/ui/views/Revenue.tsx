import { api, type PlanRevenue, type Revenue } from "../api";
import { Badge, planChangeTone } from "../components/Badge";
import { Card, Facts } from "../components/Card";
import { Kpi, KpiRow } from "../components/Kpi";
import { PageHeader } from "../components/PageHeader";
import { Async, KpiSkeleton, Skeleton } from "../components/States";
import { Table } from "../components/Table";
import { count, credits, humanize, intervalName, planName, usdMinor } from "../format";
import { useResource } from "../hooks";

export function RevenueView() {
  const res = useResource("revenue", (signal) => api.revenue(signal));
  return (
    <>
      <PageHeader
        title="Revenue"
        subtitle="Recurring revenue estimated from reconciled subscriptions. This is not an accounting ledger."
        loadedAt={res.loadedAt}
        refreshing={res.refreshing}
        onRefresh={res.reload}
      />
      <Async
        res={res}
        title="Revenue could not be loaded"
        skeleton={
          <>
            <KpiSkeleton count={3} />
            <Card title="Plans">
              <Skeleton lines={4} />
            </Card>
          </>
        }
      >
        {(data) => <RevenueBody data={data} />}
      </Async>
    </>
  );
}

function RevenueBody({ data }: { data: Revenue }) {
  const unpriced = data.plans.filter((plan) => plan.active > 0 && plan.price_minor === null);
  const mrrKnown = data.prices_configured && data.mrr_minor !== null;
  return (
    <>
      <KpiRow label="Revenue summary">
        <Kpi
          label="Monthly recurring revenue"
          value={mrrKnown ? usdMinor(data.mrr_minor) : "Not available"}
          note={
            mrrKnown
              ? "Yearly plans counted at one twelfth"
              : data.prices_configured
                ? `No price for ${unpriced.map(planLabel).join(", ") || "an active plan"}`
                : "Plan prices are not configured"
          }
          tone={mrrKnown ? "neutral" : "warn"}
        />
        <Kpi label="Paying customers" value={count(data.paying)} note="Active and paid up" />
        <Kpi
          label="Credit top-ups, 30 days"
          value={count(data.topups_30d.purchases)}
          note={`${count(data.topups_30d.buyers)} buyers`}
        />
      </KpiRow>

      {mrrKnown ? null : (
        <div class="banner banner-info" role="note">
          <div>
            <strong>MRR needs plan prices.</strong> Zephium does not read prices from the billing
            provider here. Set <code>ADMIN_PLAN_PRICES</code> on the admin service to the monthly
            price of each plan in cents, for example <code>pro:monthly=2000,max:monthly=10000</code>
            {unpriced.length > 0 ? (
              <> (missing: {unpriced.map((plan) => `${plan.plan}:${plan.interval}`).join(", ")})</>
            ) : null}
            . Until then the console shows counts only rather than a misleading $0.
          </div>
        </div>
      )}

      <Card
        title="Plans"
        description="Counts come from stored subscription state; new and lapsed cover the last 30 days (UTC)."
        flush
      >
        <Table
          caption="Subscriptions and recurring revenue by plan"
          rows={data.plans}
          rowKey={(row) => `${row.plan}:${row.interval}`}
          empty="No subscriptions yet"
          emptyDetail="Plans appear here once a customer has subscribed."
          columns={[
            { id: "plan", header: "Plan", cell: (row) => <strong>{planName(row.plan)}</strong> },
            { id: "interval", header: "Billing", cell: (row) => intervalName(row.interval) },
            { id: "active", header: "Active", align: "end", cell: (row) => count(row.active) },
            {
              id: "cancelling",
              header: "Cancelling",
              align: "end",
              cell: (row) => count(row.cancelling),
            },
            { id: "new", header: "New, 30d", align: "end", cell: (row) => count(row.new_30d) },
            {
              id: "lapsed",
              header: "Lapsed, 30d",
              align: "end",
              cell: (row) => count(row.lapsed_30d),
            },
            {
              id: "price",
              header: "Price",
              align: "end",
              cell: (row) =>
                row.price_minor === null ? (
                  <span class="muted">Not set</span>
                ) : (
                  `${usdMinor(row.price_minor)}/${row.interval === "yearly" ? "yr" : "mo"}`
                ),
            },
            {
              id: "mrr",
              header: "MRR",
              align: "end",
              cell: (row) =>
                row.mrr_minor === null ? <span class="muted">—</span> : usdMinor(row.mrr_minor),
            },
          ]}
        />
      </Card>

      <div class="grid grid-2">
        <Card title="Credit top-ups" description="Purchased credit packs, last 30 days">
          <Facts
            items={[
              { label: "Purchases", value: count(data.topups_30d.purchases) },
              { label: "Buyers", value: count(data.topups_30d.buyers) },
              {
                label: "Credits sold",
                value: credits(data.topups_30d.units, data.credit_units),
              },
            ]}
          />
        </Card>
        <Card
          title="Plan changes"
          description="Upgrades and downgrades requested in the last 30 days"
          flush
        >
          <Table
            caption="Plan change outcomes, last 30 days"
            rows={data.plan_changes_30d}
            rowKey={(row) => `${row.direction}:${row.state}`}
            empty="No plan changes in the last 30 days"
            columns={[
              {
                id: "direction",
                header: "Direction",
                cell: (row) => (row.direction ? humanize(row.direction) : "Unknown"),
              },
              {
                id: "state",
                header: "Outcome",
                cell: (row) => (
                  <Badge tone={planChangeTone(row.state)}>{humanize(row.state)}</Badge>
                ),
              },
              { id: "count", header: "Count", align: "end", cell: (row) => count(row.count) },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

function planLabel(plan: PlanRevenue): string {
  return `${planName(plan.plan)} ${plan.interval}`;
}
