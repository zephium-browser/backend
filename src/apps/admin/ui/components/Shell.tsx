import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Operator } from "../api";
import { type Route, routeKey, routeTitle, toHash } from "../router";
import { BrandMark, Wordmark } from "./Brand";
import { Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

type NavItem = { label: string; icon: IconName; route: Route; match: Route["name"][] };
const NAV: NavItem[] = [
  {
    label: "Overview",
    icon: "overview",
    route: { name: "overview", days: 7 },
    match: ["overview"],
  },
  { label: "Revenue", icon: "revenue", route: { name: "revenue" }, match: ["revenue"] },
  {
    label: "Activity",
    icon: "activity",
    route: { name: "activity", days: 30 },
    match: ["activity"],
  },
  {
    label: "Users",
    icon: "users",
    route: { name: "users", q: "", filter: "" },
    match: ["users", "user"],
  },
  { label: "Jobs", icon: "jobs", route: { name: "jobs" }, match: ["jobs"] },
  { label: "Waitlist", icon: "waitlist", route: { name: "waitlist" }, match: ["waitlist"] },
  { label: "Audit log", icon: "audit", route: { name: "audit" }, match: ["audit"] },
];

export function Shell({
  operator,
  route,
  accessExpired,
  onSignOut,
  children,
}: {
  operator: Operator;
  route: Route;
  accessExpired: boolean;
  onSignOut: () => void;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const key = routeKey(route);

  useEffect(() => {
    document.title = `${routeTitle(route)} · Zephium Admin`;
    setOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    // Move focus to the new view so keyboard and screen-reader users land on its content.
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [key]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return (
    <div class="app">
      {/* A button, not a "#main" link: the URL hash belongs to the router. */}
      <button type="button" class="skip-link" onClick={() => main.current?.focus()}>
        Skip to content
      </button>
      <div class="sidebar">
        <header class="sidebar-top">
          <a class="brand" href="#/overview" aria-label="Zephium Admin, overview">
            <span class="brand-mark">
              <BrandMark />
            </span>
            <Wordmark />
            <span class="brand-tag">Admin</span>
          </a>
          <button
            type="button"
            class="btn btn-icon menu-button"
            aria-expanded={open}
            aria-controls="sidebar-panel"
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "close" : "menu"} />
            <span class="sr-only">{open ? "Close menu" : "Open menu"}</span>
          </button>
        </header>
        <div id="sidebar-panel" class={`sidebar-panel${open ? " open" : ""}`}>
          <nav class="nav" aria-label="Primary">
            <ul>
              {NAV.map((item) => {
                const current = item.match.includes(route.name);
                return (
                  <li key={item.label}>
                    <a
                      href={toHash(item.route)}
                      class="nav-link"
                      aria-current={current ? "page" : undefined}
                    >
                      <Icon name={item.icon} />
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <section class="operator" aria-label="Operator">
            <p class="operator-email" title={operator.email}>
              {operator.email}
            </p>
            <p class="operator-meta">
              <span class="badge badge-neutral">
                <Icon name="lock" size={12} />
                Read-only
              </span>
            </p>
            <ThemeToggle />
            <button
              type="button"
              class="btn btn-block"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                onSignOut();
              }}
            >
              <Icon name="signout" />
              Sign out
            </button>
          </section>
        </div>
      </div>
      <main id="main" class="main" tabIndex={-1} ref={main}>
        {accessExpired ? (
          <div class="banner banner-warn" role="alert">
            <span>Your Cloudflare Access session expired — reload the page.</span>
            <button type="button" class="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        ) : null}
        <div class="content">{children}</div>
      </main>
    </div>
  );
}
