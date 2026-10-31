import type { Numeric } from "./format";
import type { UserFilter } from "./router";

/* ------------------------------------------------------------------ response types */

export type Operator = {
  id: string;
  email: string;
  name: string | null;
  enrolled: boolean;
  mfaVerified: boolean;
  expiresAt: string;
};

export type Pair = { spent: string; cap: string | null };
export type Overview = {
  as_of: string;
  days: number;
  policy_revision: number | null;
  users: { total: Numeric; verified: Numeric; new: Numeric; deleting: Numeric };
  usage: {
    calls: Numeric;
    dispatched: Numeric;
    settled: Numeric;
    failed: Numeric;
    stopped: Numeric;
    active_users: Numeric;
    charged_units: string;
    provider_cost_usd_micros: string;
    unknown_cost_calls: Numeric;
  };
  billing: { active_subscriptions: Numeric; open_checkouts: Numeric; pending_jobs: Numeric };
  models: {
    model_id: string;
    calls: Numeric;
    users: Numeric;
    failed: Numeric;
    charged_units: string;
    provider_cost_usd_micros: string;
  }[];
  errors: { code: string; count: Numeric }[];
  budget: null | { scope: string; day: string; total: Pair; daily: Pair; free_daily: Pair };
  credit_units: string;
};

export type ActivityPoint = {
  day: string;
  signups: number;
  new_paid: number;
  calls: number;
  active_users: number;
  failed: number;
  stopped: number;
  charged_units: string;
  provider_cost_usd_micros: string;
};
export type Activity = { days: number; series: ActivityPoint[]; credit_units: string };

export type PlanRevenue = {
  plan: string;
  interval: string;
  active: number;
  cancelling: number;
  new_30d: number;
  lapsed_30d: number;
  price_minor: number | null;
  mrr_minor: number | null;
};
export type Revenue = {
  currency: string;
  prices_configured: boolean;
  paying: number;
  mrr_minor: number | null;
  plans: PlanRevenue[];
  topups_30d: { purchases: number; buyers: number; units: string };
  plan_changes_30d: { direction: string | null; state: string; count: number }[];
  credit_units: string;
};

export type JobQueue = {
  queue: string;
  pending: number;
  retrying: number;
  exhausted: number;
  oldest_due_seconds: number | null;
};
export type Jobs = { queues: JobQueue[] };

export type UserSummary = {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  email_verified: boolean;
  lifecycle: string;
  subscription_status: string | null;
  product_id: string | null;
  plan: string;
  paid_until: string | null;
};
export type UserPage = { items: UserSummary[]; next_cursor: string | null };

export type UserDetail = {
  user: UserSummary;
  sessions: { device: string | null; created_at: string; expires_at: string }[];
  balance: { remaining_units: string; reserved_units: string; suspended: boolean };
  usage: {
    calls: Numeric;
    charged_units: string;
    provider_cost_usd_micros: string;
    unknown_cost_calls: Numeric;
  };
  requests: {
    id: string;
    model_id: string;
    state: string;
    error_code: string | null;
    charged: string | null;
    created_at: string;
  }[];
  billing: null | {
    status: string | null;
    product_id: string | null;
    product: string | null;
    paid_until: string | null;
    period_start: string | null;
    subscription_start: string | null;
    cancel_at_period_end: boolean;
    reconciled_at: string | null;
    attempts: number;
    next_attempt: string | null;
    provider_touched: boolean;
    refresh_pending: boolean;
    paying: boolean;
  };
  grants: {
    id: string;
    kind: string;
    plan_id: string | null;
    amount: string;
    spent: string;
    held: string;
    revoked: boolean;
    period_start: string | null;
    expires_at: string | null;
    created_at: string;
  }[];
  plan_changes: {
    id: string;
    state: string;
    error_code: string | null;
    attempts: number;
    current_plan: string | null;
    target_plan: string | null;
    direction: string | null;
    estimated_amount_minor: string | null;
    currency: string | null;
    created_at: string;
    dispatched_at: string | null;
    finished_at: string | null;
  }[];
  checkouts: {
    kind: string;
    product_id: string | null;
    product: string | null;
    created_at: string;
    expires_at: string | null;
  }[];
  credit_units: string;
};

export type AuditPage = {
  items: {
    id: string;
    action: string;
    target_id: string | null;
    operator_email: string | null;
    created_at: string;
  }[];
  next_cursor: string | null;
};

export type WaitlistPage = {
  available: boolean;
  subscribed: number;
  confirmed: number;
  pending: number;
  items: { id: string; email: string; confirmed_at: string | null; subscribed_at: string }[];
  next_cursor: string | null;
};

/* ------------------------------------------------------------------------- errors */

export type ApiErrorKind =
  | "unauthorized"
  | "mfa_required"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "busy"
  | "invalid"
  | "access_expired"
  | "network"
  | "server";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super(kind);
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Retry-After as whole seconds. Accepts delta-seconds or an HTTP date; null when unusable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (value.trim() !== "" && Number.isFinite(seconds))
    return seconds > 0 ? Math.ceil(seconds) : null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const delta = Math.ceil((at - now) / 1000);
  return delta > 0 ? delta : null;
}

