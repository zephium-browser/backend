# Set up hosted staging

Start with a private test deployment at `https://staging-api.zephium.app`. Use Polar sandbox and a small list of approved testers. Keep the existing website in place. This guide prepares a deployment; it does not mean one has already been deployed or qualified.

Enter credentials directly in your password manager and Coolify's environment settings. Do not send keys, passwords, webhook secrets or filled environment files through chat. Nonsecret product IDs, domains and image digests can be reviewed normally.

## 1. GitHub: prepare reviewed images

The backend source is public at [zephium-browser/backend](https://github.com/zephium-browser/backend). Review the intended source revision before building its deployment images. Container-package visibility is configured separately; private images require registry authentication on the deployment server.

In the repository's **Actions** tab, run **Check**. It includes Linux tests, encrypted-backup restoration and the self-host Compose check. Then run **Build deployment images** from `main`. That workflow requires its checks and the `container-release` environment. Save the three reported image digests: account, worker and PostgreSQL. Coolify will run those exact images rather than build on the VPS.

Set `SOURCE_URL` to the public source for that exact revision. The website and native desktop remain separate projects.

## 2. Resend: prepare sign-in email

In **Domains**, confirm the sender domain is verified and its required DNS records are present. Disable open/link tracking. In **API Keys**, create a sending key for the verified domain. Put it in Coolify as `RESEND_API_KEY` and set `EMAIL_FROM` to the approved sender.

Check the account's sending quota and test delivery to each staging tester. A generic accepted response from the API is not proof that a code reached the inbox.

## 3. Polar sandbox: prepare purchases

Use the sandbox account, separate from production. In **Products**, create the intended monthly/yearly Pro subscriptions and one-time credit packs, each with one active fixed price. Copy their nonsecret product IDs into the reviewed staging policy. Put the sandbox access token in `POLAR_ACCESS_TOKEN`.

In **Webhooks**, add `https://staging-api.zephium.app/webhooks/polar` for `customer.state_changed`, `order.paid`, `order.updated`, `order.refunded`, `refund.created` and `refund.updated`. Polar reports a lost dispute (chargeback) as a refund, so the refund events cover both. Save its signing secret directly as `POLAR_WEBHOOK_SECRET`; use Standard Webhooks format. Delivery can be tested after the API is reachable.

The website owner must supply `https://zephium.app/billing/return`. Set both `BILLING_SUCCESS_URL` and `BILLING_RETURN_URL` to that deployed page. It is only a return page; the backend confirms purchases with Polar. Leave `BILLING_ENABLED=false` until sandbox checkout, portal, webhook and refund checks can be run. The staging Compose file fixes the Polar environment to sandbox.

## 4. OpenAI: prepare a separate test project

In the API dashboard, select a dedicated staging project and create a project API key. Store it only as `CLOUD_OPENAI_KEY` in Coolify. The desktop never receives it. Confirm that this project can use the exact text and transcription models in the reviewed policy.

Open **Project settings → Limits → Spend → Edit spend limit**, choose the monthly ceiling, and enable **Enforce a hard limit**. Add alerts below that ceiling. Alerts alone allow traffic to continue; hard-limit enforcement can slightly overshoot while it propagates. See the current [official OpenAI spend-limit instructions](https://developers.openai.com/api/docs/guides/spend-limits).

The backend's separate staging budget starts at $50 total, $10 per UTC day and $5 daily free subsidy. Paid test accounts also consume the deployment limits. Keep both provider controls and backend controls in place. Model access, actual usage fields and prices still need live qualification.

## 5. Coolify: create the staging application

Create a separate **Docker Compose application** using [deploy/compose.staging.yaml](../deploy/compose.staging.yaml). Set only the API service's domain to `https://staging-api.zephium.app`, with internal port 3000. Keep automatic deployment off while preparing policy changes. Use a separate database volume, staging secrets and backup storage.

For Coolify 4.3.23, select **Raw (deploy file as-is)**, manual deployments, and disabled previews. Its managed Compose mode injects the complete environment file into every service, which would bypass the credential boundaries declared here. Raw mode needs an explicit API-only proxy route; use the installed proxy's actual entrypoint and certificate resolver, disable access logs/tracing for this route, and preserve streaming without compression or buffering.

Set `ZEPHIUM_PROXY_NETWORK` to the application's dedicated proxy network. Coolify creates a network named after the application UUID and connects its proxy to it. Do not attach this API to the shared `coolify` network: another database there can also advertise the hostname `postgres`, causing the API to authenticate against the wrong database while the worker works correctly. Verify network membership and DNS resolution before starting traffic. Set `TRUSTED_PROXY_CIDRS` to the proxy's exact addresses on that dedicated network. PostgreSQL and the worker must remain off the proxy network.

Fill the [environment inventory](../deploy/staging.env.example) in Coolify:

| Group | What to supply |
| --- | --- |
| Images and files | Three reviewed image digests and reviewed policy file content; private pgBackRest config when backups are enabled |
| Database | Independent owner, migrator and application passwords; matching URL-encoded migrator/app connection URLs |
| Identity | Separate random auth, abuse and stable eligibility secrets; Resend key and sender |
| Access | Exact API/trusted origins, observed proxy CIDRs, approved tester email addresses |
| Integrations | OpenAI project key, sandbox Polar token/webhook secret, deployed return URLs |
| Operations | Public corresponding-source URL and private HTTPS alert destination |

Coolify labels normal deployment values **Production** even within a staging resource. Keep preview deployments disabled; Compose-referenced preview variables may be undeletable and do not need removal. Keep generated environment files root-readable only, and inspect selected metadata rather than printing the populated Compose configuration.

Set `CLIENT_MIN_VERSION=1.0.0-beta.2` for the current desktop beta. The API service must explicitly receive this variable through Compose; an unused Coolify environment value does not override the application default. A stable `1.0.0` minimum excludes `1.0.0-beta.2` under semantic versioning. Production must explicitly select its oldest supported build.

Use `SIGNUP_OPEN=false` initially and set `SIGNUP_EMAIL_ALLOWLIST` to exact comma-separated tester addresses. Later, setting signup open allows those approved testers to enroll. API and worker get application database credentials; only migration and policy jobs get migrator credentials. Never use the local-development database password here.

Create the Coolify-managed File `./zephium-staging-policy.json` mounted at `/app/config/staging.json`, using the reviewed staging policy JSON and set `enabled:false` before the first activation. The checked-in staging template is enabled for testing and is not a production policy. Review allowances, model access, prices, budgets and sandbox product mappings before enabling it; increase its revision for each change. Hosted mode must not select `selfHostedPlan`.

The base staging Compose deliberately disables WAL archiving and has no off-server backup. This is suitable only for the owner-approved disposable staging environment: all test data can be lost if the host fails. It is not a production topology. To enable backups, add `deploy/compose.staging-backups.yaml` to the Compose files, provide the private backup configuration, initialize the stanza and verify an independent restore. Never enable archive mode with an unconfigured destination. Production must have verified encrypted off-host backups before serving customers. Inspect Coolify's generated Compose: only API should join the proxy network, PostgreSQL/worker should have no public ingress, and host file mounts must point to the intended readable files. The existing website keeps its route. PostgreSQL bootstrap SQL/scripts are baked into the reviewed image; do not create directory mounts for them. The policy uses a concrete relative file path because Coolify's file-content writer does not expand environment variables in storage paths. For command-line Compose, place the reviewed file at `deploy/zephium-staging-policy.json` (Git-ignored); in Coolify, use its managed File editor and verify the resolved application-storage path before saving. See [Coolify's Compose](https://coolify.io/docs/applications/builds/docker-compose) and [networking](https://coolify.io/docs/core/networking-in-coolify) documentation.

## 6. Start closed, then test with the desktop

Run database migration, validate the candidate configuration, explicitly activate the reviewed policy, and start API/worker using the commands below. Check public `/health/ready`, worker health and `/v1/client-config`. Initially cloud, billing and signup should be closed.

Confirm DNS/TLS and the actual proxy address seen by the API. Set `TRUSTED_PROXY_CIDRS` from that observation, not an arbitrary public range. Verify streaming through the public route. Then open enrollment only to the approved list and test email-code sign-in from the desktop.

Enable cloud and sandbox billing in a reviewed higher policy revision when ready. Test checkout/portal return, immediate credit refresh, subscription changes, duplicate/delayed webhooks, refunds, interrupted requests, transcription, deletion, restart and rollback. Verify each enabled model's actual metering. Complete an independent encrypted backup restore before qualifying backups or promoting this deployment design to production. Record results in [testing.md](testing.md); local green checks alone do not authorize public paid service.

## Operator command reference

These commands are the detailed deployment mechanics. Use the same images, Compose project and secret environment as the Coolify resource; do not accidentally create a second stack against its database. Examples assume an operator-only mode-0600 file at `/etc/zephium-staging/staging.env` and a checkout containing the deployment files.

Start the private database and apply migrations. `config --quiet` validates interpolation without printing secrets:

```sh
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml config --quiet
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml up -d postgres
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml run --rm migrate
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml run --rm --no-deps api bun scripts/cloud-policy.ts validate /app/config/staging.json
```

Validate API configuration and enabled-provider key presence without starting a listener or changing the active policy:

```sh
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml run --rm --no-deps api bun -e '
const { readConfig } = await import("./src/platform/config.ts");
const { loadPolicy } = await import("./src/modules/policy/policy.ts");
const c = readConfig();
const p = await loadPolicy(c.CLOUD_CONFIG_PATH);
if (p.selfHostedPlan) throw new Error("Hosted policy cannot select selfHostedPlan");
for (const m of p.models.filter(m => p.enabled && m.enabled)) {
  if (!process.env[`CLOUD_${m.provider.toUpperCase()}_KEY`]) throw new Error(`Missing key: ${m.provider}`);
}
console.log("Candidate configuration validated; policy has not been activated");'
```

This checks local configuration and key presence. It does not validate provider credentials or product configuration. On updates, take a verified backup and drain traffic first. Activate deliberately:

```sh
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml stop -t 45 api worker
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml --profile operations run --rm policy
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml up -d api worker
```

The policy job runs the equivalent of `bun run cloud:register /app/config/staging.json`. API/worker startup only checks that revision and digest. Review the policy job's successful exit before resuming traffic. For recovery and updates, use [operations.md](operations.md).
