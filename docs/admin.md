# Optional administrator console

The admin console is a separate Bun process and image target (`admin`), serving its own UI on port 3001. It reads customer reporting views and maintains separate operator identities, authentication state, throttles, and audit events. It has no customer mutation controls. Customer sessions cannot sign into it. No email, AI provider, Polar, account API, or worker secret belongs in its environment.

This is a staging deployment recipe, not production qualification. Existing customer API and worker deployments remain independent. The admin schema has its own migration command and ledger; do not run the general customer migration command to deploy this optional console or apply unrelated pending customer changes.

## Prepare the server

Choose a new HTTPS origin and configure its DNS and reverse proxy before access. Keep the origin distinct from the API and any customer application; route only this hostname to the unique `ADMIN_PROXY_ALIAS:3001` on the proxy network. Use distinct aliases for staging and production. This alias is attached only to the chosen proxy network, so routing does not depend on Coolify-generated container names or select a different shared network. Preserve the original Host header, terminate TLS, disable response caching, and disable request access logs for this route so query strings, cookies and authentication bodies are not recorded. A VPN or proxy access restriction is useful before first operator enrollment. The application also checks the exact origin and uses its own host-only admin cookies.

Use `deploy/admin.env.example` to prepare a private server file such as `/etc/zephium/admin.env`, readable only by the operator account. Generate a fresh admin auth secret of at least 48 characters directly into the secret store. Use two different database passwords, with URL encoding when constructing connection URLs. Do not reuse account auth secrets or credentials. Avoid shell tracing, credentials in command arguments, and resolved Compose output; `docker compose config --quiet` validates without printing interpolated secrets.

Set `ADMIN_DATABASE_NETWORK` to the exact existing staging PostgreSQL network name, and `ADMIN_PROXY_NETWORK` to the existing staging proxy network name. Do not create similarly named networks accidentally. The admin attaches only to those networks and publishes no host ports. Set `ADMIN_TRUSTED_PROXY_CIDRS` from the observed immediate proxy peer address; configure `ADMIN_TRUSTED_CLOUDFLARE_CIDRS` only for an actual, verified Cloudflare forwarding chain. Restrict outbound access at the host/network layer to required PostgreSQL and proxy traffic, plus HTTPS/DNS for the configured Cloudflare Access public-key endpoint when that perimeter is enabled; attachment to an existing proxy network alone does not enforce an egress firewall.

Build the reviewed source with `docker build --target admin`, publish it through the normal private artifact process, and set `ADMIN_IMAGE` to its reviewed immutable digest. The admin image includes its static UI and local provisioning scripts. The separate Compose file uses a read-only filesystem, 16 MiB temporary directory, dropped capabilities, and no privilege escalation. Its initial limits are 256 MiB RAM, 0.5 CPU, and 64 processes. These are deployment caps, not measured consumption. Each database pool allows two connections; each dedicated database role has a four-connection limit. PostgreSQL is shared with the backend and is not included in the admin container's memory cap.

## Optional Cloudflare Access perimeter

For an owner-only production console, put Cloudflare Access in front of the hostname in addition to the console's password and MFA. Create a separate self-hosted Access application for each environment, allow only the exact owner email (not everyone with the email login method), and choose a one-hour Access session. Do not use bypass policies. This is an additional perimeter: a successful Cloudflare login never creates an operator, issues a dashboard session, or bypasses MFA.

Configure the console with `ADMIN_ACCESS_MODE=cloudflare`, `ADMIN_ACCESS_ISSUER=https://YOUR-TEAM.cloudflareaccess.com`, the application's 64-character AUD tag in `ADMIN_ACCESS_AUDIENCE`, and the exact operator email in `ADMIN_ACCESS_EMAILS`. These settings are not secrets; user JWTs and Cloudflare API tokens must never be placed in them. Invalid or partially supplied settings stop startup. Self-hosters who do not use Cloudflare can leave mode `off` and the other settings empty, protecting access through their own network/perimeter.

The origin checks the `Cf-Access-Jwt-Assertion` signature, RS256 algorithm, exact issuer and audience, expiry, issue time, application-token type and allowed email. An unsigned email header, a copied cookie alone, or a direct request to the server cannot substitute for this verification. Keys are fetched only from the configured team hostname, with redirects forbidden, a three-second deadline, a 64 KiB response cap, caching, shared concurrent fetches and a failure cooldown. Failure denies access; tokens and claims are never logged.

