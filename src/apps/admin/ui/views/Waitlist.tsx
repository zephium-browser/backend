import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, api, errorMessage, isAbort, sleep } from "../api";
import { Card } from "../components/Card";
import { Icon } from "../components/Icon";
import { Kpi, KpiRow } from "../components/Kpi";
import { PageHeader } from "../components/PageHeader";
import { Async, EmptyState, KpiSkeleton } from "../components/States";
import { count } from "../format";
import { useResource } from "../hooks";
import { buildWaitlistCsv, EXPORT_LIMIT, type ExportProgress } from "./waitlist-export";

type ExportState =
  | { phase: "idle" }
  | { phase: "running"; progress: ExportProgress }
  | { phase: "done"; rows: number }
  | { phase: "error"; message: string };

export function WaitlistView() {
  const res = useResource("waitlist", (signal) => api.waitlist(signal));
  return (
    <>
      <PageHeader
        title="Linux waitlist"
        subtitle="People who asked to be told when Zephium for Linux is available. Addresses are never shown here."
        loadedAt={res.loadedAt}
        refreshing={res.refreshing}
        onRefresh={res.reload}
      />
      <Async
        res={res}
        title="The waitlist could not be loaded"
        skeleton={<KpiSkeleton count={3} />}
      >
        {(data) =>
          data.available ? (
            <>
              <KpiRow label="Waitlist counts">
                <Kpi
                  label="Subscribed"
                  value={count(data.subscribed)}
                  note="Included in the export"
                />
                <Kpi label="Confirmed" value={count(data.confirmed)} note="Verified a mailbox" />
                <Kpi
                  label="Legacy unconfirmed"
                  value={count(data.pending)}
                  note="Excluded from the export"
                />
              </KpiRow>
              <ExportCard subscribed={data.subscribed} />
            </>
          ) : (
            <Card title="Waitlist unavailable">
              <EmptyState title="The Linux waitlist is not available in this deployment">
                The reporting view is not provisioned for this console.
              </EmptyState>
            </Card>
          )
        }
      </Async>
    </>
  );
}

function ExportCard({ subscribed }: { subscribed: number }) {
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const start = async () => {
    if (state.phase === "running") return;
    const request = new AbortController();
    controller.current = request;
    setState({ phase: "running", progress: { fetched: 0, total: subscribed, waiting: null } });
    try {
      const result = await buildWaitlistCsv(
        (cursor) => api.waitlistExport(cursor, request.signal),
        {
          signal: request.signal,
          onProgress: (progress) => setState({ phase: "running", progress }),
          wait: async (seconds) => {
            for (let left = seconds; left > 0; left--) {
              setState((current) =>
                current.phase === "running"
                  ? { phase: "running", progress: { ...current.progress, waiting: left } }
                  : current,
              );
              await sleep(1000, request.signal);
            }
          },
        },
      );
      if (result === null) return;
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "zephium-linux-waitlist.csv";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ phase: "done", rows: result.rows });
    } catch (error) {
      if (isAbort(error)) return;
      setState({
        phase: "error",
        message:
          error instanceof Error && error.message === "export_too_large"
            ? `Exports above ${count(EXPORT_LIMIT)} addresses are not supported in the browser. Use the paginated admin API.`
            : error instanceof Error && error.message === "export_unavailable"
              ? "The waitlist is not available."
              : error instanceof ApiError
                ? errorMessage(error)
                : "The export could not be completed.",
      });
    }
  };

  const running = state.phase === "running";
  const progress = state.phase === "running" ? state.progress : null;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.fetched / progress.total) * 100))
      : 0;
  return (
    <Card
      title="Export"
      description="Downloads email and subscription time (UTC) for subscribed addresses as a CSV file. Spreadsheet formulas are neutralised."
    >
      <div class="export">
        <button
          type="button"
          class="btn btn-primary"
          disabled={running}
          onClick={() => void start()}
        >
          <Icon name="download" />
          {running ? "Exporting…" : "Export subscribed emails"}
        </button>
        {running ? (
          <button
            type="button"
            class="btn"
            onClick={() => {
              controller.current?.abort();
              setState({ phase: "idle" });
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <div class="export-status" role="status" aria-live="polite">
        {progress ? (
          <>
            <div
              class="progress"
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div class="progress-fill" style={{ "--w": `${percent}%` }} />
            </div>
            <p class="muted">
              {progress.waiting !== null
                ? `Rate limited. Resuming in ${progress.waiting}s… `
                : "Fetching addresses… "}
              {count(progress.fetched)} of {count(progress.total)}
            </p>
          </>
        ) : null}
        {state.phase === "done" ? <p>Exported {count(state.rows)} addresses.</p> : null}
        {state.phase === "error" ? <p class="text-critical">{state.message}</p> : null}
      </div>
      <p class="hint">
        The list contains opted-in addresses, not necessarily verified mailboxes. No account or
        credits are created. Every export is recorded in the audit log.
      </p>
    </Card>
  );
}
