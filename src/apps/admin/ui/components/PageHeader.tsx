import type { ComponentChildren } from "preact";
import { nowUtc, utc } from "../format";
import { Icon } from "./Icon";

/** Page title, "as of" stamp (UTC) and the manual refresh every data view offers. */
export function PageHeader({
  title,
  subtitle,
  asOf,
  loadedAt,
  refreshing,
  onRefresh,
  children,
}: {
  title: string;
  subtitle?: ComponentChildren;
  /** Server snapshot time, when the endpoint reports one. */
  asOf?: string | null;
  loadedAt?: Date | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  children?: ComponentChildren;
}) {
  const stamp = asOf
    ? `As of ${utc(asOf, { seconds: true, label: true })}`
    : loadedAt
      ? `Loaded ${nowUtc(loadedAt)}`
      : null;
  return (
    <header class="page-head">
      <div class="page-head-main">
        <h1 class="page-title">{title}</h1>
        {subtitle ? <p class="page-sub">{subtitle}</p> : null}
      </div>
      <div class="page-head-tools">
        {children}
        {stamp !== null || onRefresh ? (
          <div class="refresh">
            <span class="muted" role="status" aria-live="polite">
              {refreshing ? "Refreshing…" : (stamp ?? "")}
            </span>
            {onRefresh ? (
              <button type="button" class="btn" onClick={onRefresh} disabled={refreshing}>
                <Icon name="refresh" />
                Refresh
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** Switcher between a handful of URL-backed options; real links, so back/forward just work. */
export function Segmented({
  label,
  options,
}: {
  label: string;
  options: { text: string; href: string; current: boolean }[];
}) {
  return (
    <nav class="segmented" aria-label={label}>
      {options.map((option) => (
        <a
          key={option.href}
          href={option.href}
          class="segment"
          aria-current={option.current ? "true" : undefined}
        >
          {option.text}
        </a>
      ))}
    </nav>
  );
}
