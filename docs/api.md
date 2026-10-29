# Backend HTTP contract

This describes repository behavior. It does not establish a live endpoint, provider connection, product price, or enabled hosted model. Use the configured API origin for the chosen environment. JSON requests use `Content-Type: application/json`. Requests have an 8 MiB HTTP body limit, and models may set a smaller limit; `/v1/systemone` is capped at 80 KiB. Authenticated responses are `Cache-Control: no-store`.

Application errors use `{"error":{"code":"..."},"request_id":null}`. A generation error has a UUID `request_id` once admission created a request; `retry_after` appears inside `error` and in `Retry-After` when supplied. Branch on status and stable code, never provider error text. Browser Origins must match `TRUSTED_ORIGINS`; cookie-bearing mutations require an Origin. Native bearer calls need no browser Origin.

## Public status and identity

`GET /health/live` checks the process; `GET /health/ready` checks PostgreSQL. Neither proves provider availability. `GET /v1/client-config` is public and requires no database access. Its JSON contains `schema_version:1`, `cloud_enabled`, `signup_open`, `min_client_version`, `billing_enabled`, and a nullable `notice:{id,text,severity}`. The response is cacheable for 300 seconds with a strong `ETag`; send `If-None-Match` for a 304. It contains no API credentials or user state.

Native account creation and sign-in use one email-code flow:

| Method and path | JSON request | Result |
| --- | --- | --- |
| POST `/api/auth/email-otp/send-verification-otp` | `{"email":"person@example.com","type":"sign-in"}` | 202 `{"accepted":true}`; this does not prove delivery |
| POST `/api/auth/sign-in/email-otp` | `{"email":"person@example.com","otp":"123456","device":"MacBook Pro"}` | Better Auth session JSON and signed opaque `set-auth-token` header; `device` is optional |

A new account can be created only when sign-up is open, its email domain is permitted, and the per-IP daily new-account cap allows it. Existing users may sign in when sign-up is closed. An optional `SIGNUP_EMAIL_ALLOWLIST` restricts both new and existing sign-in addresses and email-change destinations to exact normalized entries; suppressed send responses remain generic 202. An uninvited address receives the same 401 `invalid_code` on redemption as a nonexistent/unapproved address, including when a previously issued code was valid. This route does not emit `signup_closed` or `signup_disabled`; explain invite-only access using public `signup_mode:"allowlist"` without probing account membership. Capacity and delivery failures return `503 email_unavailable` with `Retry-After`; honor that delay before a new send request. Email addresses are normalized. The code expires after five minutes, is single use, and has bounded send, cooldown, attempt, and concurrent sign-in limits. The optional device label must be nonempty, at most 64 characters, and contain no control characters. There is no password, OAuth, code-to-JWT exchange, or refresh-token route.

Store `set-auth-token` in the OS credential vault and send it as `Authorization: Bearer <token>`. Scope each vault entry to the exact API origin and environment. Never send that token to a custom origin or a direct provider/BYOK endpoint. Sessions last up to 30 days, renew on use under the auth library's rules, and are checked against PostgreSQL. After a 401, clear the vault entry for that origin and sign in again.

## Account and billing

These routes require a verified, active session. Session IDs are scoped to the caller. `GET /v1/account` returns `{id,email,name,emailVerified,createdAt}`; `name` can be null. `PATCH /v1/account` accepts `{"name":"New name"}` or `{"name":null}` and returns `{name}`. `GET /v1/sessions` returns at most 100 live sessions with `id`, nullable `device`, `current`, and timestamps. `DELETE /v1/sessions/{id}` revokes a caller-owned session with 204; `POST /v1/logout` revokes the current session and `POST /v1/logout-all` revokes all caller sessions, both with 204.

`GET /v1/billing` and `POST /v1/billing/refresh` include `subscription.plan` and `subscription.interval` (`"monthly"|"yearly"|null`). They describe the current recognized paid subscription; both are null when there is none, its state is stale/expired/unrecognized, or billing is disabled. Cancellation at period end retains them while paid access remains valid. `usage.plan` remains authoritative for effective model access, including Free/self-hosted plans.

`GET /v1/account` includes nullable `avatar_url`. `PUT /v1/account/avatar` accepts one multipart `file` (PNG/JPEG/WebP, at most 2 MiB) and returns `{avatar_url}` after server re-encoding. `DELETE /v1/account/avatar` returns `{avatar_url:null}` idempotently. The versioned URL requires the same account bearer and serves only the current 256×256 WebP; authenticated ETag revalidation uses private caching. See the [avatar contract](avatar-contract.md) for limits, status codes, caching and deletion behavior. Rust downloads the bytes; never put a bearer in an image URL or webview.

