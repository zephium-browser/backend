# Operate the backend

Use [staging setup](staging.md) for the first hosted deployment or [self-hosting](self-hosting.md) for operator-owned model access without Zephium billing. This guide covers routine changes and recovery after setup.

## Before a deployment change

Keep the exact deployed source revision, image digests and policy revision together. Back up the database, private policy, eligibility secret and deployment configuration. Validate the candidate policy, environment and required provider keys before changing the active revision.

Close new traffic as appropriate, drain active requests, and stop API/worker with at least 45 seconds of grace. Apply migrations with the migrator role, explicitly register the reviewed policy, then start both runtime processes with application credentials and the matching policy file. The [staging command reference](staging.md#operator-command-reference) provides exact commands. Runtime startup never activates a policy candidate.

After starting, check public API readiness, worker health, sign-in, billing state and a bounded model request before reopening traffic. A failed candidate startup leaves the previously active policy unchanged. An explicit policy activation changes which runtime revision may admit work.

For rollback, select a compatible image and publish a higher policy revision restoring the intended values. Do not reduce the active revision, reverse migrations blindly or run old code against an incompatible schema.

## What to watch

| Signal | Operator action |
| --- | --- |
| API or worker unhealthy | Inspect aggregate errors, database connectivity and policy revision before restarting |
| Billing/order/export retries exhausted | Review the affected durable job and provider state; preserve idempotency |
| Missing usage or unexpected exposure | Compare provider usage and deployment budgets; investigate before raising limits |
| Email unavailable/throttled | Check Resend delivery/quota and retry guidance; never request or log a user's OTP |
| Backup stale, archive failing, disk pressure | Repair the archive path and preserve WAL; verify an independent restore |

Customer credits are charged from authoritative usage. Missing usage can release the customer's hold after recovery, while independent provider-cost exposure remains reserved and further admission is limited. Account deletion does not erase deployment spending. Do not edit balances, grants or `paid_until` directly as an incident shortcut, and do not automatically replay generation requests.

Use external uptime checks and a private `OPERATIONS_WEBHOOK` for alerts. Watch actual memory, database/WAL growth and latency before changing resource limits. Current limits and single-host deployment are not a capacity or availability guarantee.

## Back up and restore

Follow the [encrypted backup runbook](../deploy/backups/README.md) for retention, off-server qualification and production scheduling. Use a private [pgBackRest configuration](../deploy/postgres/pgbackrest.conf.example) with bucket-scoped storage credentials and repository encryption. Keep the encryption passphrase in separate recovery custody. The policy and backup configuration are read-only host mounts; ensure the intended container user can read them.

Initialize and check archival, then take a first full backup. The following is an opt-in example for operators who back up staging; Zephium's disposable staging environment currently leaves archival disabled:

```sh
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml exec -u postgres postgres pgbackrest --stanza=zephium stanza-create
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml exec -u postgres postgres pgbackrest --stanza=zephium check
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml exec -u postgres postgres pgbackrest --stanza=zephium --type=full backup
```

Schedule weekly full and daily differential backups with WAL monitoring. Never delete unarchived WAL to clear an alert. Back up Coolify configuration, policy files, stable eligibility secret and other recovery credentials separately; a database volume backup does not contain them.

Restore to a new volume or host, keeping API/worker closed. Check accounts, sessions, billing jobs, refunds, grants/holds, policies, request recovery and deployment exposure. Reconcile Polar state and account/session revocations that occurred after the snapshot; rotate sessions before reopening after disaster recovery. Test the real encrypted off-host restore before calling backup ready.

The local [testing guide](testing.md) explains native and container restore checks. Those tests do not prove access to the deployed backup bucket or recovery passphrase.

## Protect the deployment boundary

Only API receives public HTTPS traffic; PostgreSQL and worker have no public ingress. Trust only the proxy addresses actually observed by API. Preserve the existing website's route. Disable proxy access logs, anonymous reporting and SSE compression using the reviewed [Traefik privacy arguments](../deploy/traefik-privacy-args.txt) and [route example](../deploy/traefik-api.yaml), adapted to the actual Coolify service/router names. Check the generated route for overlapping handlers. Test streaming, deadlines and shutdown through the deployed TLS path.

Keep staging and production secrets, databases, provider projects, Polar environments and backup paths separate. Enter secrets directly into the secret store, never chat or Git. Restrict SSH/Coolify access to operators and require MFA. PostgreSQL role initialization runs only for a fresh volume; existing passwords and roles need explicit maintenance. Never delete a volume to repair role or migration failures.

The API retains account, billing, policy, grant and usage records. It also retains the current processed account avatar when a user uploads one. It does not persist prompts, page text, generated output, or AI image/audio inputs. External email, billing and model providers have their own retention terms. Avoid logging request content, OTPs, credentials or raw identifiers during troubleshooting.

## Request admission

The API admits at most `HTTP_MAX_IN_FLIGHT` requests (default 128) from receipt until response headers, and at most `HTTP_MAX_PER_CLIENT` (default 24) per client network (IPv4 address or IPv6 /64, resolved through the trusted proxy chain). Buffered request bodies share a 96 MiB budget: a declared `Content-Length`, or the route maximum for chunked uploads, is reserved before reading. Excess requests receive `503 server_busy` with `Retry-After: 1`. Established AI streams no longer hold an admission slot; the policy's `globalConcurrent`, `maxFreeConcurrent` and per-plan `maxConcurrent` bound them. `/health/live`, `/health/ready` and `/v1/client-config` bypass admission so probes stay truthful under load. Sign-in routes may use up to three quarters of `DB_POOL_SIZE` at once.

A desktop Work run opens about five concurrent Cloud streams, so `globalConcurrent` is the effective hosted user ceiling: 32 serves roughly six simultaneous Work runs. Size it from provider rate limits and measured memory, not from this default.

## Enrollment and email behavior

`SIGNUP_OPEN=false` stops new account creation; existing allowed users can still sign in. `SIGNUP_EMAIL_ALLOWLIST` restricts sign-in and email-change destinations to exact comma-separated addresses; an empty value permits all addresses. Case/whitespace are normalized, plus aliases remain distinct, and deletion remains available. Keep staging on an explicit list.

Sign-in code requests are limited before account lookup to `OTP_SENDS_PER_NETWORK_PER_15_MIN` (default 30 per 15 minutes). IPv4 addresses are individual buckets; IPv6 privacy addresses share a /64 bucket. Equivalent IPv6 spellings and IPv4-mapped addresses cannot create separate buckets. Only keyed hashes are stored. This is temporary send throttling, not an identity or trial-grant decision; existing sign-in codes can still be redeemed. All sign-in, deletion and email-change code requests also share `EMAIL_SENDS_PER_MINUTE` (default 300) across API replicas, including deliberately suppressed sends so saturation cannot disclose account existence. Rejected attempts return `429 rate_limited` with `Retry-After`; failed provider deliveries consume capacity and are not automatically retried. These limits bound send velocity, not the monthly email invoice; monitor Resend quota separately and tune for legitimate shared-network traffic.

Email delivery is awaited and bounded by `EMAIL_MAX_IN_FLIGHT` (1–16). Delivery failure or saturation returns `503 email_unavailable` with retry guidance; provider throttling shares a cooldown across sign-in and account-action mail. There is no plaintext-code queue or automatic resend. Generic accepted responses also cover deliberately suppressed sends, so verify inbox receipt. Rotating `AUTH_SECRET` invalidates outstanding codes and sessions; preserve the independent eligibility secret unless carrying out a reviewed migration.

For client behavior, use the durable [desktop contract](desktop-integration.md). Public client config is cached for five minutes; server-side gates remain authoritative. Minimum client version is advisory.

The base hosted staging stack is deliberately disposable while off-server storage is pending. It disables archive_mode to prevent unarchived WAL accumulation. Apply compose.staging-backups.yaml only with working pgBackRest configuration and verify restoration before treating staging as backed up. This exception does not apply to production.

## Subscription-change rollout and recovery

Apply migration `0008_subscription_changes.sql` before starting an image containing plan changes. Both API and worker need the same reviewed policy. Polar's token additionally needs `subscriptions:read` and `subscriptions:write`. Keep multiple subscriptions per customer disabled. Disable customer-portal **plan changes** before enabling this workflow: the portal's single default proration rule cannot implement immediate paid upgrades and renewal-only downgrades together. Keep ordinary portal cancellation available. The backend explicitly selects `invoice` or `next_period`; it does not depend on the organization's default proration setting.

Create distinct fixed-price monthly Pro and Max sandbox products, retain historical product mappings, and enable their offers only in a reviewed policy revision. Never reuse a product ID for a different entitlement. Verify successful and declined upgrades, renewal downgrades, one payment for repeated confirmation, and proportional allowance changes in sandbox. Existing $1/$10 staging products are test fixtures, not approved production prices. USD20 Pro and USD100 Max monthly pricing does not set production allowance amounts or annual pricing.

The `billing_plan_change` record is the durable source for each operation. Provider I/O runs outside database transactions; a lease and dispatch marker fence stale workers. After a possible dispatch, recovery only reads the subscription. After ten failed recovery attempts the operator is alerted; read-only recovery keeps retrying at the capped one-hour backoff and never charges again. Pending operations block subscription reconciliation and final account purge, while account access is still disabled immediately upon deletion request.

For an exhausted operation, inspect its content-free identifiers and authoritative Polar subscription/payment records. Recovery resumes by itself within an hour once the provider is reachable; to retry sooner, reset only its next-attempt timestamp. Never change it back to `queued`, clear its dispatch marker, delete its audit record, or replay PATCH as a retry. If Polar cannot establish the outcome, keep the operation unresolved and escalate to provider support. A manual resolution requires explicit evidence about the charge and subscription, a stopped/drained worker, and a reviewed account-scoped database change; never alter allowance balances to hide an unresolved payment.

## Production deployment preparation

Use [compose.production.yaml](../deploy/compose.production.yaml) and [production.env.example](../deploy/production.env.example) for a **separate** hosted production application, database volume, managed policy file, proxy network and secrets. The production Compose fixes Polar to production, mounts the private host file `/etc/zephium/backups/pgbackrest.conf` read-only, and permits an empty email allowlist. The bind source is a literal path because Coolify 4.4 rejects variable expressions in mount sources before Compose interpolation. Install the file first; a missing source must fail rather than create a directory. It does not provision storage, TLS, products or backup schedules. Start with signup/billing disabled and a reviewed disabled policy. Keep staging's mandatory allowlist and sandbox environment unchanged.

At launch, set `SIGNUP_OPEN=true`, leave `SIGNUP_EMAIL_ALLOWLIST` empty, and choose `SIGNUP_PER_IP_PER_DAY` explicitly (default3 completed signups per UTC day). Disposable blocking is enabled; missing or empty data fails production startup. The bundled list is pinned with provenance and must be updated through a reviewed source change/rebuild. Set a one-time free allowance, zero welcome grant, and an approved `freeDailyUsdMicros` ceiling. Paid subscription allowance bypasses that **free** ceiling; global daily/total safety budgets still apply to paid and free accounts alike. Production amounts are not inferred from staging fixtures.

For Telegram, configure `OPERATIONS_WEBHOOK` privately as its HTTPS Bot API `sendMessage` URL with a `chat_id` query. The sender moves the destination into JSON, disables link previews and requires both HTTP success and Telegram's `ok:true`. Errors never include the URL/token or response body. Confirm receipt of an explicit test operational event before claiming alerts work. Configure external uptime, worker-health, backup-freshness, failed-WAL-archive and disk alerts separately; the worker's spending/job alerts do not replace those checks.

Keep the pgBackRest secret file accessible only to its intended container OS user and trusted operators, outside Git and application mounts. Determine the actual PostgreSQL UID/GID from the deployed image before setting file ownership; a root-only0600 file is not readable by an unprivileged postgres process. Keep the encryption passphrase in separate recovery custody. Real off-server qualification needs an initialized repository, working WAL archival, a full backup, configured backup/monitoring schedules, and an isolated restore using the real bucket and recovery credentials. Preserve the source volume during this test. Verify identities, eligibility, subscription state, refund markers, grants/holds and cost exposure in the restored database, with outbound mail/billing/AI disabled. Local CI restore results are not evidence of this live storage path.

## Billing contact reconciliation

Apply `0009_billing_contact_jobs.sql` before starting images with contact synchronization. It seeds pending checks for existing active, verified accounts with a provider relationship. Verified account email changes enqueue work in the same transaction as the local change and session revocation. The queue stores only an account ID and retry counters; the worker reads the latest verified address under the account's billing lock and updates an existing Polar customer by stable external ID. It never creates a customer or changes historical invoices.

Contact work has separate attempts and scheduling from subscription reconciliation. A lost update response is recovered by reading current customer state; an already-matching contact needs no second write. Ten failures trigger a content-free operational alert while subscription refresh continues; the job keeps retrying hourly. Contact-only exhaustion does not mark the whole worker unready. Deleting accounts and pending subscription changes are excluded; account purge removes obsolete contact jobs.

After correcting provider permissions or a contact conflict, an operator may reset the specific `billing_contact_job` row's attempts and next-attempt time to retry the latest verified address. Do not edit the account's verified email, change external customer IDs, or clear billing/credit safety records as a workaround. Existing `customers:write` permission is required.

## Account avatars and transactional email

Apply `0010_account_avatars.sql` before starting the avatar-enabled API. It adds one bounded binary row per account without changing existing billing data. Only re-encoded 256×256 WebP bytes and minimal version metadata are stored. Account deletion immediately removes the avatar before deferred billing cleanup; encrypted historical backups expire under the normal retention policy. The API child image processor receives no provider/database credentials, has an eight-second parent deadline, and admits at most two concurrent jobs with no queue. Both image builds and the restricted container check run a synthetic native-codec smoke check.

Identity mail now contains purpose-specific HTML and equivalent plain text for sign-in/signup verification, email change and deletion. These remain one-time, five-minute codes; no welcome/marketing automation or duplicate billing mail is added. Templates contain no remote assets or tracking links. Resend's own open/click tracking must separately be disabled and verified at the provider. Do not infer that a template alone disables provider tracking.

Before public launch, choose a transactional sending quota suitable for verified signup and retries, verify DMARC alignment and bounce/suppression handling, confirm representative inbox rendering/autofill, and update the website privacy notice for stored profile images and backup retention. As of the October 21 inspection, the Resend account was on the free 100/day and 3,000/month caps; the existing send key could not retrieve domain tracking settings. This does not establish production email capacity or tracking status.

### Prebuilt images in Coolify 4.4

For the image-only production Compose application, set Custom build command to `true` and leave Custom start command empty. Mark application environment variables runtime-only. Coolify otherwise runs `docker compose build` even though all services use prebuilt images; Compose interpolation then requires runtime-only variables during the unnecessary build phase. The no-op build keeps provider credentials out of that build phase. Normal startup pulls any missing pinned images and injects the runtime environment. Keep automatic and preview deployments disabled for this production resource.

### Cloudflare in front of the account API

Keep `TRUSTED_PROXY_CIDRS` restricted to the observed Coolify proxy address. For a proxied API hostname, set `TRUSTED_CLOUDFLARE_CIDRS` to the reviewed IPv4 and IPv6 ranges published at https://www.cloudflare.com/ips/ and restrict the production Traefik route to those source ranges. The API accepts `CF-Connecting-IP` only when its socket peer is trusted and the rightmost `X-Forwarded-For` entry appended by Traefik is a Cloudflare address. Never enable insecure forwarded-header trust, suppress Traefik's appended peer, or use a client-supplied leftmost address. Test a forged header through a direct connection and two different visitors through Cloudflare before opening signup. Staging may retain the direct-proxy configuration with the Cloudflare list empty.

Use Full (strict) TLS, bypass API caching, avoid browser challenges for native clients and signed webhooks, and qualify streaming through the full path. Cloudflare terminates TLS and must be covered by the service privacy description. An orange-cloud record alone does not block direct-origin traffic; the staging hostname shares the server IP. Scope origin restrictions to the production API route so existing website, staging, ACME and Coolify access remain intact.

In Coolify 4.4, mark the existing pgBackRest configuration mount as host-managed. Its storage writer must not recreate or chmod this secret file. Verify mode `0600`, PostgreSQL ownership, and the read-only mount after Compose reload and deployment.


## Worker reliability

Each worker task (cleanup, request recovery, plan changes, orders, contact sync, usage export, subscription reconciliation) fails independently: one failing step never stops the others. A task that fails five consecutive times marks the worker unready in its health file and sends the `worker` alert. Every durable queue keeps retrying with exponential backoff capped at one hour; ten attempts mark a row exhausted for alerts and the admin Jobs view, but never stop it permanently. Exhausted order and usage-export jobs no longer hold account deletion.

Subscription reconciliation, deletion and contact sync claim a row with a five-minute lease and call Polar outside any database transaction, so customer requests never wait on the provider. Customers with an active subscription are re-read every 15 minutes; others every six hours (webhooks, checkout and refresh still enqueue immediate work). Paid access requires a reconciliation within the last 72 hours, so a multi-hour Polar or worker outage alerts rather than silently moving paying customers to Free.

Any refund of a subscription order, full or partial, and any lost dispute (which Polar records as a refund) ends paid access for the billing period that order paid for, at the next reconciliation (seconds after the webhook). A later paid renewal restores access. The subscription itself is not cancelled in Polar; cancel or revoke it there as well when the customer should not be charged again. To compensate a customer without removing access, use a discount rather than a refund. Refunded top-ups revoke their credit grant as before.

Set `WORKER_HEARTBEAT_URL` to an external dead-man check (for example a Healthchecks.io ping URL with a few minutes of grace). The worker pings it at most once a minute while healthy, so the check alerts on a dead host, a stopped container or a stuck loop, independently of `OPERATIONS_WEBHOOK`.

Worker alert categories (billing jobs, contact updates, spending thresholds, worker tasks) have
independent one-hour reminder cooldowns. New failures alert immediately; recoveries
send once after a delivered failure alert. Failed deliveries retry at the next
health scan, and a failed category does not suppress the others. This delivery
state is process-local, so a restart can repeat an active alert. A failed spending
check is not treated as a recovery.
