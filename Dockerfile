FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.2 AS account
WORKDIR /app
ARG SOURCE_URL
ENV SOURCE_URL=$SOURCE_URL
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json LICENSE COMMERCIAL-LICENSING.md ./
COPY src ./src
COPY config ./config
COPY migrations ./migrations
COPY scripts/migrate.ts scripts/cloud-policy.ts scripts/notify.ts scripts/avatar-smoke.ts scripts/backfill-grant-eligibility.ts scripts/waitlist-release-check.ts ./scripts/
USER bun
RUN bun scripts/avatar-smoke.ts
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");process.exit(r.ok?0:1)'
CMD ["bun", "src/apps/api/main.ts"]

FROM account AS worker
HEALTHCHECK --interval=30s --timeout=5s --start-period=70s CMD bun -e 'const h=await Bun.file("/tmp/zephium-worker-health.json").json();process.exit(h.ready && Date.now()-h.time<120000?0:1)'
CMD ["bun", "src/apps/worker/main.ts"]

# Independent optional admin image: no provider keys, customer auth secret or AI runtime.
FROM dependencies AS admin-assets
COPY src/apps/admin/ui ./src/apps/admin/ui
COPY scripts/build-admin.ts ./scripts/build-admin.ts
RUN bun scripts/build-admin.ts

FROM oven/bun:1.4.2 AS admin
WORKDIR /app
ARG SOURCE_URL
ENV SOURCE_URL=$SOURCE_URL NODE_ENV=production ADMIN_PORT=3001
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=admin-assets /app/dist/admin ./dist/admin
COPY package.json LICENSE COMMERCIAL-LICENSING.md ./
COPY src ./src
COPY scripts/admin-migrate.ts scripts/admin-operator.ts ./scripts/
USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD bun -e 'const r=await fetch("http://127.0.0.1:3001/health/ready",{headers:{host:new URL(process.env.ADMIN_ORIGIN).host}});process.exit(r.ok?0:1)'
CMD ["bun", "src/apps/admin/main.ts"]