`GET /v1/account/export` returns `schemaVersion:1`, an `account` object including `avatar_url` and nullable `avatar` with the processed WebP bytes encoded as base64, current `billing`, nullable `usage`, `usage_history_url`, and safe `sessions`; it excludes bearer tokens and private keys. `GET /v1/usage/requests` below supplies paginated accounting history.

| Method and path | Request | Result |
| --- | --- | --- |
| GET `/v1/billing` | — | Reconciled subscription, paid flag, capabilities, and priced offers |
| POST `/v1/billing/refresh` | Empty body | Same shape after bounded provider reconciliation; at most six times per minute per user |
| POST `/v1/billing/checkout` | `{"interval":"monthly"|"yearly","plan"?:"plan-id"}` or `{"topup":"topup-id"}` | `{url}` for a caller-bound Polar checkout |
| POST `/v1/billing/subscription/preview` | `{plan,interval}` | Caller-owned five-minute quote; no payment |
| POST `/v1/billing/subscription/change` | `{quote_id}` | 202 operation receipt; fresh session required for first confirmation |
| GET `/v1/billing/subscription/changes/{id}` | No body | Caller-owned operation receipt; unknown/foreign IDs return 404 |
| POST `/v1/billing/portal` | Empty body | `{url}`; 409 `no_billing_account` if no Polar customer exists |

When `BILLING_ENABLED=false`, billing returns `offers:null`, `subscription.status:"not_applicable"`, and `paid:false`; portal and checkout reject. An enabled self-hosted cloud policy can still report `capabilities.hostedAI:true` while billing is disabled. Enabled offers contain `unit_scale:1000000`, `credit_units:"10000"`, subscription entries `{plan,interval,product_name,price:{amount_minor,currency}}`, and top-ups `{id,units,expires_days,product_name,price}`. Prices come from Polar's active fixed-price product data, cached briefly; invalid, archived, metered, or wrong-cadence products fail closed. A `price.amount_minor` is an integer in the displayed currency's minor unit. Do not derive a price from credit units or fixtures.

Checkout selects only configured products, binds the created checkout ID to the user, product, and policy revision, and does not accept caller-supplied customer IDs, products, prices, or return URLs. An account under billing review cannot create a new checkout or start an upgrade: these return 403 `billing_review_required`. Downgrades, cancellation through the portal, account export, and reconciliation of already-dispatched operations remain available. Buying more credit does not clear billing review. Refresh can reconcile paid top-ups from known caller-owned checkouts immediately; webhook and worker reconciliation remains idempotent. A refreshed subscription result cannot overwrite a newer webhook or worker result. `paid` reflects a current reconciled subscription, not a trial or an expired period.

Account deletion and email change use separate five-minute, single-use email codes:

| Method and path | Request | Result |
| --- | --- | --- |
| POST `/v1/account/deletion/code` | Empty body | 202 `{accepted:true}`; code sent to current email |
| POST `/v1/account/deletion` | `{"otp":"123456"}` | 202 `{status:"deleting"}`; seals account and revokes sessions |
| POST `/v1/account/email/code` | `{"email":"new@example.com"}` | 202 `{accepted:true}`; sends code to new address |
| PATCH `/v1/account/email` | `{"email":"new@example.com","otp":"123456"}` | `{updated:true,reauthentication_required:true}`; revokes sessions |

Email-change code request and completion require a session created within ten minutes. Codes are purpose and destination bound. Account deletion is asynchronous after sealing; the worker finishes provider cleanup and local purge.

## Hosted catalog, credits, and history

Cloud routes are mounted when the API has a cloud service. The checked-in policy is disabled and has no approved commercial rates or enabled models. A model also needs an available provider credential and a plan permitted by policy; BYOK remains a direct desktop/provider path.

`GET /v1/models` returns `{schema_version:1,policy_revision,cloud_enabled,defaults,models}`. `defaults` maps `lead`, `page`, `light`, and `decision` to a model ID or null after availability filtering. Each catalog model includes `id`, `provider`, `upstream_model`, `display_name`, `description`, `tier`, `available` for this account, `roles`, `recommended`, `recommended_roles`, `context_window`, `max_output`, `limits:{max_request_bytes,max_search_calls,idle_timeout_ms,max_duration_ms}`, `supports`, `plan_min`, `allowed_plans`, and `price`. The price has `unit_scale:1000000`, `credit_units:"10000"`, decimal-string accounting-unit rates in `per_million_tokens`, and decimal-string `per_search_call`. A listed but `available:false` model is locked for this account; do not send it to generation.

