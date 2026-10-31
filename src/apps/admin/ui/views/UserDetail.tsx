import { api, type UserDetail } from "../api";
import { Badge, lifecycleTone, planChangeTone, subscriptionTone } from "../components/Badge";
import { Card, Facts } from "../components/Card";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { Kpi, KpiRow } from "../components/Kpi";
import { PageHeader } from "../components/PageHeader";
import { Async, ErrorState, KpiSkeleton, Skeleton } from "../components/States";
import { Table } from "../components/Table";
import {
  count,
  credits,
  humanize,
  integer,
  planName,
  usd,
  usdMinor,
  utc,
  utcDate,
} from "../format";
import { useResource } from "../hooks";
import { toHash } from "../router";

const yesNo = (value: boolean, yes = "Yes", no = "No") => (value ? yes : no);
const when = (value: string | null | undefined) => (value ? `${utc(value)} UTC` : "—");

export function UserDetailView({ id }: { id: string }) {
  const res = useResource(`user:${id}`, (signal) => api.user(id, signal));
  return (
    <>
      <a class="back-link" href={toHash({ name: "users", q: "", filter: "" })}>
        <Icon name="back" />
        All users
      </a>
      {res.status === "error" && res.error?.kind === "not_found" ? (
        <ErrorState title="User not found" error={res.error} onRetry={res.reload} />
      ) : (
        <Async
          res={res}
          title="This user could not be loaded"
          skeleton={
            <>
              <PageHeader title="Loading user…" />
              <KpiSkeleton count={3} />
              <Card title="Billing">
                <Skeleton lines={5} />
              </Card>
            </>
          }
        >
          {(data) => (
            <Detail
              data={data}
              refreshing={res.refreshing}
              reload={res.reload}
              loadedAt={res.loadedAt}
            />
          )}
        </Async>
      )}
    </>
  );
}

