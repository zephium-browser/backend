# Desktop integration handoff

This is a contract for a separate native desktop implementation. It does not imply a deployed backend, enabled hosted models, live prices, or completed desktop changes. Use the environment's exact API origin and the schemas in [api.md](api.md) and [openapi.json](openapi.json).

## Connection and account

Fetch unauthenticated `GET /v1/client-config` before showing hosted features. Cache by its strong ETag for up to 300 seconds and handle 304. It supplies `cloud_enabled`, `billing_enabled`, `signup_open`, minimum client version, and an optional notice. Treat these as service hints; authenticated catalog and usage responses still decide what an account can use.

For native sign-in, send `POST /api/auth/email-otp/send-verification-otp` with `{email,type:"sign-in"}`, then submit `{email,otp,device?}` to `POST /api/auth/sign-in/email-otp`. A new account can be created by this same flow when sign-up is open. The send response is deliberately generic; prompt for a six-digit code rather than assuming email was delivered. The optional device label appears in session management. There is no password or OAuth route.

Read `set-auth-token` from the successful sign-in response. Keep this signed opaque bearer in the OS credential vault under the exact API origin and environment, with Rust/native code owning retrieval. Send `Authorization: Bearer <token>` only to that origin. Never put it in a webview, ordinary app database, localStorage, telemetry, crash report, custom endpoint, or direct BYOK provider call. An account can be signed into more than one Zephium origin; keep tokens separate. For 401 unauthorized, clear only the matching vault entry and sign in again. A 401 reauthentication_required means a sensitive action needs a fresh sign-in; it does not itself mean the existing session was revoked. Expose caller-owned session list/revocation and logout controls.

`GET /v1/account` includes nullable name; `PATCH /v1/account` edits it. Account deletion uses `POST /v1/account/deletion/code` followed by `POST /v1/account/deletion` with the emailed OTP. Email change uses `POST /v1/account/email/code` and `PATCH /v1/account/email` with the new address and OTP; both steps require a session created within ten minutes, and completion revokes sessions. Do not offer these as a single unverified mutation. `GET /v1/account/export` provides safe account, billing, usage, history URL, and session data. Export uses the same configured billing/capability summary as `GET /v1/billing`, without fetching offers or requiring Polar availability. A verified email change also queues an idempotent update of an existing Polar customer’s contact address; that background update does not change the account ID or rewrite historical invoices. The email-change response confirms the local verified change and session revocation, not completion of that provider update.

## Billing and catalog

When billing is disabled, `GET /v1/billing` gives `offers:null`, `paid:false`, and subscription status `not_applicable`; hide purchase and portal actions. When enabled, offers contain Polar-sourced `product_name` and `{amount_minor,currency}` for subscriptions and top-ups. Display those prices exactly, with the selected plan/interval or top-up ID; never synthesize a currency price from credits. `POST /v1/billing/checkout` returns a caller-bound Polar URL. After returning from checkout, call `POST /v1/billing/refresh`; it is limited to six per minute per user and can reconcile a paid top-up immediately. Handle 409 `no_billing_account` from portal as a customer with no Polar account yet.

Fetch `GET /v1/models` and `GET /v1/usage` after authentication. The catalog includes `defaults` for lead/page/light/decision/transcribe, a per-model `available` flag, description, tier, policy price strings, and byte/search/timeout limits. A listed locked model remains visible for explanation but must not be sent to generation. If a default is null, let the user choose an available model or disable that role. The default production policy starts disabled; the separate staging template is not deployment or availability proof.

Display credits by dividing decimal-string accounting-unit values by `credit_units` (`"10000"`), while retaining integer strings for accounting. Keep `unit_scale` compatibility handling separate; do not divide by it to display credits. Show included `allowance.*_units`, welcome `bonus_remaining` and expiry, purchased balance, held units, period end, and optional daily cap distinctly. Use `GET /v1/usage/requests` with its opaque cursor for caller-owned history, at most 50 entries per page; use the per-request receipt when generation outcome is uncertain. Treat a charge as final only in `settled` state.

In self-hosted mode, policy `selfHostedPlan` can grant a configured plan without Polar. Billing still reports no Zephium purchase flow while `capabilities.hostedAI` can be true. Keep hosted API keys server-side; catalog and usage responses must never be treated as credential sources. Direct BYOK calls remain separate on the desktop.

## Generation and stream accounting