`GET /v1/usage` returns `schema_version`, `cloud_enabled`, `policy_revision`, `plan`, `unit_scale:1000000`, `credit_units:"10000"`, decimal-string `credits_remaining`, `reserved_units`, `spent_today`, `bonus_remaining`, `purchased_remaining`, nullable `bonus_expires_at`, `period_end`, nullable decimal-string `daily_limit_units`, `by_model:[{model_id,units,requests}]`, and `allowance:{total_units,used_units,reserved_units}`. One display credit is 10,000 integer accounting units. Divide unit amounts by `credit_units` for credit display; retain exact integer strings for accounting. Under an explicitly USD-denominated policy, 100 credits have USD1 usage-credit face value. Preserve decimal strings for accounting. `PUT /v1/usage/limits` accepts a nonnegative decimal-string `daily_limit_units` or null and returns 204; a caller limit cannot exceed a plan cap.

`GET /v1/usage/requests?cursor=...` returns at most 50 caller-owned entries `{id,model_id,state,units,reserved,started_at,finished_at}` plus nullable `next_cursor`. Treat the cursor as opaque; pass it back unchanged. `GET /v1/usage/requests/{id}` returns a caller-owned request's `id`, `state`, `model_id`, `policy_revision`, decimal-string `reserved` and `charged`, nullable `error_class`, and timestamps; unknown or foreign IDs return 404. Only `state:"settled"` establishes a final charge. Pending or unknown usage is held for recovery and eventually refunded if it cannot be confirmed; no final bill is estimated.

## Native hosted generation

| Method and path | Body family | Success |
| --- | --- | --- |
| POST `/openai/v1/responses` | OpenAI Responses fields | Native JSON or SSE |
| POST `/anthropic/v1/messages` | Anthropic Messages fields | Native JSON or SSE |
| POST `/google/v1beta/models/{model}:streamGenerateContent` | Google `contents` and supported generation fields | Native SSE |
| POST `/openrouter/v1/chat/completions` | OpenRouter chat fields | Native JSON or SSE |
| POST `/deepseek/v1/chat/completions` | DeepSeek chat fields | Native JSON or SSE |
| POST `/v1/systemone` | TypeSafe Jev `{model,state,questions}` | Native JSON |

Use an available catalog ID and respect its capability and byte/output/search limits. Provider-specific allowlists reject unsupported fields, provider-side storage, prior-response continuation, file IDs, and unpriced tools. Hosted native search is limited to policy-enabled OpenAI and Anthropic search tools; there is no standalone search endpoint. The gateway forwards successful provider JSON/SSE bytes without storing prompts, outputs, browsing history, screenshots, or tool payloads.

Admission reserves a conservative local maximum from UTF-8 bytes, request structure, output ceiling, and possible native-search calls. Text uses conservative byte and structure factors, including ASCII; media falls back to the model's full context ceiling. The gateway does not call a provider tokenizer before dispatch. The hold is not a final token count or bill. Settlement uses reported actual usage, releases unused hold, and caps user charge at the reservation; uncertain usage is not charged by estimate.

A UUID `Idempotency-Key` is optional and recommended once per logical call. Reuse returns 409 (`request_in_progress` or `request_already_recorded`) and never replays output. Successful generation includes `X-Zephium-Request-Id` and `X-Zephium-Policy-Revision`; JSON adds `X-Zephium-Usage: settled|pending`.

For SSE, consume the raw stream through EOF even after a provider's `[DONE]` event. The backend appends a best-effort SSE comment, `: zephium {"request_id":"...","usage":"settled","charged":"...","credit_units":"10000"}` or a pending/error variant, after provider completion. The comment is accounting metadata, not provider content, and may be absent on disconnect. Parse it without showing it as model text. If absent, pending, or interrupted, inspect the caller-owned request receipt before any fresh generation; do not automatically replay a possibly dispatched call. A 401 invalidates the session; 402 indicates insufficient credit or a daily cap; 429 may indicate request, concurrency, or provider limits. Honor `Retry-After` when present.

## Webhooks

POST `/webhooks/polar` checks a signature over exact bytes and stores only an event ID/digest plus reconciliation intent. Duplicate IDs with different bytes return 409. It is a provider callback, not a desktop route.

GET `/v1/source` is public and returns `{license:"AGPL-3.0-only",source_url:string|null}` for the deployed corresponding-source offer. `SOURCE_URL` must be configured by the operator.

