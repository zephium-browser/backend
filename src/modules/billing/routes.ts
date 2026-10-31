import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import type { IdentityEnvironment } from "../identity";
import type { BillingService } from "./desktop";
import { verifyBillingEvent } from "./provider";
import { acceptEvent } from "./service";

const checkoutSelection = z.union([
  z.object({ interval: z.enum(["monthly", "yearly"]), plan: z.string().optional() }).strict(),
  z.object({ topup: z.string().max(40) }).strict(),
]);

/** Public signature-verified ingress; mount before the account-authentication boundary. */
export function createBillingWebhookRoutes(
  config: Pick<Config, "POLAR_WEBHOOK_SECRET" | "POLAR_WEBHOOK_FORMAT">,
  db: Database,
) {
  const router = new Hono();
  router.post("/webhooks/polar", async (c) => {
    if (!config.POLAR_WEBHOOK_SECRET) throw new AppError("webhook_unavailable", 503);
    const body = await c.req.text();
    if (Buffer.byteLength(body) > 1024 * 1024) throw new AppError("body_too_large", 413);
    const event = verifyBillingEvent(
      body,
      c.req.raw.headers,
      config.POLAR_WEBHOOK_SECRET,
      config.POLAR_WEBHOOK_FORMAT,
    );
    await acceptEvent(db, event.id, body, event.accountId, event.orderId, event.customerId);
    return c.body(null, 202);
  });
  return router;
}

/** Account authentication supplies IdentityEnvironment before these routes are mounted. */
export function createBillingRoutes(
  config: Pick<Config, "BILLING_ENABLED">,
  service: BillingService,
) {
  const router = new Hono<IdentityEnvironment>();
  router.get("/v1/billing", async (c) => c.json(await service.get(c.get("identity").user.id)));
  router.post("/v1/billing/refresh", async (c) =>
    c.json(await service.refresh(c.get("identity").user.id)),
  );
  router.post("/v1/billing/checkout", async (c) => {
    // Preserve disabled billing's response even when the supplied JSON is malformed.
    if (config.BILLING_ENABLED !== "true") throw new AppError("billing_not_enabled", 503);
    const selection = checkoutSelection.parse(await c.req.json());
    const user = c.get("identity").user;
    const result = await service.startCheckout(user.id, user.email, selection);
    return c.json({ url: result.url });
  });
  router.post("/v1/billing/subscription/preview", async (c) => {
    if (config.BILLING_ENABLED !== "true") throw new AppError("billing_not_enabled", 503);
    const target = z
      .object({ plan: z.string().min(1).max(40), interval: z.enum(["monthly", "yearly"]) })
      .strict()
      .parse(await c.req.json());
    const identity = c.get("identity");
    return c.json(await service.planChanges.preview(identity.user.id, identity.session.id, target));
  });
  router.post("/v1/billing/subscription/change", async (c) => {
    if (config.BILLING_ENABLED !== "true") throw new AppError("billing_not_enabled", 503);
    const body = z
      .object({ quote_id: z.uuid() })
      .strict()
      .parse(await c.req.json());
    const identity = c.get("identity");
    return c.json(
      await service.planChanges.confirm(identity.user.id, identity.session.id, body.quote_id),
      202,
    );
  });
  router.get("/v1/billing/subscription/changes/:id", async (c) =>
    c.json(
      await service.planChanges.get(c.get("identity").user.id, z.uuid().parse(c.req.param("id"))),
    ),
  );
  router.post("/v1/billing/portal", async (c) =>
    c.json({ url: await service.portal(c.get("identity").user.id) }),
  );
  return router;
}
