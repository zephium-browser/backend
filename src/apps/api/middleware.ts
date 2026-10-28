import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { audioRoute } from "../../modules/ai";
import { avatarPath, type IdentityEnvironment } from "../../modules/identity";
import { waitlistPath } from "../../modules/waitlist";
import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError, errorResponse } from "../../platform/errors";
import { markIncomingStart } from "../../platform/incoming-body";
import { canonicalIp } from "../../platform/ip-bucket";
export function installHttpMiddleware(
  app: Hono<IdentityEnvironment>,
  config: Config,
  db: Database,
  clientIp: (request: Request) => string,
) {
  const origins = new Set(config.TRUSTED_ORIGINS.split(","));
  let activeHTTP = 0;
  app.use("*", async (_c, next) => {
    if (_c.req.path === audioRoute || _c.req.path === avatarPath) markIncomingStart(_c.req.raw);
    if (activeHTTP >= 32) return errorResponse(new AppError("server_busy", 503));
    activeHTTP++;
    try {
      await next();
    } finally {
      activeHTTP--;
    }
  });
  app.use("*", secureHeaders());
  const limitBody = bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: () => errorResponse(new AppError("body_too_large", 413)),
  });
  // Media routes own timed bounded reads, including requests without Content-Length.
  app.use("*", (c, next) =>
    c.req.path.startsWith(waitlistPath) ||
    c.req.path === audioRoute ||
    (c.req.path === avatarPath && c.req.method === "PUT")
      ? next()
      : limitBody(c, next),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    const allowedOrigins = c.req.path.startsWith(waitlistPath)
      ? new Set([config.WAITLIST_WEB_ORIGIN])
      : origins;
    if (origin && !allowedOrigins.has(origin)) throw new AppError("origin_denied", 403);
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      if (!c.req.path.startsWith(waitlistPath))
        c.header("Access-Control-Allow-Credentials", "true");
      c.header(
        "Access-Control-Expose-Headers",
        "set-auth-token, X-Zephium-Request-Id, X-Zephium-Policy-Revision, X-Zephium-Usage, Retry-After",
      );
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE");
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Idempotency-Key, X-Zephium-Device, X-Zephium-Client-Version",
      );
      return c.body(null, 204);
    }
    if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("cookie") && !origin)
      throw new AppError("origin_required", 403);
    if (c.req.path.startsWith("/api/auth/"))
      await enforce(
        db,
        privateKey(config.ABUSE_SECRET, "auth-ip", canonicalIp(clientIp(c.req.raw))),
        60,
        120,
      );
    await next();
  });
}
