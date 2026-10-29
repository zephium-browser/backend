import { Hono } from "hono";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { readIncomingBody } from "../../platform/incoming-body";
import { createWaitlistService } from "./service";

export const waitlistPath = "/v1/waitlists/linux";
export function createWaitlistRoutes(
  config: Config,
  db: Database,
  clientIp: (r: Request) => string,
) {
  const app = new Hono();
  const service = createWaitlistService(config, db);
  let active = 0;
  app.use(`${waitlistPath}*`, async (c, next) => {
    if (config.WAITLIST_ENABLED !== "true") throw new AppError("not_found", 404);
    if (c.req.method !== "POST") throw new AppError("not_found", 404);
    if (c.req.header("origin") !== config.WAITLIST_WEB_ORIGIN)
      throw new AppError("origin_denied", 403);
    if (c.req.header("authorization") || c.req.header("cookie"))
      throw new AppError("invalid_request", 400);
    if (active >= 2) throw new AppError("server_busy", 503, 1);
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });
  for (const action of ["join", "confirm", "unsubscribe"] as const) {
    app.post(action === "join" ? waitlistPath : `${waitlistPath}/${action}`, async (c) => {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
        throw new AppError("unsupported_media_type", 415);
      const bytes = await readIncomingBody(c.req.raw, 2048, 5000);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
      } catch {
        throw new AppError("invalid_request");
      }
      await service[action](body, clientIp(c.req.raw));
      return c.json(
        action === "join"
          ? { accepted: true }
          : action === "confirm"
            ? { confirmed: true }
            : { unsubscribed: true },
        action === "join" ? 202 : 200,
      );
    });
  }
  return app;
}
