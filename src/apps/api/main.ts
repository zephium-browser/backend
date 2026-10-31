import { createCloudService, nativeTransport } from "../../modules/ai";
import { polarProvider } from "../../modules/billing";
import {
  createAuth,
  eligibilitySecret,
  prepareGrantEligibility,
  resendMailer,
} from "../../modules/identity";
import { assertActivePolicy, loadPolicy } from "../../modules/policy";
import { assertWaitlistReady } from "../../modules/waitlist";
import { createClientAddressResolver } from "../../platform/client-address";
import { readConfig } from "../../platform/config";
import { createDatabase } from "../../platform/db";
import { emailNetwork } from "../../platform/ip-bucket";
import { createApp } from "./app";
import { createApiServer } from "./server";

const config = readConfig();
const db = createDatabase(config);
const policy = await loadPolicy(config.CLOUD_CONFIG_PATH);
if (config.DEPLOYMENT_MODE === "hosted" && policy.selfHostedPlan)
  throw new Error("Hosted deployment cannot select a self-hosted plan");
await assertActivePolicy(db, policy);
// Completes the one-time v1 grant grouping after migration 0011; a no-op afterwards.
await prepareGrantEligibility(db, eligibilitySecret(config));
if (config.WAITLIST_ENABLED === "true") await assertWaitlistReady(db);
const transport = nativeTransport({
  openai: config.CLOUD_OPENAI_KEY,
  anthropic: config.CLOUD_ANTHROPIC_KEY,
  google: config.CLOUD_GOOGLE_KEY,
  openrouter: config.CLOUD_OPENROUTER_KEY,
  deepseek: config.CLOUD_DEEPSEEK_KEY,
  typesafe: config.CLOUD_TYPESAFE_KEY,
});
if (policy.enabled)
  for (const model of policy.models.filter((m) => m.enabled))
    if (!transport.available(model.provider))
      throw new Error(`Cloud provider key missing: ${model.provider}`);
const mailer = resendMailer(config);
const cloud = createCloudService(db, policy, transport, config.ABUSE_SECRET);
const server = createApiServer(
  (peer) =>
    createApp(
      config,
      db,
      createAuth(config, db, mailer),
      polarProvider(config),
      peer,
      cloud,
      mailer,
    ),
  config.PORT,
  undefined,
  config.WAITLIST_WEB_ORIGIN,
  {
    maxInFlight: config.HTTP_MAX_IN_FLIGHT,
    maxPerClient: config.HTTP_MAX_PER_CLIENT,
    maxBufferedBytes: 96 * 1024 * 1024,
    clientAddress: (() => {
      const resolve = createClientAddressResolver(
        config.TRUSTED_PROXY_CIDRS,
        config.TRUSTED_CLOUDFLARE_CIDRS,
      );
      return (request: Request, peer: string) => {
        const address = resolve(peer, request.headers);
        try {
          // IPv6 privacy addresses share one /64 admission bucket.
          return emailNetwork(address);
        } catch {
          return address;
        }
      };
    })(),
  },
);
async function stop() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    server.stop(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 20000);
    }),
  ]);
  clearTimeout(timer);
  await cloud.shutdown();
  await server.stop(true);
  await db.close();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
