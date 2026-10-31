import type { ComponentChildren } from "preact";
import { type ApiError, errorMessage } from "../api";
import type { Resource } from "../hooks";

export function Skeleton({ lines = 3, tall }: { lines?: number; tall?: boolean }) {
  return (
    <div class={`skeleton${tall ? " skeleton-tall" : ""}`} role="status">
      <span class="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, index) => (
        <span class="skeleton-line" key={index} aria-hidden="true" />
      ))}
    </div>
  );
}

export function KpiSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div class="kpi-row" role="status">
      <span class="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, index) => (
        <div class="kpi" key={index} aria-hidden="true">
          <span class="skeleton-line skeleton-short" />
          <span class="skeleton-line skeleton-value" />
          <span class="skeleton-line skeleton-short" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children ? <p class="empty-body">{children}</p> : null}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = "This data could not be loaded",
}: {
  error: ApiError | null;
  onRetry: () => void;
  title?: string;
}) {
  const expired = error?.kind === "access_expired";
  return (
    <div class="error-state" role="alert">
      <p class="error-title">{title}</p>
      <p class="error-body">{error ? errorMessage(error) : "Try again."}</p>
      {expired ? (
        <button type="button" class="btn" onClick={() => location.reload()}>
          Reload page
        </button>
      ) : (
        <button type="button" class="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Renders the right state for a resource so a failing panel never takes the page down. */
export function Async<T>({
  res,
  skeleton = <Skeleton />,
  title,
  children,
}: {
  res: Resource<T>;
  skeleton?: ComponentChildren;
  title?: string;
  children: (data: T) => ComponentChildren;
}) {
  if (res.status === "loading") return <>{skeleton}</>;
  if (res.status === "error" || res.data === null)
    return <ErrorState error={res.error} onRetry={res.reload} {...(title ? { title } : {})} />;
  return <div aria-busy={res.refreshing}>{children(res.data)}</div>;
}
