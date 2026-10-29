# Isolated waitlist production patch

Base: `2d1ade5e7c46f8350536c7eddb31dda08aa4960f`, the deployed production API revision.
Includes only the Linux waitlist module, its HTTP/CORS integration, independent migrations 0012/0013, and Better Auth 1.7.7.
AI, credits, billing, identity business logic, cloud policy and the database image remain unchanged. Migration 0011 and the grant grouping backfill are intentionally absent and must be qualified separately before a future main-line upgrade.

The independent waitlist migrations do not depend on 0011. Apply migrations before API startup, keep WAITLIST_ENABLED=false until readiness is verified, then enable only the apex website origin. Existing sessions, balances and subscriptions are preserved.
