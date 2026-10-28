# Linux waitlist: website integration handoff

Implementation contract. This change is not evidence of a deployed endpoint. Keep the website form disabled until the backend operator confirms the target environment is enabled and a real confirmation round trip passes.

## Website agent prompt

Add a Linux release notification form to zephium.app's download page. The backend implementation is in zephium-browser/backend; use its public API, not GitHub, Better Auth, Polar, or Resend directly. Do not add website account/authentication flows or a server-side key. The website remains a static Next.js export.

Use an explicit build-time API origin: production `https://api.zephium.app`, staging `https://staging-api.zephium.app`. Never derive the API origin from a URL parameter, email link or browser storage. Local tests should mock the API; an HTTPS preview origin must be explicitly allowed by the backend operator.

Form copy: **Zephium for Linux is coming. Get one email when it's available.** Input: email. Button: **Notify me**. Include a privacy-policy link and explain this is a Linux release notification only; no account or subscription is created. Do not claim a release date.

On submit, call:

```ts
const response = await fetch(`${API_ORIGIN}/v1/waitlists/linux`, {
  method: "POST",
  credentials: "omit",
  cache: "no-store",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
  signal: AbortSignal.timeout(15000),
});
```

`202 {"accepted":true}` means **Check your email to confirm your Linux notification.** It does not prove delivery or disclose whether the address was already registered. Do not automatically retry or send on page load. Disable duplicate clicks while pending and offer a manual retry after the displayed cooldown. Support keyboard submission, field labels, focusable errors and an accessible status announcement. Do not send the address to analytics or logging.

Create a static **`/linux/confirm`** page that works on direct load and reload. Exclude it from analytics/error replay entirely, add `noindex` and `Referrer-Policy: no-referrer`, and omit it from the sitemap. No third-party scripts/assets on this page. Update the privacy description to cover the email address and confirmed opt-in for the Linux release notification, independently from Zephium accounts.

The email links use fragments, not query strings:

- Confirmation: `https://zephium.app/linux/confirm#token=<opaque-token>`
- Removal: `https://zephium.app/linux/confirm#action=unsubscribe&token=<opaque-token>`

Read the fragment once in client-side memory; reject duplicate/missing parameters and unsupported actions. Immediately remove the fragment with `history.replaceState` while preserving the page path. Never put the token in cookies, local/session storage, query strings, logs, telemetry, error messages, or links to another page. Do not render it. A page refresh without a token should explain that the user can reopen the email link.

Show **Confirm Linux notification** or **Unsubscribe**, and only send after an explicit button click. Do not auto-submit on mount: email security scanners must not change membership by following a link. Confirmation tokens expire in 24 hours; a resend replaces the earlier confirmation link. Unsubscribe links remain valid for that membership; deleting and rejoining creates a new membership.

Confirmation:

```text
POST /v1/waitlists/linux/confirm
Content-Type: application/json
{"token":"<fragment token>"}
→ 200 {"confirmed":true}
```

Removal (also removes an unconfirmed request):

```text
POST /v1/waitlists/linux/unsubscribe
Content-Type: application/json
{"token":"<fragment token>"}
→ 200 {"unsubscribed":true}
```

Use the same fixed API origin, `credentials: "omit"`, timeout, no-store and explicit-click handling as the signup form. Never send Authorization, a customer bearer, or custom Origin headers; the browser supplies Origin. These routes do not use cookies. A valid confirmation replay before expiry is idempotent; removal is idempotent. GET never changes membership.

Error envelope: `{"error":{"code":"…","retry_after":60},"request_id":null}`; `retry_after` is present only when applicable. The backend also exposes `Retry-After` through CORS.

| Status/code | Website behavior |
| --- | --- |
| 400 `invalid_request` | Ask the user to check the email/input. |
| 400 `invalid_or_expired_token` | Link is invalid/expired; offer the download-page form to request a fresh email. |
| 403 `origin_denied` | Configuration problem; show unavailable, never attempt another origin. |
| 404 `not_found` | Feature disabled/not deployed; hide the signup CTA or show temporarily unavailable. |
| 408 `request_timeout` | Manual retry; do not claim success. |
| 413 `body_too_large` | Input too large. |
| 429 `rate_limited` | Honor Retry-After and disable resend until then. |
| 503 `email_unavailable`, `server_busy`, `unavailable` | Temporary failure; manual retry after Retry-After if provided. |
| Network timeout | Delivery outcome is unknown; offer a manual retry, without claiming that signup failed or succeeded. |

