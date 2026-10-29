import type { Hono } from "hono";
import type { IdentityEnvironment } from "../../modules/identity";
import { waitlistPath } from "../../modules/waitlist";
import type { Config } from "../../platform/config";
import { AppError, errorResponse } from "../../platform/errors";

export function isWaitlistPath(path: string): boolean {
  return path === waitlistPath || path.startsWith(`${waitlistPath}/`);
}
/** Outermost middleware: decorate the final response, including admission and error responses. */
export function installWaitlistCors(app: Hono<IdentityEnvironment>, config: Config) {
  app.use("*", async (c, next) => {
    if (!isWaitlistPath(c.req.path)) return next();
    const allowed = c.req.header("origin") === config.WAITLIST_WEB_ORIGIN;
    if (!allowed && (c.req.header("origin") || c.req.method === "OPTIONS")) {
      c.res = errorResponse(new AppError("origin_denied", 403));
    } else if (c.req.method === "OPTIONS") {
      const method = c.req.header("access-control-request-method");
      const headers = (c.req.header("access-control-request-headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      if (method !== "POST" || headers.some((h) => h !== "content-type")) {
        c.res = errorResponse(new AppError("invalid_preflight", 403));
      } else {
        c.res = new Response(null, { status: 204 });
        c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
        c.header("Access-Control-Allow-Headers", "Content-Type");
        c.header("Access-Control-Max-Age", "600");
      }
    } else {
      await next();
    }
    // Error handlers may replace c.res, so headers must be applied after next().
    c.header("Cache-Control", "no-store");
    const vary =
      c.res.headers
        .get("Vary")
        ?.split(",")
        .map((v) => v.trim())
        .filter(Boolean) ?? [];
    if (!vary.some((v) => v === "*" || v.toLowerCase() === "origin")) vary.push("Origin");
    c.header("Vary", vary.join(", "));
    c.header("Access-Control-Allow-Credentials", undefined);
    if (allowed) {
      c.header("Access-Control-Allow-Origin", config.WAITLIST_WEB_ORIGIN);
      c.header("Access-Control-Expose-Headers", "Retry-After");
    } else {
      c.header("Access-Control-Allow-Origin", undefined);
    }
    if (c.res.status === 503 && !c.res.headers.has("Retry-After")) c.header("Retry-After", "1");
    return c.res;
  });
}
