import type { AdminReports, UserFilter } from "../../modules/admin";
import { AppError } from "../../platform/errors";

export type AuditAction =
  | "overview"
  | "users"
  | "user"
  | "search"
  | "activity"
  | "revenue"
  | "jobs"
  | "waitlist"
  | "waitlist_export"
  | "audit";
type Outcome = { result: unknown; action: AuditAction; audited?: string | null };
export type ReportEndpoint = {
  query: string[];
  /** Export pages use a separate, larger read budget. */
  bulk?: boolean;
  run(params: URLSearchParams, target: string | null): Promise<Outcome>;
};

function choice<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  const selected = value ?? fallback;
  if (!(allowed as readonly string[]).includes(selected)) throw new AppError("invalid_request");
  return selected as T;
}
const cursor = (params: URLSearchParams) => params.get("cursor") ?? undefined;

/** Every report is GET-only, read-only and audited; the session endpoint is handled separately. */
export function createReportEndpoints(reports: AdminReports): Map<string, ReportEndpoint> {
  return new Map<string, ReportEndpoint>([
    ["/api/session", { query: [], run: async () => ({ result: null, action: "overview" }) }],
    [
      "/api/overview",
      {
        query: ["days"],
        run: async (params) => ({
          action: "overview",
          result: await reports.overview(
            Number(choice(params.get("days"), ["1", "7", "30"], "1")) as 1 | 7 | 30,
          ),
        }),
      },
    ],
    [
      "/api/activity",
      {
        query: ["days"],
        run: async (params) => ({
          action: "activity",
          result: await reports.activity(
            Number(choice(params.get("days"), ["30", "90"], "30")) as 30 | 90,
          ),
        }),
      },
    ],
    [
      "/api/revenue",
      { query: [], run: async () => ({ action: "revenue", result: await reports.revenue() }) },
    ],
    [
      "/api/jobs",
      { query: [], run: async () => ({ action: "jobs", result: await reports.jobs() }) },
    ],
    [
      "/api/users",
      {
        query: ["q", "cursor", "filter"],
        run: async (params) => {
          const q = params.get("q") ?? "";
          const filter = choice<UserFilter>(
            params.get("filter"),
            ["", "paying", "deleting", "unverified"],
            "",
          );
          const result = await reports.users(q, cursor(params), filter);
          // Record whom a search found, not the address typed.
          return q.trim()
            ? { action: "search", result, audited: result.items[0]?.id ?? null }
            : { action: "users", result };
        },
      },
    ],
    [
      "/api/users/:id",
      {
        query: [],
        run: async (_params, target) => ({
          action: "user",
          result: await reports.user(target ?? ""),
        }),
      },
    ],
    [
      "/api/audit",
      {
        query: ["cursor"],
        run: async (params) => ({ action: "audit", result: await reports.audit(cursor(params)) }),
      },
    ],
    [
      "/api/waitlists/linux",
      {
        query: ["cursor"],
        run: async (params) => ({
          action: "waitlist",
          audited: "linux-waitlist",
          result: await reports.linuxWaitlist(cursor(params)),
        }),
      },
    ],
    [
      "/api/waitlists/linux/export",
      {
        query: ["cursor"],
        bulk: true,
        run: async (params) => ({
          action: "waitlist_export",
          audited: "linux-waitlist",
          result: await reports.linuxWaitlist(cursor(params), 1000),
        }),
      },
    ],
  ]);
}
