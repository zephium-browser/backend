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
    c.res = decorateWaitlistResponse(c.req.raw, c.res, config.WAITLIST_WEB_ORIGIN);
    return c.res;
  });
}

/** Also used by the HTTP server for errors returned before Hono receives a request. */
export function decorateWaitlistResponse(
  request: Request,
  response: Response,
  origin?: string,
): Response {
  if (!origin || !isWaitlistPath(new URL(request.url).pathname)) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  const vary =
    headers
      .get("Vary")
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean) ?? [];
  if (!vary.some((v) => v === "*" || v.toLowerCase() === "origin")) vary.push("Origin");
  headers.set("Vary", vary.join(", "));
  headers.delete("Access-Control-Allow-Credentials");
  if (request.headers.get("origin") === origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After");
  } else {
    headers.delete("Access-Control-Allow-Origin");
    headers.delete("Access-Control-Expose-Headers");
  }
  if (response.status === 503 && !headers.has("Retry-After")) headers.set("Retry-After", "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
