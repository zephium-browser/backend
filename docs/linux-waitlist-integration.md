# Linux waitlist: website integration handoff

## Website agent prompt

Implement a **single-step Linux release waitlist** on zephium.app's download page. There is no account signup, password, confirmation email, credit grant or payment. Form copy: **“Zephium for Linux is coming. Get one email when it's available.”** Button: **“Notify me.”** Include a privacy-policy link and make clear that submitting asks for that one Linux release notification, not a general newsletter. Do not promise a date.

Use the fixed API origin supplied by the backend operator: `https://staging-api.zephium.app` for testing, `https://api.zephium.app` after production qualification. Never accept API origins from query parameters or browser storage. No API keys or direct Resend, GitHub, Better Auth or Polar integration is needed. The website remains a static Next.js export.

```ts
const response = await fetch(`${API_ORIGIN}/v1/waitlists/linux`, {
  method: "POST",
  credentials: "omit",
  cache: "no-store",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, website: honeypotValue }),
  signal: AbortSignal.timeout(15000),
});
```

`website` is an optional hidden bot-trap field, **not the visitor's real website**. Normal submissions leave it empty. Keep its wrapper `aria-hidden`, exclude the input from tab order, disable autocomplete, and keep it out of the visible form. Do not rely on this field for security: the server also enforces limits. Do not automatically submit on mount, retry failed requests, or send any address to analytics/logging. Disable duplicate clicks while the request is pending. Support labels, keyboard submission and accessible status/errors.

On `202 {"accepted":true}`, display **“You're on the list. We'll email you when Linux is available.”** There is no second step and no immediate email. The same response is used for existing addresses and suppressed bot/allowlist submissions, so it does not disclose membership. Staging accepts only the existing test-email allowlist. A network timeout has an unknown outcome; allow a manual retry after explaining that. Do not claim mailbox verification.

Error envelope: `{"error":{"code":"…","retry_after":60},"request_id":null}`. When rate-limited, both the body and CORS-exposed `Retry-After` header provide the real wait time.

| Status/code | Behavior |
| --- | --- |
| 400 `invalid_request` | Check email/input. |
| 403 `origin_denied` | Configuration problem; never retry through another origin. |
| 404 `not_found` | Feature disabled/not deployed; keep the CTA disabled. |
| 408 `request_timeout` | Manual retry; no success claim. |
| 415 `unsupported_media_type` | Use Content-Type: application/json. |
| 413 `body_too_large` | Input too large (2 KiB total maximum). |
| 429 `rate_limited` | Honor Retry-After; disable retry until then. |
| 503 `server_busy`, `unavailable` | Temporary failure; manual retry after Retry-After if supplied. |

Test success, duplicates, throttling, invalid input, honeypot behavior, missing/disabled API, timeouts, keyboard use and absence of email logging. Mock first, then test against staging with an approved email. Keep the public form disabled until the operator confirms production is enabled. A confirmation page is **not required to collect new signups**.

### Unsubscribe page for the future launch email

Before sending the launch email, create static `/linux/unsubscribe`. The backend's launch-sender URL builder creates `https://zephium.app/linux/unsubscribe#token=<opaque-token>`. No email address appears in the URL. Extract the token into client-side memory and immediately remove the fragment with `history.replaceState`. Never store or log it. Exclude the page from analytics/replay, third-party scripts/assets and the sitemap; use `noindex` and `Referrer-Policy: no-referrer`.

Show an explicit **Unsubscribe** button. Only that click calls `POST /v1/waitlists/linux/unsubscribe` with `{"token":"…"}`, the same fixed origin and cookie-free request options above. Success: `200 {"unsubscribed":true}`. Invalid proof: `400 invalid_or_expired_token`. Replays are safe; an old link cannot delete a later re-subscription. GET never mutates membership. Do not expose email-only removal or list queries publicly.

Existing staging emails used `/linux/confirm`. The backend retains `/v1/waitlists/linux/confirm` for those unexpired legacy tokens: explicit POST with `{token}` returns `200 {confirmed:true}`. If that legacy page has already been implemented, keep it compatible for old confirmation/unsubscribe links. Do not route new signups through it.

## Backend behavior and rollout