All routes, including HTML, assets, authentication and public readiness requests, pass this gate. Only `GET /health/ready` without query parameters from the actual loopback socket peer bypasses Access, so the internal container health check works. Forwarding headers cannot obtain that exemption. Use a separate staging Access application to verify genuine login and denial of direct-origin requests before enabling the production route. Keep the public route absent until the environment and operator are ready.

If the reverse proxy uses Let's Encrypt HTTP-01 validation, Access must permit the exact `/.well-known/acme-challenge/*` path on each dashboard hostname. Create a separate, path-specific Access application with a Bypass policy for only those certificate paths; keep the owner-only policy on the dashboard application. A broader hostname bypass is unnecessary. This exception is needed for renewal as well as initial issuance. Verify a nonexistent HTTP challenge returns 404 without an Access redirect, while `/`, `/auth/` and `/api/` remain protected. Requests that reach the admin process still require a valid Access token, even under the challenge prefix. DNS-01 validation is an alternative when no public HTTP validation path is desired. Verify the origin's actual certificate with normal TLS validation before asking an operator to sign in; a Cloudflare login redirect alone does not prove the origin certificate is valid.

Reference: [Cloudflare application-token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

## Apply only the admin schema and roles

The staging database must already have the customer tables used by the reporting views. Review that baseline before applying the optional admin migration. Temporarily supply the existing schema migrator URL as `ADMIN_MIGRATOR_DATABASE_URL` through the server secret mechanism, then run from the reviewed checkout:

```sh
docker compose --project-name zephium-admin --env-file /etc/zephium/admin.env -f deploy/compose.admin.yaml --profile operations run --rm --no-deps admin-migrate
```

The migrator credential goes only to this explicit operation. Remove it from the secret file afterward. Leaving it absent does not block normal `up`; invoking the migration without it fails closed.

As the database provisioning owner, apply `deploy/postgres/admin-roles.sql` to the `zephium` database after the admin migration. Use the server's existing PostgreSQL administration access; do not place owner credentials in the admin container. The script provisions `zephium_admin_auth` for admin authentication tables and `zephium_admin_report` for SELECT-only reporting views. Both must have no membership in broader roles. Existing deployments must already revoke public schema creation as specified in `deploy/postgres/roles.sql`. The admin refuses to start with shared, privileged, or overly broad credentials.

In an interactive owner `psql` session, set the two role passwords using its concealed password prompts:

```text
\password zephium_admin_auth
\password zephium_admin_report
```

Store those passwords directly in the server secret store and the two admin connection URLs. Do not echo them or put them in SQL files, terminal history, Compose output, or logs. The role file grants database access for the currently connected database.

## Bootstrap the owner and start

Provision the first operator through `scripts/admin-operator.ts`, supplying the password over stdin from the secret manager. It accepts an email and display name as arguments and requires a password of 16–128 characters. For example, with `secret_manager_command` replaced by the local command that emits just that password:

```sh
secret_manager_command | docker compose --project-name zephium-admin --env-file /etc/zephium/admin.env -f deploy/compose.admin.yaml run --rm --no-deps -T admin bun scripts/admin-operator.ts owner@example.invalid 'Owner'
docker compose --project-name zephium-admin --env-file /etc/zephium/admin.env -f deploy/compose.admin.yaml up -d admin
```

Do not use `echo PASSWORD` or include a password in command arguments. Local provisioning creates a separate operator account; there is no public signup or password-reset flow. Log in at the new origin, enroll an authenticator, save the displayed backup codes securely, and verify a TOTP code before opening reports. Later logins require MFA again; trusted-device shortcuts are disabled and sessions expire after one hour. Operator recovery or revocation is a local maintenance operation, not an exposed reset endpoint. The same CLI accepts `disable EMAIL`, `revoke EMAIL`, and `reset-password EMAIL` (new password over stdin). Disable immediately blocks report access. Stop the admin listener before revoke or password reset to exclude sign-ins already in flight; reset preserves authenticator enrollment and disabled status. Restart only after the command succeeds.

## Reports

Every report is a read-only, audited GET against the report role's views:

| Page | Endpoint | Source views |
| --- | --- | --- |
| Overview | `/api/overview?days=1\|7\|30` | accounts, requests, billing, spend against the active policy's budget caps |
| Revenue | `/api/revenue` | reconciled billing state mapped through the active policy; MRR uses `ADMIN_PLAN_PRICES` |
| Activity | `/api/activity?days=30\|90` | daily UTC signups, new paid subscriptions, calls, active users, failures, stops, credits, provider cost |
| Jobs | `/api/jobs` | pending, retrying and exhausted rows per durable queue, with the oldest due age |
| Users | `/api/users?q=&filter=` and `/api/users/:id` | account, billing state, grants, plan changes, checkouts, sessions (device and dates only), 30-day usage |
| Waitlist | `/api/waitlists/linux` and `/export` | counts on screen; CSV export pages of 1,000 with a separate read budget |
| Audit | `/api/audit` | operator activity, newest first |

`ADMIN_PLAN_PRICES` (for example `pro:monthly=2000,max:monthly=10000`, minor units per billing interval) is display-only and never affects billing. Without it, MRR is reported as unavailable rather than zero. Revenue reflects reconciled subscription state, not a payment ledger; Polar remains the source of truth for invoices and refunds.

Apply admin migrations with `bun scripts/admin-migrate.ts` (`ADMIN_MIGRATOR_DATABASE_URL`); it applies every numbered file in `src/modules/admin/migrations` once and grants the report role SELECT on new views when that role exists. The admin process refuses to start if its report role can read anything outside the approved view list.

## Check staging before wider use

Verify the image and schema, refusal of broad database roles, exact proxy routing, TLS, and private port exposure. Complete real-browser owner provisioning, authenticator enrollment, logout/login with MFA, backup-code handling, wrong-code throttling, and session expiry. Confirm that customer cookies and credentials cannot obtain reports and that unverified operator sessions cannot access them. Inspect the responsive UI, account lookup, empty states, and reporting values against known staging data.

Usage windows are 1, 7, or 30 days; user details use 30 days. Charged credit units, known provider cost, and persisted budget exposure have different meanings. Known provider cost excludes unknown or pending usage, and is not a provider invoice. Unexpired checkout records reflect local expiry rather than confirmed provider checkout status. Balances exclude expired or revoked spendable credit while retaining outstanding reservations. Reports do not issue grants on read.

Admin audit events retain operator, action, target, and timestamp metadata for 400 days and are visible on the Audit page. Searches record the matched account rather than the typed address. The running process removes expired events in bounded batches every minute, alongside expired auth and throttle records. Backups have their own retention and may retain older records; stopping the process also stops this cleanup.

Measure idle memory, peak memory and CPU during login and representative report reads, PostgreSQL query latency, and the effect on customer API/worker traffic on the actual staging host. Confirm recovery after restart and the read-only filesystem under the chosen caps. Record these observations before proposing production use. Automated tests and initial container limits do not establish real staging behavior or a production resource budget.


## Reproduce the local resource check

Run `bun run admin:build && bun scripts/admin-resource-check.ts`. It starts isolated PostgreSQL and a separate admin process, creates only synthetic data, exercises real password/MFA login and twelve report reads, records process RSS/CPU and request latency, then stops and removes its fixture. Results are written to ignored `.local/admin/resource-result.json`. It does not contact providers or a deployed database.

On 2026-10-25, Bun 1.4.2 on macOS arm64 with 1,000 synthetic users and 5,000 requests measured approximately 82 MiB RSS at readiness and 132.5 MiB process peak, with report requests between 4 and 23 ms. PostgreSQL memory is excluded. This is local qualification, not Linux/container or staging evidence; the proposed 256 MiB container ceiling still requires staging verification.


## Verify administrator recovery

`PG_TOOLS=/path/to/postgresql/bin bun scripts/admin-restore-check.ts` performs an isolated logical dump/restore, deletes its source database, and verifies operator records, encrypted MFA state, sessions, audit data, reporting views and effective privileges. It then signs in with the original password/authenticator and a recovery code. The local check passed on 2026-10-25; this does not replace a restore using your deployed backup destination.

Keep `ADMIN_AUTH_SECRET` in independent recovery custody: the database contains encrypted MFA material, not that secret. Logical dumps do not include cluster roles/passwords, so restore their provisioning separately. Physical PostgreSQL backups include the cluster role catalog, but still do not replace the external admin secret.