## Release additions

See [desktop-integration.md](desktop-integration.md#release-contract-changes--2026-10-18) and the updated OpenAPI transcription operation for the exact voice, nullable allowance renewal, funding, signup-mode and error changes. Authentication sends await bounded delivery acceptance; they do not queue unbounded or store plaintext mail.

## Subscription plan changes

Initial subscriptions use checkout. An existing subscription uses preview then explicit confirmation, never a second checkout. Upgrades charge the prorated price difference through Polar's `invoice` behavior; downgrades use `next_period`. Changing cadence, discounted subscriptions, pending changes, and scheduled cancellation are not accepted by this flow. The customer must resolve those conditions before previewing again. Only configured products marked checkout-enabled are selectable.

A quote/receipt is `{id,status,current_plan,target_plan,interval,direction,effective_at,amount_due_estimate:{amount_minor,currency,tax_excluded:null,tax_calculation:"not_calculated"},recurring_price:{amount_minor,currency},expires_at,error:null|{code}}`. The immediate-charge figure is a product-price-based estimate; product amounts may already include tax. Tax inclusion is unknown (`tax_excluded:null`) because the backend has not calculated customer-specific tax. Polar determines the final prorated charge; clients must not add tax to this estimate themselves. `effective_at` is null for an immediate upgrade and the renewal timestamp for a downgrade. `expires_at` limits confirmation, not the lifetime of an already submitted operation.

Statuses: `quoted`, `queued`, `executing`, `uncertain`, `applied`, `scheduled`, `failed`. Confirmation requires a session created within ten minutes and uses the quote UUID as its durable idempotency key. Repeating confirmation returns the existing receipt. A queued operation is not payment success. Poll the receipt; after `applied` or `scheduled`, refresh billing and usage. `scheduled` records Polar's acceptance of a renewal change; current entitlement still comes from the reconciled subscription. An operator or customer cancellation at Polar can supersede it.

`uncertain` means the payment result is not confirmed. Do not submit another quote/payment; the worker reads authoritative state without retrying the charge. A failed operation's `error.code` is part of the receipt (HTTP 200/202), not a new HTTP error. `payment_failed` grants no additional allowance. An upgrade preserves the existing monthly allowance period, consumed units and holds, adding only the remaining-period difference. Annual subscriptions still have monthly allowance periods.

New HTTP errors: 400 `invalid_plan_change`; 404 `plan_change_not_found`; 409 `subscription_change_required`, `checkout_in_progress`, `billing_refresh_required`, `subscription_change_unavailable`, `plan_change_in_progress`, `plan_change_expired`; existing 401 `reauthentication_required`, 403 `billing_review_required`, 429 `rate_limited`, and 503 provider/configuration errors still apply. Preview is limited to six requests per minute per user. `billing_refresh_required` asks the client to refresh billing before trying again. Subscription checkout creation checks current provider state, and unresolved checkout creation blocks another subscription attempt rather than risking duplication.

## Purchased-credit display

`GET /v1/usage` adds `purchased_balance`, either `null` or `{currency:"USD",amount:"11.345677"}`. The six-decimal string is computed exactly from **available** purchased units after spending, holds, expiry and revocation. It is usage-credit face value, not money paid, cash held, refundable balance, or provider spend. Keep `purchased_remaining` for accounting and use the display field for the UI. Do not infer USD from `unit_scale` alone.

A policy may explicitly set `creditCurrency:"USD"`; then 1,000,000 accounting units represent $1 of usage credit. Omission keeps arbitrary-credit/self-hosted behavior and returns null. Existing policies keep their previous digest when this optional field is omitted. Once declared, the currency cannot be removed through an ordinary policy update. Introducing it over outstanding unlabelled purchased balances requires a reviewed migration; the registrar refuses to silently relabel them. Prices/bonuses and model tariffs remain separate policy/product decisions.

`GET /v1/usage/requests` includes `credit_units:"10000"` at the history-envelope level; individual receipts include it alongside `charged`/`reserved`. Settled SSE trailers include it with `charged`; pending/error trailers have no final amount. Account export inherits the field through its usage object. `PUT /v1/usage/limits` still accepts raw accounting units. This display metadata does not change Polar's `price.amount_minor`, provider token counts or historical charges. Use `purchased_balance` for an explicitly denominated USD balance; null still means the legacy/self-hosted policy has not assigned that currency.

## Linux release waitlist

See [the website integration contract](linux-waitlist-integration.md). No account or confirmation email is created.
