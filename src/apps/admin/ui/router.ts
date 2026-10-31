import { useEffect, useState } from "preact/hooks";

export type UserFilter = "" | "paying" | "deleting" | "unverified";
export type OverviewDays = 1 | 7 | 30;
export type ActivityDays = 30 | 90;

export type Route =
  | { name: "overview"; days: OverviewDays }
  | { name: "revenue" }
  | { name: "activity"; days: ActivityDays }
  | { name: "users"; q: string; filter: UserFilter }
  | { name: "user"; id: string }
  | { name: "jobs" }
  | { name: "waitlist" }
  | { name: "audit" }
  | { name: "not_found" };

export const USER_FILTERS: readonly UserFilter[] = ["", "paying", "deleting", "unverified"];
const MAX_QUERY = 320;
const MAX_ID = 128;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Parse `location.hash`. Anything unrecognised becomes `not_found`; the empty hash is the overview. */
export function parseHash(hash: string): Route {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  const split = text.indexOf("?");
  const path = split === -1 ? text : text.slice(0, split);
  const params = new URLSearchParams(split === -1 ? "" : text.slice(split + 1));
  const segments = path.split("/").filter(Boolean);
  const [head, rest, ...extra] = segments;
  if (extra.length > 0) return { name: "not_found" };
  if (head === undefined) return { name: "overview", days: 7 };
  if (rest !== undefined && head !== "users") return { name: "not_found" };
  switch (head) {
    case "overview": {
      const days = params.get("days");
      return { name: "overview", days: days === "1" ? 1 : days === "30" ? 30 : 7 };
    }
    case "activity":
      return { name: "activity", days: params.get("days") === "90" ? 90 : 30 };
    case "users": {
      if (rest !== undefined) {
        const id = decode(rest);
        return id && id.length <= MAX_ID ? { name: "user", id } : { name: "not_found" };
      }
      const filter = params.get("filter") ?? "";
      return {
        name: "users",
        q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY),
        filter: (USER_FILTERS as readonly string[]).includes(filter) ? (filter as UserFilter) : "",
      };
    }
    case "revenue":
    case "jobs":
    case "waitlist":
    case "audit":
      return { name: head };
    default:
      return { name: "not_found" };
  }
}

/** Canonical hash for a route. Defaults are omitted so the URLs stay short. */
export function toHash(route: Route): string {
  switch (route.name) {
    case "overview":
      return route.days === 7 ? "#/overview" : `#/overview?days=${route.days}`;
    case "activity":
      return route.days === 30 ? "#/activity" : `#/activity?days=${route.days}`;
    case "users": {
      const params = new URLSearchParams();
      if (route.q) params.set("q", route.q);
      if (route.filter) params.set("filter", route.filter);
      const query = params.toString();
      return query ? `#/users?${query}` : "#/users";
    }
    case "user":
      return `#/users/${encodeURIComponent(route.id)}`;
    case "not_found":
      return "#/overview";
    default:
      return `#/${route.name}`;
  }
}

export function routeKey(route: Route): string {
  return JSON.stringify(route);
}

export function navigate(route: Route): void {
  const hash = toHash(route);
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", update);
    update();
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

const TITLES: Record<Route["name"], string> = {
  overview: "Overview",
  revenue: "Revenue",
  activity: "Activity",
  users: "Users",
  user: "User",
  jobs: "Background jobs",
  waitlist: "Linux waitlist",
  audit: "Audit log",
  not_found: "Not found",
};
export function routeTitle(route: Route): string {
  return TITLES[route.name];
}
