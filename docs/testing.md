# Test the backend

Use the pinned Bun 1.4.2 runtime. After installation, `node_modules/.bin/bun` avoids accidentally using a different global version. Integration tests start disposable PostgreSQL 18.4 and inject email, billing and model providers; ordinary test runs need no live API keys and make no real purchases or hosted model requests.

## Everyday checks

```sh
bun install --frozen-lockfile
bun run check
bun scripts/cloud-policy.ts validate config/cloud.json
bun scripts/cloud-policy.ts validate config/self-host.json
bun scripts/cloud-policy.ts validate config/staging.json
```

Run only the relevant tests while changing behavior, then the full check before release review. A name filter works across the integration suite:

```sh
bun test --test-name-pattern "refund" --timeout 60000
```

The checks cover identity/session boundaries, billing ownership and recovery, grants/reservations/settlement, native JSON/SSE/transcription, policy activation and spending controls. Keep fixtures under `tests/support` and integration behavior under `tests/integration`. See [desktop integration](desktop-integration.md) for the contract the native app must exercise.

## Database, proxy and container checks

| Check | Command | Requirement |
| --- | --- | --- |
| Native dump/drop/restore | `bun scripts/restore-check.ts` | Matching `pg_dump`/`pg_restore`; set `PG_TOOLS` to their directory if needed |
| Local HTTPS/SSE/privacy | `bun scripts/proxy-smoke.ts` | Local Traefik binary; set `TRAEFIK` when required |
| Encrypted pgBackRest/WAL restore | `bun scripts/container-check.ts` | Working Docker daemon |
| Self-host stack and private roles | `bun scripts/container-stack-check.ts` | Working Docker daemon |

The native restore check destroys its disposable source database before restoring a dump and comparing records. It also proves a restored refund cannot be resurrected by stale paid data and unknown provider exposure survives deletion of its originating account. Container scripts use disposable resources; neither proves that the real backup bucket, deployed secrets or Coolify routing work.

The GitHub **Check** workflow runs static checks, tests, policy validation and both container checks on Linux. **Build deployment images** depends on that workflow and publishes reviewed revision images only from `main`. Read the workflow result, not just the presence of a workflow file.

## Qualify the deployment separately

Use [staging setup](staging.md) for owner configuration and [operations](operations.md) for recovery. Record actual Resend delivery, Polar sandbox payment/refund behavior, native model metering, public TLS/SSE, independent encrypted restore and desktop flows. Green repository checks do not establish those results or a supported user capacity.

Deployment qualification records (release revisions, live provider checks, restore drills) are kept in private operator records, not in this public repository.