Send provider-native bodies to the paths in [api.md](api.md). Respect each available model's capability flags and `limits`. Hosted native search is only through supported OpenAI or Anthropic tools. There is no standalone hosted search endpoint. Preserve native JSON or SSE content handling. The gateway does not store prompt or output content.

Generate one UUID `Idempotency-Key` for each logical generation and retain it with the call. Record `X-Zephium-Request-Id`, policy revision, and JSON `X-Zephium-Usage` when present. Local admission estimates a conservative credit hold from bytes, request structure, media context, output, and search ceiling; text-only calls do not make a provider token-count preflight call; embedded images on OpenAI/Anthropic/Google do. The final bill uses reported actual usage. Never show a hold as a settled charge.

For SSE, keep consuming the raw byte stream until EOF after the provider's terminal event (for example, `response.completed`, `message_stop`, or `[DONE]`, depending on the protocol). The backend may append a `: zephium ...` comment with request ID and settled/pending/error accounting. Parse it separately from provider text and preserve provider chunks. The comment is best effort and can be missing after a disconnect. Consult `GET /v1/usage/requests/{id}` when it is absent or pending; do not replay a possibly dispatched generation automatically. If the outcome remains uncertain, ask the user before a new logical call. A 409 on the same idempotency key will not replay output.

Handle 401 by error code: unauthorized requires a new scoped session, while reauthentication_required asks for a fresh sign-in for the sensitive action. 402 means credits or daily cap are unavailable; 429 covers admission, concurrency, or provider limits. Honor `Retry-After` when present. Error JSON has a nullable `request_id`; use a real ID to inspect the receipt. Keep custom API origins and their tokens isolated from each other and from the default Zephium origin.

## Release contract changes — 2026-10-18

- `POST /openai/v1/audio/transcriptions`: Bearer plus required UUID Idempotency-Key, multipart model(row ID), response_format=json, optional ISO639-1 language, and file. PCM16 little-endian mono WAV, positive sample rate <=16000Hz, duration<=240s, total multipart<=min(row max_request_bytes,8MiB). Returns `{text}` (empty is valid), X-Zephium-Request-Id, X-Zephium-Policy-Revision and X-Zephium-Usage. Response<=64KiB. Backend deadline85s includes upload; do not retry the take automatically.
- Catalog adds transcribe role/default, optional price.per_million_tokens.audio_input and price.per_audio_minute. Voice limits add max_audio_duration_ms=240000 and max_response_bytes=65536; max_duration_ms is at most85000.
- `GET /v1/usage`: **period_end is now nullable**. One-time signup allowance has allowance.renews=false, allowance.expires_at=null, period_end=null. Show remaining trial allowance, never a fabricated renewal date. No separate welcome grant in the hosted policy. Also returns free_usage_paused and purchased_usage_available; purchased credit remains usable after the free subsidy pool is exhausted without unlocking Pro rows.
- History/receipt records add nullable funding_source (`allowance`, `purchased`, `mixed`); null covers pre-reservation/legacy rows. Make purchased funding visible to users.
- `GET /v1/client-config` adds signup_mode (`open`, `allowlist`, `closed`). For invited staging signup use signup_open=true with signup_mode=allowlist. The email allowlist itself is never public; unapproved sends still receive generic202.
- `POST /v1/billing/checkout` and portal use fixed `https://zephium.app/billing/return`. The desktop sends no return URL and polls refresh at <=6/min. Website owns the static page.
- Auth delivery failures now return503 email_unavailable with real Retry-After;202 is generic acceptance, not proof that the recipient received a message. Previously issued SHA256-only sign-in codes are invalid after the keyed-hash upgrade; request a fresh code.

New/relevant stable errors (same `{error:{code,retry_after?},request_id}` envelope):

| HTTP | Code | Desktop behavior |
| --- | --- | --- |
| 400 | invalid_audio | Recording is malformed/truncated; record again |
| 415 | unsupported_audio_format | Unsupported audio encoding/channels/sample rate |
| 422 | audio_too_long | Record at most four minutes |
| 403 | plan_required | Offer upgrade for this known plan-gated model |
| 429 | free_usage_limit_reached | Free subsidy temporarily exhausted; show reset/retry and purchased/BYOK options |
| 429 | usage_confirmation_limited | Too many unresolved calls; wait for the indicated UTC reset |
| 503 | cloud_budget_exhausted | Hosted spending safety stop; daily stop includes Retry-After, total stop needs operator action |
| 503 | email_unavailable | Email provider/delivery capacity unavailable; retry after indicated delay |
| 400 | context_limit_exceeded | Reduce input/history before retrying |

