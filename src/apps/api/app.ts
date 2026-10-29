import { authenticate } from "../../modules/identity";
import { createWaitlistRoutes } from "../../modules/waitlist";
import { createClientAddressResolver } from "../../platform/client-address";
import { installHttpMiddleware } from "./middleware";
import { installPublicRoutes } from "./public-routes";

export { clientAddress } from "../../platform/client-address";

import { Hono } from "hono";
import { z } from "zod";
import type { CloudService } from "../../modules/ai";
import { createAiRoutes } from "../../modules/ai";
import type { BillingProvider } from "../../modules/billing";
import {
  createBillingRoutes,
  createBillingService,
  createBillingWebhookRoutes,
  lockAccountBilling,
  queueBillingContactSync,
  scheduleAccountDeletion,
} from "../../modules/billing";
import { createCreditRoutes, usageSummary } from "../../modules/credits";
import type { Auth } from "../../modules/identity";
import {
  createAccountRoutes,
  createAccountService,
  createIdentityRoutes,
  type Mailer,
  resendMailer,
} from "../../modules/identity";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError, errorResponse, operationalEvent } from "../../platform/errors";

type Session = NonNullable<
  Awaited<Auth["api"]["getSession"] extends (...args: never[]) => infer T ? Awaited<T> : never>
>;
export function createApp(
  config: Config,
  db: Database,
  auth: Auth,
  provider: BillingProvider,
  peerAddress: (r: Request) => string = () => "127.0.0.1",
  cloud?: CloudService,
  mailer: Mailer = resendMailer(config),
) {
  const app = new Hono<{ Variables: { identity: Session } }>();
  const billingService = createBillingService(config, db, provider, cloud?.policy ?? null);
  const resolveClientAddress = createClientAddressResolver(
    config.TRUSTED_PROXY_CIDRS,
    config.TRUSTED_CLOUDFLARE_CIDRS,
  );
  const clientIp = (request: Request) =>
    resolveClientAddress(peerAddress(request), request.headers);
  installHttpMiddleware(app, config, db, clientIp);
  installPublicRoutes(app, config, db, cloud);
  app.route("/", createWaitlistRoutes(config, db, clientIp));
  app.route("/api/auth", createIdentityRoutes(config, db, auth, clientIp));
  app.route("/", createBillingWebhookRoutes(config, db));
  app.use("*", async (c, next) => {
    if (
      !["/v1/", "/openai/", "/anthropic/", "/google/", "/openrouter/", "/deepseek/"].some(
        (prefix) => c.req.path.startsWith(prefix),
      )
    )
      return next();
    const identity = await authenticate(config, db, auth, c.req.raw.headers);
    c.set("identity", identity);
    await next();
  });
  app.route("/", createBillingRoutes(config, billingService));
  if (cloud) {
    app.route("/", createCreditRoutes(db, cloud.policy));
    app.route("/", createAiRoutes(cloud));
  }
  const accounts = createAccountService(config, db, mailer, {
    beforeAccountMutation: lockAccountBilling,
    onDeletionRequested: scheduleAccountDeletion,
    onEmailChanged: queueBillingContactSync,
    exportExtras: async (userId) => ({
      billing: await billingService.summary(userId),
      usage: cloud ? await usageSummary(db, cloud.policy, userId, true) : null,
    }),
  });
  app.route("/", createAccountRoutes(accounts));
  app.notFound(() => errorResponse(new AppError("not_found", 404)));
  app.onError((error) => {
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 503;
    const code =
      error instanceof AppError ? error.code : status === 400 ? "invalid_request" : "unavailable";
    if (status >= 500) operationalEvent("api_request_failed");
    return errorResponse(error instanceof AppError ? error : new AppError(code, status));
  });
  return app;
}
