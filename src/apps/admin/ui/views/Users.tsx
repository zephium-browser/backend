import { useState } from "preact/hooks";
import { api } from "../api";
import { Badge, lifecycleTone, subscriptionTone } from "../components/Badge";
import { Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { Async, Skeleton } from "../components/States";
import { Table } from "../components/Table";
import { humanize, planName, utc } from "../format";
import { useCursorPager, useResource } from "../hooks";
import { navigate, toHash, USER_FILTERS, type UserFilter } from "../router";

const FILTER_LABELS: Record<UserFilter, string> = {
  "": "All",
  paying: "Paying",
  deleting: "Deleting",
  unverified: "Unverified",
};

export function UsersView({ q, filter }: { q: string; filter: UserFilter }) {
  const pager = useCursorPager(`${q}|${filter}`);
  const res = useResource(`users:${q}|${filter}|${pager.cursor ?? ""}`, (signal) =>
    api.users(q, filter, pager.cursor, signal),
  );
  // The field mirrors the URL; typing is local until the search is submitted.
  const [draft, setDraft] = useState({ q, seen: q });
  const text = draft.seen === q ? draft.q : q;
  const submit = (value: string) => navigate({ name: "users", q: value.trim(), filter });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Newest accounts first. Search needs a full email address or a user ID."
        loadedAt={res.loadedAt}
        refreshing={res.refreshing}
        onRefresh={res.reload}
      />
      <Card title="Find a user">
        {/* biome-ignore lint/a11y/useSemanticElements: role=search on a form is the widely supported pattern */}
        <form
          class="search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            submit(text);
          }}
        >
          <label class="sr-only" for="user-search">
            Exact email address or user ID
          </label>
          <input
            id="user-search"
            type="search"
            class="input"
            placeholder="name@example.com or user ID"
            maxLength={320}
            autocomplete="off"
            spellcheck={false}
            value={text}
            onInput={(event) => setDraft({ q: event.currentTarget.value, seen: q })}
          />
          <button type="submit" class="btn btn-primary">
            Search
          </button>
          {q ? (
            <button
              type="button"
              class="btn btn-quiet"
              onClick={() => navigate({ name: "users", q: "", filter })}
            >
              Clear
            </button>
          ) : null}
        </form>
        <nav class="chips" aria-label="Filter users">
          {USER_FILTERS.map((value) => (
            <a
              key={value}
              class="chip"
              href={toHash({ name: "users", q, filter: value })}
              aria-current={value === filter ? "true" : undefined}
            >
              {FILTER_LABELS[value]}
            </a>
          ))}
        </nav>
      </Card>

      <Card
        title="Accounts"
        description={
          res.data
            ? `${res.data.items.length} ${res.data.items.length === 1 ? "user" : "users"} on this page${q ? " matching your search" : ""}`
            : undefined
        }
        flush
      >
        <Async res={res} title="Users could not be loaded" skeleton={<Skeleton lines={6} />}>
          {(data) => (
            <>
              <Table
                caption="Users"
                rows={data.items}
                rowKey={(row) => row.id}
                empty={q ? "No user matches that exact email or ID" : "No users match"}
                emptyDetail={
                  q
                    ? "Check for typos. Partial addresses and names are not searched."
                    : filter
                      ? "Try a different filter."
                      : undefined
                }
                columns={[
                  {
                    id: "user",
                    header: "User",
                    cell: (row) => (
                      <>
                        <a class="cell-main" href={toHash({ name: "user", id: row.id })}>
                          {row.email}
                        </a>
                        <span class="cell-sub">{row.name ?? "No name"}</span>
                      </>
                    ),
                  },
                  {
                    id: "status",
                    header: "Account",
                    cell: (row) => (
                      <span class="badges">
                        <Badge tone={lifecycleTone(row.lifecycle)}>{humanize(row.lifecycle)}</Badge>
                        {row.email_verified ? null : <Badge tone="warn">Unverified</Badge>}
                      </span>
                    ),
                  },
                  {
                    id: "plan",
                    header: "Plan",
                    cell: (row) => (
                      <>
                        <span class="cell-main">{planName(row.plan)}</span>
                        {row.subscription_status ? (
                          <span class="cell-sub">
                            <Badge tone={subscriptionTone(row.subscription_status)}>
                              {humanize(row.subscription_status)}
                            </Badge>
                          </span>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    id: "paid",
                    header: "Paid until (UTC)",
                    nowrap: true,
                    cell: (row) => (row.paid_until ? utc(row.paid_until) : "—"),
                  },
                  {
                    id: "created",
                    header: "Created (UTC)",
                    nowrap: true,
                    cell: (row) => utc(row.created_at),
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
