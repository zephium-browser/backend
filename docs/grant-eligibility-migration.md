# Gmail grant eligibility v1 cutover

Login emails and existing email identity digests remain unchanged. Only free/welcome
eligibility groups Gmail dot/plus variants and googlemail.com under a versioned,
secret-keyed mailbox digest. Other domains, including Workspace custom domains,
keep their existing behavior. Existing grants, balances, subscriptions, and account
ownership are never merged or revoked.

For an existing database, stop all old API/worker processes, then start the new
release. Migrations apply first, and the new API completes the one-time backfill at
startup before it accepts traffic (`prepareGrantEligibility`, using the API's
**existing** eligibility secret). The backfill uses 100-account transactions, is
safe to rerun after interruption, retains only digests and claim timestamps, and
logs no email addresses. `bun scripts/backfill-grant-eligibility.ts` runs the same
operation manually. An empty new database is ready immediately. Do not run old and
new API versions together: old binaries do not observe the new grant grouping
locks.

After the new grouping has been used, rolling back to an old binary can issue
additional grants to aliases because it ignores group history. Do not restore
an old binary while signup or free grants can run. Keep those operations disabled
until a forward fix or an explicitly reviewed compatibility migration is ready;
SQL rollback alone does not preserve the new eligibility boundary.

Backfill unions retained claim history for current account emails, including their
existing email-change history, and preserves every original eligibility row.
Multiple accounts remain separate; their future free grants share one history.
The earliest anchors/claim timestamps and latest free-period end are retained.
Paid entitlements and already issued grants remain on their original accounts.

**Historical limit:** old digests cannot recover deleted accounts' email addresses
or former addresses removed by an email change. The existing exact-address markers
still block an exact repeat. When that exact Gmail address is presented again, its
history joins the new mailbox group. Until then, a previously unseen variant of
such an unavailable historical address cannot be matched retroactively. This
migration does not claim complete historical alias coverage. Future associations
survive account deletion and email changes.

Keep the eligibility secret stable. Changing it loses matching continuity for both
legacy identity history and versioned mailbox history.