export function classify(status: number, code: string | null): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return code === "mfa_required" ? "mfa_required" : "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 503) return "busy";
  if (status === 400 || status === 422) return "invalid";
  return "server";
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  switch (error.kind) {
    case "network":
      return "Could not connect. Check your connection and try again.";
    case "rate_limited":
      return error.retryAfter
        ? `Too many requests. Try again in ${error.retryAfter} seconds.`
        : "Too many requests. Wait a moment before trying again.";
    case "busy":
      return error.retryAfter
        ? `The service is busy. Try again in ${error.retryAfter} seconds.`
        : "The service is busy. Try again shortly.";
    case "unauthorized":
      return "Sign-in or verification failed. Check your details and try again.";
    case "mfa_required":
      return "Two-factor verification is required to continue.";
    case "forbidden":
      return "Access denied. An authorized operator account and two-factor verification are required.";
    case "not_found":
      return "This record is no longer available.";
    case "invalid":
      return "Check the information you entered and try again.";
    case "access_expired":
      return "Your Cloudflare Access session expired — reload the page.";
    default:
      return "The service could not complete this request. Try again.";
  }
}

/* ----------------------------------------------------------------- session events */

/** Cross-cutting outcomes the session store reacts to without every caller handling them. */
export type ApiEvent = "unauthorized" | "mfa_required" | "access_expired" | "ok";
const listeners = new Set<(event: ApiEvent) => void>();
export function onApiEvent(listener: (event: ApiEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(event: ApiEvent): void {
  for (const listener of listeners) listener(event);
}

/* ---------------------------------------------------------------------- transport */

const MAX_CONCURRENT = 2; // The server answers 503 above two simultaneous report reads.
let running = 0;
const waiting: (() => void)[] = [];

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function acquire(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const turn = () => {
      signal?.removeEventListener("abort", onAbort);
      running++;
      resolve();
    };
    const onAbort = () => {
      const index = waiting.indexOf(turn);
      if (index !== -1) waiting.splice(index, 1);
      reject(abortError());
    };
    waiting.push(turn);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function release(): void {
  running--;
  waiting.shift()?.();
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type SendOptions = { body?: object; signal?: AbortSignal; auth?: boolean };

async function send<T>(path: string, options: SendOptions): Promise<T> {
  let response: Response;
  try {
    // "manual" keeps a Cloudflare Access redirect observable instead of an opaque CORS failure.
    response = await fetch(path, {
      method: options.body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) throw abortError();
    throw new ApiError("network", 0);
  }
  const type = response.headers.get("Content-Type") ?? "";
  const json = type.includes("application/json");
  if (response.type === "opaqueredirect" || response.status === 0) return expired(options);
  if (response.status === 204) {
    emit("ok");
    return {} as T;
  }
  if (!json) {
    // Cloudflare Access answers an expired session with a redirect or an HTML page.
    if (response.ok || response.status === 401 || response.status === 403) return expired(options);
    throw new ApiError("server", response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) throw abortError();
    throw new ApiError("server", response.status);
  }
  if (!response.ok) {
    const failure = (body as { error?: { code?: unknown; retry_after?: unknown } } | null)?.error;
    const code = typeof failure?.code === "string" ? failure.code : null;
    const bodyDelay = typeof failure?.retry_after === "number" ? failure.retry_after : null;
    const kind = classify(response.status, code);
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After")) ?? bodyDelay;
    if (!options.auth) {
      if (kind === "unauthorized") emit("unauthorized");
      if (kind === "mfa_required") emit("mfa_required");
    }
    throw new ApiError(kind, response.status, retryAfter);
  }
  emit("ok");
  return body as T;
}

function expired(options: SendOptions): never {
  if (!options.auth) emit("access_expired");
  throw new ApiError("access_expired", 0);
}

/** A GET with bounded concurrency and a short, polite retry cycle for "server busy". */
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await acquire(signal);
    let busy: ApiError | null = null;
    try {
      return await send<T>(path, signal ? { signal } : {});
    } catch (error) {
      if (error instanceof ApiError && error.kind === "busy" && attempt < 2) busy = error;
      else throw error;
    } finally {
      release();
    }
    await sleep(Math.min(busy?.retryAfter ?? 1, 5) * 1000, signal);
  }
}

export function post<T>(path: string, body: object): Promise<T> {
  return send<T>(path, { body, auth: true });
}

/* ------------------------------------------------------------------- endpoints */

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const api = {
  session: (signal?: AbortSignal) => get<{ operator: Operator }>("/api/session", signal),
  overview: (days: number, signal?: AbortSignal) =>
    get<Overview>(`/api/overview?days=${days}`, signal),
  activity: (days: number, signal?: AbortSignal) =>
    get<Activity>(`/api/activity?days=${days}`, signal),
  revenue: (signal?: AbortSignal) => get<Revenue>("/api/revenue", signal),
  jobs: (signal?: AbortSignal) => get<Jobs>("/api/jobs", signal),
  users: (q: string, filter: UserFilter, cursor: string | null, signal?: AbortSignal) =>
    get<UserPage>(`/api/users${query({ q, filter, ...(cursor ? { cursor } : {}) })}`, signal),
  user: (id: string, signal?: AbortSignal) =>
    get<UserDetail>(`/api/users/${encodeURIComponent(id)}`, signal),
  audit: (cursor: string | null, signal?: AbortSignal) =>
    get<AuditPage>(`/api/audit${query(cursor ? { cursor } : {})}`, signal),
  waitlist: (signal?: AbortSignal) => get<WaitlistPage>("/api/waitlists/linux", signal),
  waitlistExport: (cursor: string | null, signal?: AbortSignal) =>
    get<WaitlistPage>(`/api/waitlists/linux/export${query(cursor ? { cursor } : {})}`, signal),
};
