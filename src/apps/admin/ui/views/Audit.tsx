import { api } from "../api";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { Async, Skeleton } from "../components/States";
import { Table } from "../components/Table";
import { humanize, UUID, utc } from "../format";
import { useCursorPager, useResource } from "../hooks";
import { toHash } from "../router";

const ACTIONS: Record<string, string> = {
  overview: "Viewed overview",
  users: "Listed users",
  user: "Opened a user",
  search: "Searched users",
  activity: "Viewed activity",
  revenue: "Viewed revenue",
  jobs: "Viewed jobs",
  waitlist: "Viewed waitlist",
  waitlist_export: "Exported waitlist",
  audit: "Viewed audit log",
};

export function AuditView() {
  const pager = useCursorPager("audit");
  const res = useResource(`audit:${pager.cursor ?? ""}`, (signal) =>
    api.audit(pager.cursor, signal),
  );
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every report an operator reads is recorded with who, what and when. Events are kept for 30 days."
        loadedAt={res.loadedAt}
        refreshing={res.refreshing}
        onRefresh={res.reload}
      />
      <Card title="Events" description="Newest first" flush>
        <Async
          res={res}
          title="The audit log could not be loaded"
          skeleton={<Skeleton lines={8} />}
        >
          {(data) => (
            <>
              <Table
                caption="Operator audit events"
                rows={data.items}
                rowKey={(row) => row.id}
                empty="No audit events"
                columns={[
                  {
                    id: "time",
                    header: "Time (UTC)",
                    nowrap: true,
                    cell: (row) => utc(row.created_at, { seconds: true }),
                  },
                  { id: "operator", header: "Operator", cell: (row) => row.operator_email ?? "—" },
                  {
                    id: "action",
                    header: "Action",
                    cell: (row) => (
                      <>
                        {ACTIONS[row.action] ?? humanize(row.action)}
                        {row.action === "waitlist_export" ? (
                          <>
                            {" "}
                            <Badge tone="warn">Bulk</Badge>
                          </>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    id: "target",
                    header: "Target",
                    mono: true,
                    cell: (row) =>
                      row.target_id && UUID.test(row.target_id) ? (
                        <a href={toHash({ name: "user", id: row.target_id })}>{row.target_id}</a>
                      ) : (
                        (row.target_id ?? "—")
                      ),
                  },
                ]}
              />
              <Pagination
                page={pager.page}
                hasPrevious={pager.hasPrevious}
                hasNext={data.next_cursor !== null}
                busy={res.refreshing}
                onPrevious={pager.previous}
                onNext={() => data.next_cursor && pager.next(data.next_cursor)}
              />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
