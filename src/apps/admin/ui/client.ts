type Numeric = string | number;
type Operator = {
  id: string;
  email: string;
  name: string | null;
  enrolled: boolean;
  mfaVerified: boolean;
  expiresAt: string;
};
type User = {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  email_verified: boolean;
  lifecycle: string;
  subscription_status: string | null;
  plan: string;
  product_id: string | null;
  paid_until: string | null;
};
type Overview = {
  as_of: string;
  days: number;
  users: { total: Numeric; verified: Numeric; new: Numeric };
  usage: {
    calls: Numeric;
    dispatched: Numeric;
    settled: Numeric;
    failed: Numeric;
    active_users: Numeric;
    charged_units: Numeric;
    provider_cost_usd_micros: Numeric;
    unknown_cost_calls: Numeric;
  };
  billing: {
    active_subscriptions: Numeric;
    open_checkouts: Numeric;
    pending_jobs: Numeric;
  };
  models: {
    model_id: string;
    calls: Numeric;
    charged_units: Numeric;
    provider_cost_usd_micros: Numeric;
    unknown_cost_calls?: Numeric;
  }[];
  errors: { code: string; count: Numeric }[];
  budget: { key: string; spent: Numeric; reserved: Numeric }[];
  credit_units: string;
};
type UserPage = { items: User[]; next_cursor: string | null };
type UserDetail = {
  user: User;
  sessions: {
    id: string;
    device: string | null;
    created_at: string;
    expires_at: string;
  }[];
  balance: {
    remaining_units: Numeric;
    reserved_units: Numeric;
    suspended: boolean;
  };
  usage: {
    calls: Numeric;
    charged_units: Numeric;
    provider_cost_usd_micros: Numeric;
    unknown_cost_calls?: Numeric;
  };
  requests: {
    id: string;
    model_id: string;
    state: string;
    error_code: string | null;
    charged: Numeric | null;
    created_at: string;
  }[];
  credit_units: string;
};

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing interface element");
  return node as T;
}
const authPanel = element("auth-panel");
const workspace = element("workspace");
const signInForm = element<HTMLFormElement>("sign-in-form");
const enrollForm = element<HTMLFormElement>("enroll-form");
const verifyForm = element<HTMLFormElement>("verify-form");
const period = element<HTMLSelectElement>("period");
const queryInput = element<HTMLInputElement>("user-query");
let operator: Operator | null = null;
let authGeneration = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let backupMode = false;
let waitlistRequest: AbortController | undefined;
let waitlistExportRequest: AbortController | undefined;
let overviewRequest: AbortController | undefined;
let usersRequest: AbortController | undefined;
let detailRequest: AbortController | undefined;
let query = "";
let cursor: string | null = null;
let nextCursor: string | null = null;
let pageHistory: (string | null)[] = [];
let selectedUserId: string | null = null;
let overviewReady = false;

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super("Request could not be completed");
  }
}
function notice(message = ""): void {
  element("notice").textContent = message;
  element("notice").hidden = message.length === 0;
}
function errorMessage(error: unknown): string {
  if (!(error instanceof RequestError))
    return "Could not connect. Check your connection and try again.";
  if (error.status === 429) {
    const seconds = Number(error.retryAfter);
    const dateDelay = error.retryAfter
      ? Math.ceil((Date.parse(error.retryAfter) - Date.now()) / 1000)
      : 0;
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : dateDelay;
    return delay > 0 && Number.isFinite(delay)
      ? `Too many attempts. Try again in ${Math.ceil(delay)} seconds.`
      : "Too many attempts. Please wait before trying again.";
  }
  if (error.status === 401)
    return "Sign-in or verification failed. Check your details and try again.";
  if (error.status === 403)
    return "Access denied. An authorized operator account and two-factor verification are required.";
  if (error.status === 404) return "This record is no longer available.";
  if (error.status === 400 || error.status === 422)
    return "Check the information you entered and try again.";
  return "The service could not complete this request. Please try again.";
}
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
async function api<T>(
  path: string,
  options: { body?: object; signal?: AbortSignal; report?: boolean } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    if (options.report && response.status === 401)
      resetAuth("Your session has expired. Sign in again to continue.");
    throw new RequestError(response.status, response.headers.get("Retry-After"));
  }
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}
function clearSetup(): void {
  element<HTMLTextAreaElement>("setup-uri").value = "";
  element<HTMLTextAreaElement>("setup-secret").value = "";
  element<HTMLTextAreaElement>("backup-codes").value = "";
  element("setup-details").hidden = true;
}
function clearDetail(): void {
  detailRequest?.abort();
  selectedUserId = null;
  element("user-detail").hidden = true;
  for (const id of [
    "detail-title",
    "detail-status",
    "detail-facts",
    "detail-metrics",
    "sessions-body",
    "requests-body",
  ])
    element(id).replaceChildren();
}
function resetAuth(message = ""): void {
  authGeneration++;
  operator = null;
  clearTimeout(expiryTimer);
  overviewRequest?.abort();
  usersRequest?.abort();
  waitlistRequest?.abort();
  waitlistExportRequest?.abort();
  element("linux-waitlist").hidden = true;
  element("waitlist-status").textContent = "";
  clearDetail();
  clearSetup();
  signInForm.reset();
  enrollForm.reset();
  verifyForm.reset();
  backupMode = false;
  cursor = null;
  nextCursor = null;
  query = "";
  queryInput.value = "";
  pageHistory = [];
  overviewReady = false;
  for (const id of [
    "metrics",
    "usage-summary",
    "billing-summary",
    "models-body",
    "errors-body",
    "budget-body",
    "users-body",
  ])
    element(id).replaceChildren();
  workspace.hidden = true;
  element("operator-bar").hidden = true;
  element("operator-email").textContent = "";
  showAuth("signin");
  notice(message);
}
function showAuth(mode: "signin" | "enroll" | "verify"): void {
  authPanel.hidden = false;
  workspace.hidden = true;
  signInForm.hidden = mode !== "signin";
  enrollForm.hidden = mode !== "enroll";
  verifyForm.hidden = mode !== "verify";
  element("auth-title").textContent =
    mode === "signin"
      ? "Sign in to your account"
      : mode === "enroll"
        ? "Secure your operator account"
        : "Verify your identity";
  element("auth-description").textContent =
    mode === "signin"
      ? "Restricted to authorized operators. Two-factor authentication is required."
      : mode === "enroll"
        ? "An authenticator is required before viewing operational data."
        : "Enter the code from your authenticator to continue.";
  updateCodeMode();
}
function updateCodeMode(): void {
  const label = element("code-label");
  if (label.firstChild)
    label.firstChild.textContent = backupMode ? "Recovery code" : "Authenticator code";
  element<HTMLInputElement>("code").inputMode = backupMode ? "text" : "numeric";
  element("toggle-backup").textContent = backupMode
    ? "Use an authenticator code"
    : "Use a recovery code";
  element("toggle-backup").hidden = !element("setup-details").hidden;
}
function scheduleExpiry(expiresAt: string): void {
  clearTimeout(expiryTimer);
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining)) return;
  if (remaining <= 0) {
    resetAuth("Your session has expired. Sign in again to continue.");
    return;
  }
  expiryTimer = setTimeout(() => scheduleExpiry(expiresAt), Math.min(remaining, 2_147_483_647));
}
async function loadSession(fallback: "signin" | "verify" = "signin") {
  const generation = authGeneration;
  try {
    const session = await api<{ operator: Operator }>("/api/session");
    if (generation !== authGeneration) return;
    operator = session.operator;
    scheduleExpiry(operator.expiresAt);
    if (!operator) return;
    element("operator-email").textContent = operator.email;
    element("operator-bar").hidden = false;
    if (!operator.enrolled) {
      showAuth("enroll");
      return;
    }
    if (!operator.mfaVerified) {
      showAuth("verify");
      return;
    }
    clearSetup();
    verifyForm.reset();
    authPanel.hidden = true;
    workspace.hidden = false;
    notice();
    await Promise.all([loadOverview(), loadUsers(), loadWaitlist()]);
  } catch (error) {
    if (generation !== authGeneration) return;
    if (error instanceof RequestError && error.status === 401) {
      showAuth(fallback);
      return;
    }
    notice(errorMessage(error));
  }
}
async function submitAuth(form: HTMLFormElement, operation: () => Promise<void>): Promise<void> {
  const generation = authGeneration;
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  form.setAttribute("aria-busy", "true");
  notice();
  try {
    await operation();
  } catch (error) {
    if (generation === authGeneration) notice(errorMessage(error));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    form.removeAttribute("aria-busy");
  }
}
signInForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuth(signInForm, async () => {
    const generation = authGeneration;
    try {
      const result = await api<{ twoFactorRedirect?: boolean; success?: boolean }>(
        "/auth/sign-in/email",
        {
          body: {
            email: element<HTMLInputElement>("email").value.trim(),
            password: element<HTMLInputElement>("password").value,
          },
        },
      );
      if (generation === authGeneration)
        await loadSession(result.twoFactorRedirect ? "verify" : "signin");
    } finally {
      element<HTMLInputElement>("password").value = "";
    }
  });
});
enrollForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuth(enrollForm, async () => {
    const generation = authGeneration;
    try {
      const result = await api<{ totpURI: string; backupCodes: string[] }>(
        "/auth/two-factor/enable",
        { body: { password: element<HTMLInputElement>("enroll-password").value } },
      );
      if (generation !== authGeneration) return;
      await loadSession("verify");
      if (generation !== authGeneration || !operator) return;
      const uri = new URL(result.totpURI);
      if (uri.protocol !== "otpauth:") throw new Error("Invalid authenticator setup");
      element<HTMLTextAreaElement>("setup-uri").value = result.totpURI;
      element<HTMLTextAreaElement>("setup-secret").value = uri.searchParams.get("secret") ?? "";
      element<HTMLTextAreaElement>("backup-codes").value = result.backupCodes.join("\n");
      element("setup-details").hidden = false;
      backupMode = false;
      showAuth("verify");
      element<HTMLInputElement>("code").focus();
    } finally {
      element<HTMLInputElement>("enroll-password").value = "";
    }
  });
});
verifyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuth(verifyForm, async () => {
    const generation = authGeneration;
    try {
      const code = element<HTMLInputElement>("code").value.trim();
      await api(
        backupMode ? "/auth/two-factor/verify-backup-code" : "/auth/two-factor/verify-totp",
        { body: { code } },
      );
      if (generation === authGeneration) await loadSession("signin");
    } finally {
      element<HTMLInputElement>("code").value = "";
    }
  });
});
element("toggle-backup").addEventListener("click", () => {
  backupMode = !backupMode;
  element<HTMLInputElement>("code").value = "";
  updateCodeMode();
  element<HTMLInputElement>("code").focus();
});
function signOut(): void {
  const button = element<HTMLButtonElement>("sign-out");
  button.disabled = true;
  void (async () => {
    try {
      await api("/auth/sign-out", { body: {} });
      resetAuth();
      await loadSession();
    } catch (error) {
      resetAuth(`Sign-out could not be confirmed. ${errorMessage(error)}`);
    } finally {
      button.disabled = false;
    }
  })();
}
element("sign-out").addEventListener("click", signOut);
element("auth-start-over").addEventListener("click", signOut);
window.addEventListener("pagehide", () => {
  resetAuth();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void loadSession();
});