function Detail({
  data,
  refreshing,
  reload,
  loadedAt,
}: {
  data: UserDetail;
  refreshing: boolean;
  reload: () => void;
  loadedAt: Date | null;
}) {
  const { user, balance, usage, billing } = data;
  const units = data.credit_units;
  const unknown = integer(usage.unknown_cost_calls) ?? 0n;
  return (
    <>
      <PageHeader
        title={user.email}
        subtitle={
          <>
            {user.name ?? "No name on file"}
            <span class="id-row">
              <span class="muted">ID</span> <code class="mono">{user.id}</code>
              <CopyButton value={user.id} label="Copy user ID" />
            </span>
          </>
        }
        loadedAt={loadedAt}
        refreshing={refreshing}
        onRefresh={reload}
      />
      <div class="badges badges-lead">
        <Badge tone={lifecycleTone(user.lifecycle)}>{humanize(user.lifecycle)}</Badge>
        <Badge tone="accent">{planName(user.plan)}</Badge>
        {user.subscription_status ? (
          <Badge tone={subscriptionTone(user.subscription_status)}>
            Subscription {user.subscription_status.replaceAll("_", " ")}
          </Badge>
        ) : (
          <Badge>No subscription</Badge>
        )}
        <Badge tone={user.email_verified ? "ok" : "warn"}>
          {user.email_verified ? "Email verified" : "Email unverified"}
        </Badge>
        {balance.suspended ? <Badge tone="critical">Credits suspended</Badge> : null}
      </div>

      <KpiRow label="Credits and usage">
        <Kpi
          label="Credits remaining"
          value={credits(balance.remaining_units, units)}
          note={`${credits(balance.reserved_units, units)} reserved by in-flight requests`}
        />
        <Kpi
          label="Requests, 30 days"
          value={count(usage.calls)}
          note={`${credits(usage.charged_units, units)} credits charged`}
        />
        <Kpi
          label="Known provider cost, 30 days"
          value={usd(usage.provider_cost_usd_micros)}
          tone={unknown > 0n ? "warn" : "neutral"}
          note={unknown > 0n ? `+${count(unknown)} unconfirmed` : "Recorded cost, not an invoice"}
        />
      </KpiRow>

      <div class="grid grid-2">
        <Card title="Billing" description="Stored subscription state; times in UTC">
          {billing ? (
            <Facts
              items={[
                {
                  label: "Paying",
                  value: (
                    <Badge tone={billing.paying ? "ok" : "neutral"}>{yesNo(billing.paying)}</Badge>
                  ),
                },
                { label: "Status", value: billing.status ? humanize(billing.status) : "—" },
                { label: "Product", value: billing.product ? productLabel(billing.product) : "—" },
                { label: "Paid until", value: when(billing.paid_until) },
                { label: "Current period started", value: when(billing.period_start) },
                { label: "Subscribed since", value: when(billing.subscription_start) },
                {
                  label: "Cancels at period end",
                  value: billing.cancel_at_period_end ? <Badge tone="warn">Yes</Badge> : "No",
                },
                { label: "Last reconciled", value: when(billing.reconciled_at) },
                {
                  label: "Sync attempts",
                  value: (
                    <>
                      {billing.attempts}
                      {billing.attempts > 0 ? (
                        <span class="muted"> · next {when(billing.next_attempt)}</span>
                      ) : null}
                    </>
                  ),
                },
                { label: "Refresh pending", value: yesNo(billing.refresh_pending) },
                { label: "Provider contacted", value: yesNo(billing.provider_touched) },
              ]}
            />
          ) : (
            <p class="muted">This account has never started billing.</p>
          )}
        </Card>

        <Card title="Account" description="Identity and sign-in state">
          <Facts
            items={[
              { label: "Created", value: when(user.created_at) },
              { label: "Lifecycle", value: humanize(user.lifecycle) },
              {
                label: "Plan paid until",
                value: user.paid_until ? when(user.paid_until) : "—",
              },
              { label: "Active sessions", value: String(data.sessions.length) },
            ]}
          />
          <h3 class="subhead">Active sessions</h3>
          <Table
            caption="Active sessions"
            rows={data.sessions}
            rowKey={(row, index) => `${row.created_at}:${index}`}
            empty="No active sessions"
            columns={[
              { id: "device", header: "Device", cell: (row) => row.device ?? "Unknown device" },
              {
                id: "created",
                header: "Started (UTC)",
                nowrap: true,
                cell: (row) => utc(row.created_at),
              },
              {
                id: "expires",
                header: "Expires (UTC)",
                nowrap: true,
                cell: (row) => utc(row.expires_at),
              },
            ]}
          />
        </Card>
      </div>

      <Card
        title="Credit grants"
        description="Newest first, up to 100. Balance excludes expired and revoked grants."
        flush
      >
        <Table
          caption="Credit grants"
          rows={data.grants}
          rowKey={(row) => row.id}
          empty="No credit grants"
          columns={[
            {
              id: "kind",
              header: "Kind",
              cell: (row) => (
                <>
                  {humanize(row.kind)}
                  {row.revoked ? (
                    <>
                      {" "}
                      <Badge tone="critical">Revoked</Badge>
                    </>
                  ) : null}
                </>
              ),
            },
            {
              id: "plan",
              header: "Plan",
              cell: (row) => (row.plan_id ? planName(row.plan_id) : "—"),
            },
            {
              id: "amount",
              header: "Amount",
              align: "end",
              cell: (row) => credits(row.amount, units),
            },
            {
              id: "spent",
              header: "Spent",
              align: "end",
              cell: (row) => credits(row.spent, units),
            },
            { id: "held", header: "Held", align: "end", cell: (row) => credits(row.held, units) },
            {
              id: "granted",
              header: "Granted (UTC)",
              nowrap: true,
              cell: (row) => utc(row.created_at),
            },
            {
              id: "expires",
              header: "Expires (UTC)",
              nowrap: true,
              cell: (row) => (row.expires_at ? utc(row.expires_at) : "Never"),
            },
          ]}
        />
      </Card>

      <Card title="Recent requests" description="Last 50 in the past 30 days (UTC)" flush>
        <Table
          caption="Recent AI requests"
          rows={data.requests}
          rowKey={(row) => row.id}
          empty="No requests in the last 30 days"
          columns={[
            {
              id: "time",
              header: "Time (UTC)",
              nowrap: true,
              cell: (row) => utc(row.created_at, { seconds: true }),
            },
            { id: "model", header: "Model", mono: true, cell: (row) => row.model_id },
            {
              id: "state",
              header: "State",
              cell: (row) => (
                <Badge tone={requestTone(row.state, row.error_code)}>{humanize(row.state)}</Badge>
              ),
            },
            { id: "error", header: "Error", mono: true, cell: (row) => row.error_code ?? "—" },
            {
              id: "charged",
              header: "Charged",
              align: "end",
              cell: (row) => (row.charged === null ? "—" : credits(row.charged, units)),
            },
            { id: "id", header: "Request ID", mono: true, cell: (row) => row.id },
          ]}
        />
      </Card>

      <div class="grid grid-2">
        <Card title="Plan changes" description="Most recent 20" flush>
          <Table
            caption="Plan changes"
            rows={data.plan_changes}
            rowKey={(row) => row.id}
            empty="No plan changes"
            columns={[
              {
                id: "change",
                header: "Change",
                cell: (row) => (
                  <>
                    <span class="cell-main">
                      {planName(row.current_plan)} → {planName(row.target_plan)}
                    </span>
                    <span class="cell-sub">
                      {row.direction ? humanize(row.direction) : "Unknown direction"}
                      {row.estimated_amount_minor !== null
                        ? ` · est. ${usdMinor(row.estimated_amount_minor)} ${row.currency ?? ""}`
                        : ""}
                    </span>
                  </>
                ),
              },
              {
                id: "state",
                header: "State",
                cell: (row) => (
                  <>
                    <Badge tone={planChangeTone(row.state)}>{humanize(row.state)}</Badge>
                    {row.error_code ? <span class="cell-sub mono">{row.error_code}</span> : null}
                    {row.attempts > 0 ? (
                      <span class="cell-sub">{row.attempts} attempts</span>
                    ) : null}
                  </>
                ),
              },
              {
                id: "created",
                header: "Requested (UTC)",
                nowrap: true,
                cell: (row) => (
                  <>
                    {utc(row.created_at)}
                    {row.finished_at ? (
                      <span class="cell-sub">done {utcDate(row.finished_at)}</span>
                    ) : null}
                  </>
                ),
              },
            ]}
          />
        </Card>
        <Card
          title="Open checkouts"
          description="Unexpired records can include completed checkouts"
          flush
        >
          <Table
            caption="Checkout records"
            rows={data.checkouts}
            rowKey={(row, index) => `${row.created_at}:${index}`}
            empty="No checkout records"
            columns={[
              {
                id: "kind",
                header: "Kind",
                cell: (row) => (
                  <>
                    {humanize(row.kind)}
                    <span class="cell-sub">{checkoutProduct(row.product, row.product_id)}</span>
                  </>
                ),
              },
              {
                id: "created",
                header: "Created (UTC)",
                nowrap: true,
                cell: (row) => utc(row.created_at),
              },
              {
                id: "expires",
                header: "Expires (UTC)",
                nowrap: true,
                cell: (row) => utc(row.expires_at),
              },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

/** "pro monthly" -> "Pro, monthly". */
function productLabel(product: string): string {
  const [plan, interval] = product.split(" ");
  return interval ? `${planName(plan)}, ${interval}` : planName(plan);
}

function checkoutProduct(product: string | null, productId: string | null): string {
  return product ? productLabel(product) : (productId ?? "Unknown product");
}

function requestTone(state: string, error: string | null): "ok" | "warn" | "critical" | "neutral" {
  if (error === "client_disconnected") return "neutral";
  if (error) return state === "settled" ? "warn" : "critical";
  return state === "settled" ? "ok" : "neutral";
}