Existing invalid_request400, body_too_large413, insufficient_credits402, daily_limit_reached402, idempotency409, provider errors and401 rules continue. New local429s include Retry-After. A desktop retry cap of15min is a polling cap, not an earlier server reset. Ambiguous408/499 provider failures retain exposure. No provider payloads/OTPs are logged or persisted. No desktop code was changed in this backend handoff.

The modular refactor preserves HTTP paths and response shapes. Account mutations now revalidate the session after transaction lock waits, so a revoked/expired bearer can return401 even when it was valid at request arrival. Signup finalization failures leave no partially committed account/session; retry the normal email-code flow.

## Pro / Max subscription changes — additional desktop work

The initial checkout contract is unchanged. Always send the selected `plan` once more than one plan has the same interval. For an existing paid subscription, use the preview/confirm/receipt endpoints in [api.md](api.md#subscription-plan-changes); `409 subscription_change_required` must not trigger another checkout. Show the recurring price, immediate-charge **estimate**, and whether the change is immediate or at renewal before asking the user to confirm.

An account under billing review receives 403 `billing_review_required` for new checkouts and upgrades as well as hosted usage. Show a support/review action instead of another purchase attempt. Downgrades, portal cancellation, export and existing operation receipts remain available; an upgrade queued before review may finish as `failed` with that error before dispatch. Already-dispatched changes still reconcile.

A fresh sign-in may be needed before confirmation. Retain the returned quote/operation ID locally so polling can resume after app restart; it is account-scoped, contains no session credential, and must never be sent to a different API origin. Retry confirmation with the same quote ID after connection loss. Do not interpret HTTP 202 as a successful charge. On `uncertain`, show a pending billing change and keep polling at a modest interval; do not offer a second payment attempt. On `failed`, show its stable error code, refresh billing, and obtain a new quote only after a new user confirmation. On `applied`/`scheduled`, refresh billing and usage; a downgrade retains the current plan until renewal.

The repository implementation and local payment-recovery tests do not establish live Polar behavior. This contract is additional work beyond the previously completed desktop handoff and must be qualified against sandbox before public billing is enabled. Production allowance amounts, annual prices and provider catalog rows remain operator-configured.

## Purchased balance display — additional field

Use `GET /v1/usage.purchased_balance` for a monetary display: `{currency:"USD",amount:"11.345677"}` or null. The amount is an exact decimal string for available usage credit, excluding holds and expired/revoked credit. Show plan allowance as a percentage independently. Do not label `purchased_remaining / unit_scale` as USD when the display field is absent/null; older deployments and policies without a currency designation do not make that promise. This is usage credit, not a refundable cash balance. Currency designation must be explicitly activated in the environment's reviewed policy; adding the field to the repository does not change existing staging credit semantics.

## Staging handoff — 2026-10-21

Use `https://staging-api.zephium.app`. Application source `36140fb084082c874686a495627271f32b8b5060` and policy revision **5** are live, with Cloud AI and Polar sandbox billing enabled. The minimum client version is `1.0.0-beta.2`. Signup remains restricted to the owner's approved test addresses; obtain the appropriate test account from the owner. Production remains separate and unqualified. Live verification records are kept privately by the operator.

| Catalog ID | Roles | Access | Default |
| --- | --- | --- | --- |
| `gpt-6-luna` | lead, page, light; native search, tools and vision | free / pro / max | lead, page, light |
| `gpt-4o-mini-transcribe` | transcribe | free / pro / max | transcribe |
| `gpt-4o-transcribe` | transcribe | pro / max | no |

Read the catalog and its per-model limits instead of hard-coding this table. There is no hosted decision-model default or Max-exclusive frontier row in this staging policy. No Anthropic beta headers are forwarded; this milestone did not live-qualify the other providers.

Staging fixtures: Free has a one-time 250-credit allowance (2,500,000 units) and no renewal or welcome bonus; Pro has 2,000 credits per month (20,000,000 units); Max has 10,000 per month (100,000,000 units). Polar subscription offers are Pro USD20/month and Max USD100/month **plus applicable tax**. The sandbox organization default is now Exclusive; the configured product prices inherit it. The packs below expire after 365 days. Allowance sizes and model tariffs remain provisional fixtures. Existing grants keep their original amounts; this deployment does not refill or resize them. Spend the earliest-expiring eligible grant first. `purchased_balance` now reports an exact USD usage-credit amount under the activated policy. There is no metered overage.

| Top-up ID | Base price, before tax | Credits | Accounting units |
| --- | --- | --- | --- |
| `credits-5` | USD5 | 500 | `5000000` |
| `credits-10` | USD10 | 1,000 | `10000000` |
| `credits-25` | USD25 | 2,500 | `25000000` |
| `credits-50` | USD50 | 5,000 | `50000000` |
| `staging-topup` | USD1 | 100 | `1000000` |

The USD1 pack remains a staging diagnostic fixture. Read current IDs, names, prices and units from billing offers; this table does not authorize hard-coding the picker. Tax charged by Polar does not mint additional credits. Pack creation and live offer projections were verified; new paid checkouts for these four products remain part of the desktop sandbox pass.

Keep these client behaviors in the final UI pass:

- Preserve the received checkout link for retrying the same checkout. Duplicate subscription creation can return `checkout_in_progress`; an existing subscription returns `subscription_change_required`. Use the preview/confirm/receipt flow for changes.
- After returning from checkout/portal, refresh billing at no more than six calls per minute. A return page or HTTP202 operation receipt alone does not establish a successful purchase/change.
- Display upgrade charges as estimates, without calculating or adding tax locally. Retain the quote/operation ID; repeated confirmation resumes that operation. A scheduled receipt records the request outcome; refresh current billing/usage and respect later cancellation or provider changes.
- Handle 401 `reauthentication_required` with fresh sign-in for sensitive mutations. Preserve separate API-origin vault entries. Email change and deletion revoke old sessions.
- Handle 403 `billing_review_required` on usage, new checkout and upgrades with a support/review state, not another purchase retry. Account export, portal management and downgrades remain usable. The owner has a deliberately reviewed test account for this case.
- Display one-time allowance percentages without a reset date when `allowance.renews:false` and `period_end:null`. A reused email may legitimately have zero signup allowance. Top-ups never unlock a higher model tier.
- Verify native text/voice receipts, request IDs, SSE trailers, idempotency handling, plan-required/insufficient-credit/daily-limit responses, and Retry-After using the existing API shapes. The additive credit display and subscription metadata fields are described below; provider-native response bodies are unchanged.

Staging spending ceilings remain USD50 total, USD10 per UTC day and USD5 daily free subsidy. Effective signup protection is three new accounts per IP/day with disposable-email blocking; the allowlist remains enabled. Do not run deliberate spend-exhaustion or capacity campaigns.

## Credit decision — 2026-10-20

The approved conversion is 10,000 accounting units per credit, with 100 credits per USD1 of usage-credit face value under a USD-denominated policy. The additive `credit_units:"10000"` field is provided on usage, model price, billing offers, usage-history envelope, individual receipt and settled SSE trailer. Native provider responses and currency `amount_minor` fields are unchanged. Do not round individual charges to a whole credit.

Provisional policy-4 fixtures are Free250 credits once (2,500,000 units), Pro2,000/month (20,000,000), Max10,000/month (100,000,000), and USD1 top-up100 credits (1,000,000). Existing grants retain their original amounts; there is no automatic trial refill. Retail model tariffs can include margin independently of provider cost safeguards. Final allowance sizes and margin await the measured cost review.

Policy 4 was explicitly registered and deployed on October 21 after the legacy checkout windows expired and fresh reconciliation confirmed no outstanding purchased balance or pending billing work. The old USD1/2,000,000-unit offer is retired. Its historical grant and request snapshots remain unchanged; do not reinterpret an old receipt using the new offer.

For cost reconciliation, account usage includes all hosted calls charged to that account, regardless of lead/page/light role. The ledger has no Work-run or role labels. Supply only request IDs and a UTC range for a role-specific comparison; never send prompts, page content or outputs. Customer charges, provider-cost estimates and actual provider invoices are distinct. Reasoning tokens are already included in output and must not be charged twice.

## Additional account/billing confirmations — 2026-10-20

Billing and refresh now include nullable `subscription.plan` and `subscription.interval`. The interval is `monthly` or `yearly` for a recognized, fresh, active paid subscription, including cancellation through the paid period. Both fields are null when no paid subscription applies or billing is disabled. Continue using `usage.plan` for effective model access; annual billing can still have monthly allowance renewal.

Invite-only OTP sending remains generic202. Uninvited redemption returns **401 `invalid_code`**, uniformly for existing and nonexistent addresses; it does not use `signup_closed`/`signup_disabled`. Display the invite-only notice from `client-config.signup_mode:"allowlist"` and retain a generic verification failure. Existing allowed users may sign in even when new signup is closed.

Settlement uses provider-reported actual usage with the request's snapshotted customer tariff, capped by the authorized reservation, and releases unused holds. Provider-cost accounting uses its separate rate snapshot. A regression reserves110 customer units and95 provider-budget units, then settles actual usage to9 customer units and4 provider-cost units, with zero remaining holds/allocations. Later policy changes and duplicate settlement cannot reprice or recharge that request. The historical equality between customer debit and conservative provider estimate came from identical configured tariffs, not from retaining the reservation. These staged tariffs remain fixtures until final retail pricing is approved.

## Account avatars

The [avatar contract](avatar-contract.md) defines the implemented upload/delete/private image endpoints, limits, error codes, export and client caching behavior. Live on staging in application revision `36140fb`, with policy 5 unchanged. Authenticated HTTPS checks passed for upload/re-encoding, private fetch and conditional 304, export, replacement and deletion; anonymous access returned 401. The test image was removed and the temporary session revoked. `GET /v1/account` adds nullable `avatar_url`; export embeds the processed image. Rust must fetch the protected versioned URL using its bearer and provide only image bytes to the UI. Cancel a pending upload before removal, revalidate private cached bytes and clear local avatar caches on sign-out.

## Checkout tax clarification — 2026-10-21

Before the sandbox tax default changed, the checked Polish Pro checkout and paid order had a USD20 total: USD16.26 net plus USD3.74 included tax, with no discount or proration. The product lists USD20 and inherits tax behavior; the effective checkout reported `inclusive`. This result does not establish every country's treatment or a production tax configuration. Display the product offer as its listed price, and let Polar present the final tax breakdown and total. Never add a tax line already included in the total.

The intended production pricing is tax-exclusive: Pro USD20/month and Max USD100/month before applicable tax. This decision is now mirrored by the sandbox Exclusive default; historical orders are unchanged. Production has not been configured. Label base offers accordingly; Polar determines the final customer-specific tax and total. Tax added at checkout does not increase the quantity of credits purchased.

The corrected quote contract returns `amount_due_estimate.tax_excluded:null` and `tax_calculation:"not_calculated"`, including when reading an older stored quote. The estimate uses product amounts and does not perform a customer-specific tax calculation. Show a generic estimate with the final amount determined by Polar; never label it definitively tax-exclusive or add tax locally. The prior `true` value was an incorrect claim, not a billing instruction. Amounts, quote IDs, confirmation semantics and actual Polar charges are unchanged. This correction is live in staging application revision `c3c0641`, with policy 5.

Production tariff addition: `/v1/models` may include `price.long_context` with `input_tokens_above`, `per_million_tokens`, and `per_search_call`. Above that input-token threshold, those rates apply to the whole request, including output. Cache reads and writes count toward the threshold; output and reasoning do not. Existing base-price fields are unchanged. Credit debits and receipts remain authoritative, and the desktop must not infer a debit from an admission reservation. OpenAI extended cache lifetimes return the existing `extended_cache_not_supported` error.


Image-reservation correction: provider-native routes and request bodies are unchanged. Image calls on OpenAI/Anthropic/Google add a bounded native token-count request before generation. Only customer escrow is refined; provider-cost safety reservations and search exposure remain conservative. New `429 credit_reservation_pending` means enough unspent credit exists but other calls currently hold it: honor `Retry-After` (1–60 seconds), show a temporary busy/retry state, and do not show an upgrade/out-of-credit prompt. A failed image count returns `503 token_count_unavailable` with `Retry-After: 30`; no generation or debit occurs. Upstream counting throttling uses existing `429 provider_rate_limited`, respecting numeric Retry-After up to 900 seconds. Malformed counts return 502; rejected input returns 400/413/422. Existing receipt, stream trailer, usage, pricing and catalog shapes are unchanged.

For `credit_reservation_pending`, `token_count_unavailable`, or `provider_rate_limited` before dispatch, retry with the same Idempotency-Key after Retry-After. Only a released attempt with zero reserved/charged units and no dispatch or accounting allocation can be retried. The rejected receipt remains readable; the retry gets a new request ID. An attempt that reached the provider is never automatically reopened.
