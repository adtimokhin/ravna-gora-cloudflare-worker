# Ravna Gora API Reference

HTTP API for the `delicate-term-de7d` Cloudflare Worker — a [Hono](https://hono.dev) app that serves issue metadata, gates issue PDFs behind an active membership, handles Stripe membership checkout/lifecycle, and exposes admin upload endpoints.

Everything here is derived from the source (`delicate-term-de7d/src/`), not from any README.

## Base URL

The Worker origin. In local dev that is `http://localhost:8787`; in production it is the deployed `workers.dev` route or custom domain. All paths below are relative to that origin. There is no API prefix / version segment.

## Auth model

| Mechanism             | How                                                                                    | Applied by                                |
| --------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| **None**              | —                                                                                      | public routes                             |
| **Supabase JWT**      | `Authorization: Bearer <access_token>`                                                 | `authMiddleware`                          |
| **JWT + admin role**  | JWT, plus `profiles.role === 'admin'` for `user.sub`                                   | `authMiddleware` → `adminMiddleware`      |
| **Active membership** | JWT, plus an access decision of `admin` or `active_member`                             | `authMiddleware` → `membershipMiddleware` |
| **Stripe signature**  | raw request body + `stripe-signature` header, verified against `STRIPE_WEBHOOK_SECRET` | `POST /webhooks/stripe` handler           |

### `authMiddleware` (`src/auth.ts`)

- Requires `Authorization: Bearer <token>`. Missing header or one that does not start with `Bearer ` → **401** `{ "error": "Missing or malformed Authorization header" }`.
- Verifies the JWT with `jose` against the Supabase JWKS at
  `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/.well-known/jwks.json`, requiring
  `audience: "authenticated"` and `issuer: "https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1"`.
  Any verification failure (bad signature, expired, wrong aud/iss) → **401** `{ "error": "Invalid or expired token" }`.
- On success attaches the decoded JWT payload as `user` on the context. `user.sub` is the Supabase user UUID; `user.email` (when present) is used as the Stripe `customer_email` at checkout.

### `adminMiddleware` (`src/admin.ts`)

Runs only after `authMiddleware`.

- No `user.sub` → **401** `{ "error": "Invalid token: missing user ID" }`.
- Looks up `profiles.role` for `id = user.sub` via Supabase (`.single()`). If the query errors, returns no row, or `role !== 'admin'` → **403** `{ "error": "Admin access required" }`.

### `membershipMiddleware` (`src/membership.ts`)

Runs only after `authMiddleware`.

- No `user.sub` → **401** `{ "error": "Invalid token: missing user ID" }`.
- Looks up a cached decision in the `MEMBERSHIP_CACHE` KV namespace under key `access:<user.sub>`.
- On a cache miss it calls `resolveAccess`:
  - `profiles.role === 'admin'` → `admin` (admins bypass the membership requirement entirely; a profile-lookup error is logged but not fatal).
  - otherwise the newest `memberships` row (by `created_at`) is checked by `membershipRowGrantsAccess`: `status` must be one of `active`, `past_due`, `trialing`; and for a **gift** row (`stripe_subscription_id === null`) `current_period_end` must still be in the future.
  - anything else → `denied`.
  - If the `memberships` lookup itself errors, `resolveAccess` throws → middleware returns **500** `{ "error": "Internal server error" }`.
- Positive decisions (`admin` / `active_member`) are written back to KV with a **2‑hour TTL** (`expirationTtl: 7200`, via `waitUntil`, non-blocking). `denied` is never cached.
- A `denied` decision → **403** `{ "error": "An active membership is required to view this content" }`.
- Cache busting: `bustAccessCache` deletes `access:<uid>` after account deactivation, gift-membership creation, and every Stripe webhook mutation. It is best-effort — a KV error is swallowed.

## CORS

A single `app.use('*', …)` wraps every route:

- If `ALLOWED_ORIGIN` is **unset/empty**, CORS handling is skipped entirely (no CORS headers added).
- Otherwise `ALLOWED_ORIGIN` is split on `,` and trimmed into an allow-list. The response `Access-Control-Allow-Origin` echoes the request `Origin` when it is in the list, else falls back to the **first** entry in the list.
- `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`
- `Access-Control-Allow-Headers: Authorization, Content-Type`
- `OPTIONS` preflight is answered by this middleware when `ALLOWED_ORIGIN` is set.

## Framework defaults

- No route match → Hono default **404** `Not Found` (`text/plain`).
- An uncaught exception not handled inside a route → Hono default **500** `Internal Server Error` (`text/plain`). Most handlers catch their own errors and return JSON instead (documented per endpoint).

---

## Summary of endpoints

| Method | Path                        | Auth                         | Purpose                                            |
| ------ | --------------------------- | ---------------------------- | -------------------------------------------------- |
| GET    | `/health`                   | none                         | Liveness check                                     |
| GET    | `/issues`                   | none                         | List published issues                              |
| GET    | `/covers/:filename`         | none                         | Serve a cover image from R2                        |
| GET    | `/issues/:slug/pdf`         | JWT + active membership      | Stream a published issue's PDF                     |
| POST   | `/create-checkout-session`  | JWT                          | Start a Stripe membership Checkout session         |
| POST   | `/cancel-subscription`      | JWT                          | Schedule a subscription to cancel at period end    |
| POST   | `/deactivate-account`       | JWT                          | Pause/cancel all subscriptions and ban the account |
| POST   | `/admin/issues/:slug/pdf`   | JWT + admin                  | Upload an issue PDF to R2                          |
| POST   | `/admin/issues/:slug/cover` | JWT + admin                  | Upload an issue cover image and update the DB      |
| POST   | `/admin/gift-membership`    | JWT + admin                  | Grant a membership with no Stripe subscription     |
| GET    | `/debug/list-bucket`        | JWT (any authenticated user) | List all R2 object keys                            |
| POST   | `/webhooks/stripe`          | Stripe signature             | Stripe subscription lifecycle webhook              |

---

# Public

## GET /health

Liveness probe.

- **Auth:** none. **Params:** none. **Body:** none.
- **200**
  ```json
  { "ok": true }
  ```

## GET /issues

List all published issues, ordered by `issue_number` descending.

- **Auth:** none. **Params:** none. **Body:** none.
- **Side effects:** reads Supabase `issues` (`published = true`).
- **200**
  ```json
  {
    "issues": [
      {
        "slug": "issue-12",
        "issue_number": 12,
        "issue_date": "2026-08-01",
        "cover_image_url": "https://worker.example/covers/issue-12.jpg",
        "title": "Some title"
      }
    ]
  }
  ```
  `issues` is `[]` when there are no published rows. `cover_image_url` and `title` may be `null`.
- **500** `{ "error": "Failed to fetch issues" }` — Supabase returned an error.
- **500** `{ "error": "Internal server error" }` — unexpected exception.

## GET /covers/:filename

Serve a cover image stored in R2 under the `covers/` prefix. Not gated — anyone with the URL can fetch it.

- **Auth:** none.
- **Path params:** `filename` (string) — the object's basename; the handler fetches R2 key `covers/<filename>`.
- **Body:** none.
- **200** — raw image bytes.
  - `Content-Type`: the stored `httpMetadata.contentType`, or `image/jpeg` if none was recorded.
  - `Cache-Control: public, max-age=31536000, immutable`
- **404** `{ "error": "Not found" }` — no such R2 object.
- **500** `{ "error": "Internal server error" }` — unexpected exception.

---

# Authenticated

## GET /issues/:slug/pdf

Stream a published issue's PDF. Gated content.

- **Auth:** Supabase JWT + active membership. Middleware order: `authMiddleware` → `membershipMiddleware` → handler. Admins pass the membership gate with no membership row.
- **Path params:** `slug` (string) — issue slug.
- **Query params:** none. **Body:** none.
- **Side effects:** reads Supabase `issues`; reads R2 (`PDFS.get(pdf_object_key)`).

**Success — PDF present (200):** raw PDF bytes.

- `Content-Type: application/pdf`
- `Content-Disposition: inline; filename="<slug>.pdf"`
- (no `Cache-Control`)

**Success — authenticated but PDF not uploaded yet (200, JSON):** returned when the `issues` row exists but no R2 object is stored at its `pdf_object_key`.

```json
{
  "status": "authenticated",
  "message": "Auth works. PDF not yet uploaded.",
  "issue": {
    "slug": "issue-12",
    "issue_number": 12,
    "issue_date": "2026-08-01",
    "pdf_object_key": "pdfs/issue-12.pdf"
  }
}
```

**Errors**

- **401** `{ "error": "Missing or malformed Authorization header" }` — from `authMiddleware`.
- **401** `{ "error": "Invalid or expired token" }` — from `authMiddleware`.
- **401** `{ "error": "Invalid token: missing user ID" }` — from `membershipMiddleware` (JWT has no `sub`).
- **403** `{ "error": "An active membership is required to view this content" }` — from `membershipMiddleware`.
- **404** `{ "error": "Issue not found" }` — no published `issues` row for `slug` (or the query errored).
- **500** `{ "error": "Internal server error" }` — from `membershipMiddleware` (`resolveAccess` threw) or from the handler's catch-all.

---

# Admin

## POST /admin/issues/:slug/pdf

Upload an issue's PDF into R2 at the key already recorded in `issues.pdf_object_key`. The issue does **not** need to be published.

- **Auth:** JWT + admin. Middleware order: `authMiddleware` → `adminMiddleware` → handler.
- **Path params:** `slug` (string).
- **Request body:** `multipart/form-data` with one field:
  - `file` (File, required) — accepted when `file.type === "application/pdf"` **or** the filename ends in `.pdf` (case-insensitive).
- **Side effects:** reads Supabase `issues` (by `slug`, no `published` filter); `PDFS.put(pdf_object_key, bytes, { httpMetadata: { contentType: "application/pdf" } })`. Overwrites any existing object at that key.
- **200**
  ```json
  { "ok": true, "key": "pdfs/issue-12.pdf" }
  ```
- **400** `{ "error": "No file field in request" }` — `file` missing.
- **400** `{ "error": "File must be a PDF" }` — wrong content type and non-`.pdf` name.
- **404** `{ "error": "Issue not found" }` — no `issues` row for `slug`.
- **401** `{ "error": "Missing or malformed Authorization header" }` / `{ "error": "Invalid or expired token" }` — from `authMiddleware`.
- **401** `{ "error": "Invalid token: missing user ID" }` / **403** `{ "error": "Admin access required" }` — from `adminMiddleware`.
- **500** `{ "error": "Internal server error" }` — unexpected exception.

## POST /admin/issues/:slug/cover

Upload an issue cover image to R2 at `covers/<slug>.<ext>` and set `issues.cover_image_url` to the public Worker URL for that object.

- **Auth:** JWT + admin. Middleware order: `authMiddleware` → `adminMiddleware` → handler.
- **Path params:** `slug` (string).
- **Request body:** `multipart/form-data` with one field:
  - `file` (File, required) — accepted only when `file.type` starts with `image/` (any image subtype).
- **Behavior:** the extension is taken from the uploaded filename (lowercased); if the name has no `.`, `jpg` is used. R2 key = `covers/<slug>.<ext>`, stored with `httpMetadata.contentType = file.type`. The public URL is built from the incoming request origin: `<origin>/covers/<slug>.<ext>` (so it is correct in both local dev and production). Then `issues.cover_image_url` is updated for `slug`.
- **Side effects:** `PDFS.put(...)`; Supabase `issues` update.
- **200**
  ```json
  {
    "ok": true,
    "key": "covers/issue-12.jpg",
    "url": "https://worker.example/covers/issue-12.jpg"
  }
  ```
- **400** `{ "error": "No file field in request" }` — `file` missing.
- **400** `{ "error": "File must be an image" }` — `file.type` does not start with `image/`.
- **500** `{ "error": "Uploaded to R2 but failed to update the issues record" }` — the R2 write succeeded but the Supabase update errored.
- **401** / **403** — same middleware errors as `POST /admin/issues/:slug/pdf`.
- **500** `{ "error": "Internal server error" }` — unexpected exception.

## POST /admin/gift-membership

Grant a membership that has no Stripe subscription or customer (`stripe_subscription_id` and `stripe_customer_id` both `null`; `status = "active"`).

- **Auth:** JWT + admin. Middleware order: `authMiddleware` → `adminMiddleware` → handler.
- **Params:** none.
- **Request body:** `application/json`:

  | Field               | Type             | Required | Validation                                                                                                                                                    |
  | ------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `target_uid`        | string           | yes      | must match the UUID regex `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case-insensitive)                                                 |
  | `price_id`          | string           | yes      | must start with `price_` **and** be a key of `STRIPE_PRICE_MAP`                                                                                               |
  | `custom_expiration` | string \| number | yes      | must parse via `new Date(...)` to a valid date; stored as `current_period_end`                                                                                |
  | `mailing_address`   | object           | no       | only used when the resolved `price_id` maps to `edition: "print"`; fields read: `recipient_name`, `line1`, `line2`, `city`, `state`, `postal_code`, `country` |

- **Side effects:** reads Supabase `profiles` (target must exist); inserts a `memberships` row; if `edition === "print"` and `mailing_address` is an object, upserts a `mailing_addresses` row (best-effort — a failure here is logged, not returned); `bustAccessCache(target_uid)`.
- **200**
  ```json
  { "success": true, "membership_id": "…" }
  ```
- **400** `{ "error": "Invalid JSON body" }` — body is not JSON.
- **400** `{ "error": "A valid target_uid is required" }` — missing / not a UUID.
- **400** `{ "error": "A valid price_id is required" }` — missing / not a string starting `price_`.
- **400** `{ "error": "custom_expiration must be a valid date" }` — wrong type, or an unparseable date.
- **400** `{ "error": "Unknown price_id" }` — `price_id` is not in `STRIPE_PRICE_MAP`.
- **404** `{ "error": "Member not found" }` — no `profiles` row for `target_uid`.
- **401** `{ "error": "Invalid token: missing user ID" }` — JWT has no `sub`.
- **500** `{ "error": "Internal server error" }` — `STRIPE_PRICE_MAP` misconfigured, or the `profiles` lookup errored.
- **500** `{ "error": "Could not create gift membership" }` — the `memberships` insert errored.
- Plus middleware **401/403** as for the other admin routes.

---

# Stripe / membership

All three are registered with `authMiddleware` only (`src/stripe.ts` → `registerStripeRoutes`). They enforce their own ownership / state checks against Supabase.

## POST /create-checkout-session

Create a Stripe Checkout Session (`mode: "subscription"`) for the calling user and return its id + hosted URL.

- **Auth:** Supabase JWT. Middleware: `authMiddleware` → handler.
- **Params:** none.
- **Request body:** `application/json`:

  | Field      | Type   | Required | Validation                                                                        |
  | ---------- | ------ | -------- | --------------------------------------------------------------------------------- |
  | `price_id` | string | yes      | must be a string starting with `price_`; must also be a key of `STRIPE_PRICE_MAP` |

- **Behavior / side effects:**
  - Calls `resolveAccess(uid)`. If the result is **not** `denied` (i.e. the user is already an `admin` or `active_member`), the request is refused — you cannot start a second membership.
  - Builds `Stripe.Checkout.SessionCreateParams`: single line item `{ price: price_id, quantity: 1 }`, `client_reference_id = uid`, `metadata` and `subscription_data.metadata` both `{ supabase_uid: uid, price_id }`, `billing_address_collection: "required"`, `tax_id_collection.enabled: true`, `success_url = MEMBERSHIP_SUCCESS_URL`, `cancel_url = MEMBERSHIP_CANCEL_URL`.
  - If the JWT has an `email`, it is passed as `customer_email`.
  - If the price maps to `edition: "print"`, `shipping_address_collection.allowed_countries` is set to the built-in `SHIPPING_COUNTRIES` list (~49 countries).
  - Calls Stripe `checkout.sessions.create`. No membership row is written here — that happens on the `checkout.session.completed` webhook.
- **200**
  ```json
  { "id": "cs_test_…", "url": "https://checkout.stripe.com/c/pay/cs_test_…" }
  ```
- **400** `{ "error": "Invalid JSON body" }` — body not JSON.
- **400** `{ "error": "A valid price_id is required" }` — missing / not starting `price_`.
- **400** `{ "error": "Unknown price_id" }` — not a key of `STRIPE_PRICE_MAP`.
- **401** `{ "error": "Invalid token: missing user ID" }` — JWT has no `sub`.
- **409** `{ "error": "You already have an active membership." }` — `resolveAccess` returned `admin` or `active_member`.
- **500** `{ "error": "Internal server error" }` — `resolveAccess` threw, or `STRIPE_PRICE_MAP` is misconfigured.
- **500** `{ "error": "Could not start checkout" }` — the Stripe API call failed.
- Plus `authMiddleware` **401**s.

## POST /cancel-subscription

Schedule the caller's subscription to cancel at the end of the current billing period (`cancel_at_period_end = true`). Access is retained until the period lapses.

- **Auth:** Supabase JWT. Middleware: `authMiddleware` → handler.
- **Params:** none.
- **Request body:** `application/json`:

  | Field             | Type   | Required | Validation       |
  | ----------------- | ------ | -------- | ---------------- |
  | `subscription_id` | string | yes      | non-empty string |

- **Behavior / side effects:**
  - Looks up a `memberships` row matching **both** `user_id = uid` and `stripe_subscription_id = subscription_id` (the `user_id` scope is the ownership check).
  - The row's `status` must be one of `active`, `past_due`, `trialing`.
  - Calls Stripe `subscriptions.update(subscription_id, { cancel_at_period_end: true })`, then updates the `memberships` row (`cancel_at_period_end = true`, `updated_at`).
- **200**
  ```json
  { "success": true }
  ```
- **400** `{ "error": "Invalid JSON body" }` — body not JSON.
- **400** `{ "error": "subscription_id is required" }` — missing / empty.
- **401** `{ "error": "Invalid token: missing user ID" }` — JWT has no `sub`.
- **404** `{ "error": "Subscription not found" }` — no matching `memberships` row for this user.
- **409** `{ "error": "Subscription is already <status>" }` — row status not in the active set.
- **500** `{ "error": "Internal server error" }` — the lookup errored, or the post-Stripe DB update errored.
- **500** `{ "error": "Could not cancel subscription" }` — the Stripe API call failed.
- Plus `authMiddleware` **401**s.

## POST /deactivate-account

Pause + cancel every active subscription the caller has, then ban the Supabase auth user (a hard account shutdown).

- **Auth:** Supabase JWT. Middleware: `authMiddleware` → handler.
- **Params:** none. **Request body:** none (not read).
- **Behavior / side effects:**
  - Loads all `memberships` rows for `user_id = uid`.
  - For each row that has a `stripe_subscription_id` **and** a `status` in `active` / `past_due` / `trialing`: calls Stripe `subscriptions.update(id, { pause_collection: { behavior: "void" }, cancel_at_period_end: true })`, then updates the `memberships` row (`cancel_at_period_end = true`, `updated_at`). Any Stripe or DB failure in this loop marks the whole request failed.
  - Calls `banAuthUser(uid)` → `PUT <SUPABASE_URL>/auth/v1/admin/users/<uid>` with `{ "ban_duration": "876000h" }` (≈100 years; effectively indefinite) using the service-role key.
  - Calls `bustAccessCache(uid)`.
- **200**
  ```json
  { "success": true }
  ```
- **401** `{ "error": "Invalid token: missing user ID" }` — JWT has no `sub`.
- **500** `{ "error": "Could not deactivate account" }` — the membership lookup failed, a Stripe pause / DB update failed, or the GoTrue ban call failed.
- Plus `authMiddleware` **401**s.

---

# Webhooks

## POST /webhooks/stripe

Stripe subscription-lifecycle webhook. **No Hono auth middleware** — it is registered bare.

- **Auth:** Stripe signature. The handler reads the **raw request body** with `c.req.text()` and the `stripe-signature` header (defaults to `""` if absent), then verifies via `stripe.webhooks.constructEventAsync(payload, signature, STRIPE_WEBHOOK_SECRET, undefined, webCrypto)` (async + SubtleCrypto provider, required on Workers).
- **Params:** none. **Content type:** whatever Stripe sends (JSON); the body must be forwarded unmodified.

**Handled `event.type` values:**

| `event.type`                    | Action                                                                                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`    | Only if `session.mode === "subscription"` and `session.subscription` is a string. Resolves `uid` from `client_reference_id` (fallback `metadata.supabase_uid`) and a `price_id` hint from `metadata.price_id`, then `upsertSubscriptionFromStripe`. |
| `invoice.paid`                  | Extracts the subscription id from the invoice (handles old `invoice.subscription` and new `parent.subscription_details.subscription` shapes), then `upsertSubscriptionFromStripe`.                                                                  |
| `customer.subscription.updated` | `upsertSubscriptionFromStripe` for `sub.id`, passing `uid` from `sub.metadata.supabase_uid` if present.                                                                                                                                             |
| `customer.subscription.deleted` | `markSubscriptionCanceled` — sets `memberships.status = "canceled"`, copies `cancel_at_period_end`, busts the access cache.                                                                                                                         |

**Explicitly ignored:** every other `event.type` (the `default` branch, which the code notes includes `charge.refunded` — there is no one-time-purchase ledger to reverse). Ignored events still return `200`.

**`upsertSubscriptionFromStripe` side effects:** `stripe.subscriptions.retrieve`; resolves the Supabase `uid` (option → `sub.metadata.supabase_uid` → `memberships` lookup by subscription id) and requires it to be a valid UUID (otherwise it logs and returns without writing); resolves plan/edition from `STRIPE_PRICE_MAP` (a recognised price wins; otherwise the existing row's values; otherwise the fallback `{ plan: "supporting", edition: null }`); **upserts** the `memberships` row on the `stripe_subscription_id` unique index, writing the raw Stripe `status`, `current_period_end`, `cancel_at_period_end`, `plan`, `edition`; for `edition === "print"` with a checkout session present, upserts a `mailing_addresses` row from the session's collected shipping details; finally `bustAccessCache(uid)`.

**Responses**

- **200** `{ "received": true }` — signature valid; event handled or intentionally ignored. (Idempotent: writes are upserts keyed on `stripe_subscription_id`, so redelivered events are safe.)
- **400** `Webhook Error: <message>` (`text/plain`) — signature verification failed. Stripe will **not** retry.
- **500** `Handler error` (`text/plain`) — an exception was thrown while processing a handled event. Stripe **will** retry delivery.

---

# Debug

## GET /debug/list-bucket

List every object key in the R2 bucket. The source comment says "Remove or restrict to admin role before production" — as written it is guarded by `authMiddleware` **only**, so any authenticated user (no admin role, no membership) can call it.

- **Auth:** Supabase JWT. Middleware: `authMiddleware` → handler.
- **Params:** none. **Body:** none.
- **Side effects:** `PDFS.list()` (default listing — up to 1000 keys, not paginated by the handler).
- **200**
  ```json
  { "objects": ["covers/issue-12.jpg", "pdfs/issue-12.pdf"] }
  ```
- **401** `{ "error": "Missing or malformed Authorization header" }` / `{ "error": "Invalid or expired token" }` — from `authMiddleware`.
- **500** `{ "error": "Internal server error" }` — unexpected exception.