Test with mocks first: 202, all errors, expired links, malformed fragments, missing token, deliberate click requirement, no token/address logging, and double clicks. After the backend operator enables staging, test real delivery, explicit confirmation, confirmed-only admin reporting, unsubscribe, and re-subscribe. Keep production disabled until that passes. Do not send release announcements as part of implementation/testing.

## Backend/operator configuration

- `WAITLIST_ENABLED=false` by default. The API checks the table exists before starting when enabled.
- `WAITLIST_WEB_ORIGIN=https://zephium.app` is the exact browser origin allowed for these routes and the base of the email links. The fixed path is `/linux/confirm`. This origin is separate from account authentication's `TRUSTED_ORIGINS`.
- Staging's existing `SIGNUP_EMAIL_ALLOWLIST` also restricts waitlist delivery. Non-allowed addresses receive generic 202 without storage or mail. Waitlist availability does not depend on `SIGNUP_OPEN`, cloud billing or AI policy.
- Defaults: 1 request/email/60 seconds, 3/email/15 minutes, 5/network/15 minutes (IPv6 /64), 30 total requests/minute, 1,000/day, two concurrent waitlist requests per API process. Counts include accepted/suppressed requests and failed sends; these are abuse ceilings, not promised sending throughput. Per-minute/day global ceilings are configurable with `WAITLIST_EMAILS_PER_MINUTE` and `WAITLIST_EMAILS_PER_DAY`. The shared transactional-email ceiling still applies.
- Confirmation bodies are limited to 2 KiB and five seconds. Delivery uses the existing Resend key/sender, an eight-second timeout, no automatic retries, and a bounded provider-failure cooldown. Confirm domain alignment and disable link/open tracking at Resend before the live test. No new provider keys are required.
- Pending requests are removed in hourly worker cleanup, in batches of 1,000, seven days after the latest request. Confirmed consent is kept until unsubscribe or a deliberate release-list cleanup. The release-announcement campaign is not implemented or sent here. AUTH_SECRET rotation invalidates existing unsubscribe signatures; preserve it in recovery custody.
- Email uniqueness uses trimmed lowercase addresses, without merging Gmail aliases. Tokens are stored only as SHA-256 hashes; raw IPs are not stored. Unsubscribe signatures are domain-separated HMACs bound to a random membership ID. No account/credit/billing mutation occurs.

## Migration and deployment boundaries

`migrations/0012_linux_waitlist.sql` creates the independent table and an admin projection with no proof tokens. Do not edit old migrations. This checkout also contains earlier, separately gated customer-API changes (including grant-eligibility backfill and credit reservations). **Do not promote the whole checkout blindly to production to enable this feature.** Verify those prerequisites, or prepare an isolated release from the currently deployed customer revision. Keep waitlist disabled until the website page exists and staging is qualified.

The admin endpoint is `GET /api/waitlists/linux?cursor=…` on the admin origin, behind Cloudflare Access, operator authentication and MFA. It returns `available`, `confirmed`, `pending`, at most 200 confirmed `items` (`id`, `email`, `confirmed_at`) and `next_cursor`. The panel exposes counts and CSV export. Exports contain confirmed opt-ins only, guard spreadsheet formulas and are bounded to 100,000 addresses in the browser; the API stays paginated for larger exports. List membership can change during export—recheck opt-in before any later campaign sends.

Deploy the new admin image before granting `SELECT` on `admin_report_linux_waitlist` to `zephium_admin_report`, using the updated reviewed `deploy/postgres/admin-roles.sql`. An older admin image correctly rejects newly added reporting privileges at startup. The public API migration does not automatically widen the existing admin role. Before table/grant availability, the new panel hides the section. Waitlist reads use the existing bounded audit log, `action=users`, `target_id=linux-waitlist`; they never grant credits or call an email provider.