function integer(value: Numeric): bigint | null {
  try {
    const text = String(value);
    return /^-?\d+$/.test(text) ? BigInt(text) : null;
  } catch {
    return null;
  }
}
function count(value: Numeric): string {
  return integer(value)?.toLocaleString("en-US") ?? "—";
}
function scaled(value: Numeric, divisor: Numeric, minimum = 0): string {
  const amount = integer(value);
  const scale = integer(divisor);
  if (amount === null || scale === null || scale <= 0n) return "—";
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / scale;
  const remainder = absolute % scale;
  const precision = String(scale).length - 1;
  if (scale !== 10n ** BigInt(precision)) return "—";
  const fraction = remainder
    .toString()
    .padStart(precision, "0")
    .replace(/0+$/, "")
    .padEnd(minimum, "0");
  return `${negative ? "−" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
function usd(value: Numeric): string {
  const formatted = scaled(value, "1000000", 2);
  return formatted === "—" ? formatted : `$${formatted}`;
}
function credits(value: Numeric, scale: string): string {
  return scaled(value, scale);
}
function date(value: string | null): string {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "—"
    : time.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function metric(label: string, value: string, note: string): HTMLElement {
  const result = node("div", undefined, "metric");
  result.append(
    node("p", label, "metric-label"),
    node("p", value, "metric-value"),
    node("p", note, "metric-note"),
  );
  return result;
}
function facts(target: string, pairs: [string, string, string?][]): void {
  element(target).replaceChildren(
    ...pairs.map(([label, value, secondary]) => {
      const row = node("div");
      const description = node("dd", value);
      if (secondary) description.append(node("span", secondary, "cell-secondary"));
      row.append(node("dt", label), description);
      return row;
    }),
  );
}
function cell(text: string, numeric = false): HTMLTableCellElement {
  return node("td", text, numeric ? "numeric" : undefined);
}
function stackedCell(main: string, secondary: string): HTMLTableCellElement {
  const result = cell("");
  result.append(node("span", main, "cell-main"), node("span", secondary, "cell-secondary"));
  return result;
}
function table(
  target: string,
  rows: HTMLTableCellElement[][],
  columns: number,
  empty: string,
): void {
  const contents = rows.map((cells) => {
    const row = node("tr");
    row.append(...cells);
    return row;
  });
  if (contents.length === 0) {
    const row = node("tr");
    const message = node("td", empty, "empty");
    message.colSpan = columns;
    row.append(message);
    contents.push(row);
  }
  element(target).replaceChildren(...contents);
}
function planName(plan: string): string {
  switch (plan) {
    case "free":
      return "Free";
    case "pro":
      return "Pro";
    case "max":
      return "Max";
    default:
      return "Unknown plan";
  }
}
function authorized(): boolean {
  return Boolean(operator?.enrolled && operator.mfaVerified);
}
function handleReportError(error: unknown): void {
  if (isAbort(error)) return;
  if (error instanceof RequestError && error.status === 401) return;
  notice(errorMessage(error));
  if (error instanceof RequestError && error.status === 403) {
    resetAuth(errorMessage(error));
  }
}
async function loadOverview(): Promise<void> {
  if (!authorized()) return;
  overviewRequest?.abort();
  const request = new AbortController();
  overviewRequest = request;
  element("metrics").setAttribute("aria-busy", "true");
  try {
    const data = await api<Overview>(`/api/overview?days=${period.value}`, {
      signal: request.signal,
      report: true,
    });
    if (request.signal.aborted || !authorized()) return;
    overviewReady = true;
    element("as-of").textContent =
      `Database snapshot · ${date(data.as_of)} · Last ${data.days === 1 ? "24 hours" : `${data.days} days`}`;
    const unknown = integer(data.usage.unknown_cost_calls) ?? 0n;
    element("metrics").replaceChildren(
      metric("Total users", count(data.users.total), `${count(data.users.new)} new in this period`),
      metric(
        "AI requests",
        count(data.usage.calls),
        `${count(data.usage.active_users)} active users`,
      ),
      metric(
        "Charged credits",
        credits(data.usage.charged_units, data.credit_units),
        "Settled account charges",
      ),
      metric(
        "Known provider cost",
        usd(data.usage.provider_cost_usd_micros),
        unknown > 0n
          ? `${count(data.usage.unknown_cost_calls)} calls have unconfirmed cost`
          : "Recorded cost · not an invoice",
      ),
    );
    facts("usage-summary", [
      ["Dispatched", count(data.usage.dispatched)],
      ["Settled", count(data.usage.settled)],
      ["Failed", count(data.usage.failed)],
      ["Verified users · all time", count(data.users.verified)],
    ]);
    facts("billing-summary", [
      ["Active subscriptions · local status", count(data.billing.active_subscriptions)],
      ["Unexpired checkout records", count(data.billing.open_checkouts)],
      ["Pending jobs", count(data.billing.pending_jobs)],
      ["Billing source", "Stored account state"],
    ]);
    table(
      "models-body",
      data.models.map((model) => [
        cell(model.model_id),
        cell(count(model.calls), true),
        cell(credits(model.charged_units, data.credit_units), true),
        cell(usd(model.provider_cost_usd_micros), true),
      ]),
      4,
      "No model usage in this period.",
    );
    table(
      "errors-body",
      data.errors.map((error) => [cell(error.code), cell(count(error.count), true)]),
      2,
      "No recorded request errors in this period.",
    );
    table(
      "budget-body",
      data.budget.map((budget) => [
        cell(budget.key),
        cell(usd(budget.spent), true),
        cell(usd(budget.reserved), true),
      ]),
      3,
      "No current budget counters.",
    );
  } catch (error) {
    if (!overviewReady && !isAbort(error))
      element("as-of").textContent = "Snapshot unavailable. Use Refresh to retry.";
    handleReportError(error);
  } finally {
    if (overviewRequest === request) element("metrics").removeAttribute("aria-busy");
  }
}
function updatePagination(): void {
  element<HTMLButtonElement>("previous-page").disabled = pageHistory.length === 0;
  element<HTMLButtonElement>("next-page").disabled = !nextCursor;
  element("page-label").textContent = `Page ${pageHistory.length + 1}`;
}
async function loadUsers(): Promise<void> {
  if (!authorized()) return;
  usersRequest?.abort();
  const request = new AbortController();
  usersRequest = request;
  element("users-status").textContent = "Loading users…";
  element("users-body").replaceChildren();
  nextCursor = null;
  element("users-body").setAttribute("aria-busy", "true");
  element<HTMLButtonElement>("previous-page").disabled = true;
  element<HTMLButtonElement>("next-page").disabled = true;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  try {
    const data = await api<UserPage>(`/api/users?${params.toString()}`, {
      signal: request.signal,
      report: true,
    });
    if (request.signal.aborted || !authorized()) return;
    nextCursor = data.next_cursor;
    table(
      "users-body",
      data.items.map((user) => {
        const buttonCell = cell("");
        const button = node("button", "View", "quiet");
        button.type = "button";
        button.setAttribute("aria-label", `View details for ${user.email}`);
        button.addEventListener("click", () => void loadDetail(user.id, true));
        buttonCell.append(button);
        return [
          stackedCell(user.email, user.name ?? user.id),
          stackedCell(user.lifecycle, user.email_verified ? "Email verified" : "Email unverified"),
          stackedCell(planName(user.plan), user.subscription_status ?? "No subscription"),
          cell(date(user.created_at)),
          buttonCell,
        ];
      }),
      5,
      query ? "No user matches that exact email address or ID." : "No users found.",
    );
    element("users-status").textContent =
      `${data.items.length} ${data.items.length === 1 ? "user" : "users"} on this page${query ? " · exact match" : ""}`;
    updatePagination();
  } catch (error) {
    if (!isAbort(error) && authorized())
      element("users-status").textContent = "Users unavailable. Use Search or Refresh to retry.";
    handleReportError(error);
  } finally {
    if (usersRequest === request) element("users-body").removeAttribute("aria-busy");
  }
}
async function loadDetail(id: string, focus = false): Promise<void> {
  if (!authorized()) return;
  clearDetail();
  selectedUserId = id;
  const request = new AbortController();
  detailRequest = request;
  const panel = element("user-detail");
  panel.hidden = false;
  panel.setAttribute("aria-busy", "true");
  element("detail-title").textContent = "Loading user…";
  element("detail-status").textContent = "Loading account details…";
  if (focus) panel.focus();
  try {
    const data = await api<UserDetail>(`/api/users/${encodeURIComponent(id)}`, {
      signal: request.signal,
      report: true,
    });
    if (request.signal.aborted || !authorized() || selectedUserId !== id) return;
    element("detail-title").textContent = data.user.email;
    element("detail-status").textContent =
      "Usage covers the last 30 days. Subscription status reflects stored billing state.";
    facts("detail-facts", [
      ["User ID", data.user.id],
      ["Name", data.user.name ?? "—"],
      [
        "Account",
        `${data.user.lifecycle} · ${data.user.email_verified ? "verified" : "unverified"}`,
      ],
      ["Plan", planName(data.user.plan), data.user.subscription_status ?? "No subscription"],
      ["Paid until", date(data.user.paid_until)],
      ["Created", date(data.user.created_at)],
      ["Credit account", data.balance.suspended ? "Suspended" : "Active"],
    ]);
    const unknown = integer(data.usage.unknown_cost_calls ?? "0") ?? 0n;
    element("detail-metrics").replaceChildren(
      metric(
        "Remaining credits",
        credits(data.balance.remaining_units, data.credit_units),
        `${credits(data.balance.reserved_units, data.credit_units)} reserved`,
      ),
      metric(
        "Requests · last 30 days",
        count(data.usage.calls),
        `${credits(data.usage.charged_units, data.credit_units)} credits charged`,
      ),
      metric(
        "Known provider cost · 30 days",
        usd(data.usage.provider_cost_usd_micros),
        unknown > 0n
          ? `${count(data.usage.unknown_cost_calls ?? "0")} calls have unconfirmed cost`
          : "Recorded cost · not an invoice",
      ),
    );
    table(
      "sessions-body",
      data.sessions.map((session) => [
        cell(session.device ?? "Unknown device"),
        cell(session.id),
        cell(date(session.created_at)),
        cell(date(session.expires_at)),
      ]),
      4,
      "No active sessions.",
    );
    table(
      "requests-body",
      data.requests.map((request) => [
        stackedCell(request.model_id, request.id),
        cell(request.state),
        cell(request.error_code ?? "—"),
        cell(request.charged === null ? "—" : credits(request.charged, data.credit_units), true),
        cell(date(request.created_at)),
      ]),
      5,
      "No recent requests.",
    );
  } catch (error) {
    if (!isAbort(error) && authorized()) {
      element("detail-title").textContent = "User details unavailable";
      element("detail-status").textContent = errorMessage(error);
    }
    handleReportError(error);
  } finally {
    if (detailRequest === request) panel.removeAttribute("aria-busy");
  }
}
element<HTMLFormElement>("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  query = queryInput.value.trim();
  cursor = null;
  nextCursor = null;
  pageHistory = [];
  clearDetail();
  notice();
  void loadUsers();
});
element("clear-search").addEventListener("click", () => {
  queryInput.value = "";
  query = "";
  cursor = null;
  nextCursor = null;
  pageHistory = [];
  clearDetail();
  notice();
  void loadUsers();
});
element("previous-page").addEventListener("click", () => {
  if (!pageHistory.length) return;
  cursor = pageHistory.pop() ?? null;
  clearDetail();
  void loadUsers();
});
element("next-page").addEventListener("click", () => {
  if (!nextCursor) return;
  pageHistory.push(cursor);
  cursor = nextCursor;
  clearDetail();
  void loadUsers();
});
element("close-detail").addEventListener("click", clearDetail);
period.addEventListener("change", () => {
  notice();
  void loadOverview();
});
element("refresh").addEventListener("click", () => {
  notice();
  void loadOverview();
  void loadUsers();
  void loadWaitlist();
  if (selectedUserId) void loadDetail(selectedUserId);
});
type WaitlistPage = {
  available: boolean;
  subscribed: number;
  confirmed: number;
  pending: number;
  items: { email: string; subscribed_at: string; confirmed_at: string | null }[];
  next_cursor: string | null;
};
async function loadWaitlist(): Promise<void> {
  waitlistRequest?.abort();
  const request = new AbortController();
  waitlistRequest = request;
  const generation = authGeneration;
  try {
    const data = await api<WaitlistPage>("/api/waitlists/linux", {
      signal: request.signal,
      report: true,
    });
    if (generation !== authGeneration || request.signal.aborted) return;
    element("linux-waitlist").hidden = !data.available;
    element("waitlist-status").textContent =
      `${data.subscribed.toLocaleString()} subscribed · ${data.pending.toLocaleString()} legacy unconfirmed (excluded)`;
  } catch (error) {
    if (!isAbort(error) && generation === authGeneration) notice(errorMessage(error));
  }
}
element("waitlist-export").addEventListener("click", async () => {
  if (!operator?.mfaVerified || waitlistExportRequest) return;
  const request = new AbortController();
  waitlistExportRequest = request;
  const generation = authGeneration;
  const button = element<HTMLButtonElement>("waitlist-export");
  button.disabled = true;
  const csvField = (value: string) =>
    `"${/^[=+@\-\t\r]/.test(value) ? "'" : ""}${value.replaceAll('"', '""')}"`;
  const lines = ["email,subscribed_at"];
  let next: string | null = null;
  try {
    do {
      const data: WaitlistPage = await api<WaitlistPage>(
        `/api/waitlists/linux${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
        { signal: request.signal, report: true },
      );
      if (generation !== authGeneration || request.signal.aborted || !data.available) return;
      for (const item of data.items)
        lines.push([item.email, item.subscribed_at].map(csvField).join(","));
      // Keep the browser bounded. Larger lists remain available through the paginated API.
      if (lines.length > 100001) throw new Error("export_too_large");
      next = data.next_cursor;
    } while (next);
    if (generation !== authGeneration || request.signal.aborted) return;
    const url = URL.createObjectURL(
      new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "zephium-linux-waitlist.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (!isAbort(error) && generation === authGeneration)
      notice(
        error instanceof Error && error.message === "export_too_large"
          ? "Use the paginated admin API for exports above 100,000 addresses."
          : errorMessage(error),
      );
  } finally {
    lines.length = 0;
    waitlistExportRequest = undefined;
    button.disabled = false;
  }
});
void loadSession();