- `WAITLIST_ENABLED=false` remains the default. `WAITLIST_WEB_ORIGIN` is the exact HTTPS website origin, default `https://zephium.app`. Browser Origin is required; cookies and Authorization are rejected.
- New subscriptions store `subscribed_at` and consent version `linux-release-single-opt-in-v1`. `confirmed_at` stays null because ownership was not verified. Normalized email is unique; duplicate submissions preserve membership ID and original consent time. No provider API call occurs during signup, and it does not consume the OTP email-delivery budget.
- Limits: 5 submissions/network/15 minutes (IPv6 /64), 3/email/15 minutes, 1/email/minute, 30 global requests/minute and 1,000/day. Two requests per API process may be in flight; bodies are capped at 2 KiB and five seconds. Counters are database-backed and store HMAC identifiers, not raw IPs.
- Global setting names are now `WAITLIST_REQUESTS_PER_MINUTE` and `WAITLIST_REQUESTS_PER_DAY` (replacing the original `WAITLIST_EMAILS_PER_*` names). Limits count attempts, including duplicates and honeypot/allowlist suppression. These controls reduce abuse; they do not prove ownership or stop a determined distributed attacker. Turnstile can be added if observed abuse warrants it.
- `SIGNUP_EMAIL_ALLOWLIST` continues to restrict staging membership independently of cloud account signup. Suppressed submissions return generic 202 and create no row.
- Migration `0013_linux_waitlist_single_opt_in.sql` is additive and preserves records. Previously confirmed members stay subscribed. Legacy unconfirmed addresses are **not** silently enrolled; they may submit the new form or redeem an unexpired old token. Expired legacy pending records are cleaned up as before. Active opt-ins remain until unsubscribe or deliberate release-list cleanup.
- Unsubscribe proofs are domain-separated HMACs bound to random membership IDs. AUTH_SECRET rotation invalidates those links; preserve that secret for recovery. Raw proof tokens are not returned by signup or admin export.
- Admin reporting adds `subscribed` and `items[].subscribed_at`. `confirmed` remains the actual legacy verified count; `pending` means legacy unconfirmed records, excluded from export. CSV uses `email,subscribed_at` and protects against spreadsheet formulas. The optional view grant and existing Cloudflare/password/MFA protections remain required. The new UI hides this section until its migrated view is accessible.
- The launch-announcement sender is not part of this change. Before that campaign, implement per-membership unsubscribe links, check current membership immediately before delivery, deduplicate sends, handle bounces/complaints, and remove stale exports. Do not send a campaign as part of testing.

The implementation must be tested on staging before production. The customer production release still has earlier, separately gated API changes; do not promote unrelated changes blindly. Deployment qualification is separate from local/CI checks.

## Production website contract details

Allowed browser origin is exactly `https://zephium.app`, not `www`. For allowed origins, every application response (including errors and admission failures) includes `Access-Control-Allow-Origin`, `Vary: Origin` and `Access-Control-Expose-Headers: Retry-After`, never `Access-Control-Allow-Credentials`. Preflight permits only `POST, OPTIONS` and `Content-Type`, with a 600-second max age. Disallowed origins get no allow-origin header. Responses created outside the application (for example Cloudflare or proxy failures) are outside this guarantee.

Unknown/malformed signatures return HTTP 400 `invalid_or_expired_token`; missing, non-string or oversized token fields return HTTP 400 `invalid_request`. A correctly signed token whose membership was already deleted returns HTTP 200 `{"unsubscribed":true}`, preserving idempotency without revealing membership. Unsubscribe tokens do not have a time expiry; rotating the signing secret invalidates them. GET never unsubscribes.

Stored signup fields: random UUID `id`, normalized `email`, `created_at`, `subscribed_at`, and `consent_version`. New single-step signups have null `confirmed_at`, `confirmation_hash` and `expires_at`; those columns support legacy confirmations only. The honeypot value is not stored. No raw IP, user agent or browsing content is stored by this module. Separate rate-limit rows store a keyed HMAC identifier, counter and expiry; expired rows become eligible for hourly cleanup one hour after their window expires. Email/network windows are at most 15 minutes; the global daily counter lasts a day and contains no address/IP identifier.

An authenticated unsubscribe deletes the live waitlist row immediately. Active subscriptions currently remain until unsubscribe or an explicit campaign cleanup; there is **no automatic deletion after launch or sending**, because the launch sender is not implemented. Do not promise a post-launch deletion deadline yet. Deleted rows may remain in encrypted database backups until backup retention expires. Confirm the deployed backup policy separately before publishing an exact backup-retention duration. Do not reuse stale CSV exports after unsubscribe.

The future sender must use `waitlistUnsubscribeUrl` for its body link and `waitlistUnsubscribeHeaders` for the `List-Unsubscribe` header. The URL is the website fragment link above. This supports the human-click flow described by [RFC 2369](https://www.rfc-editor.org/rfc/rfc2369.html); it does **not** claim [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html) one-click POST support. No `List-Unsubscribe-Post` header is emitted: automatic email-client POST would need a separate signed endpoint and DKIM-covered headers, which must be built and qualified before advertising it. No release email is sent by signup or by this rollout.
