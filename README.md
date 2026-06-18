# Ravna Gora — PDF Worker

A Cloudflare Worker API that serves magazine issues from Cloudflare R2, gated by Supabase JWT authentication. Built with [Hono](https://hono.dev/).

## How it works

- **Public routes** return issue metadata and cover images from Supabase / R2 with no auth.
- **Protected routes** require a valid Supabase JWT (`Authorization: Bearer <token>`). The token is verified against the project's JWKS endpoint — no shared secret needed.
- **Admin routes** additionally check that the authenticated user has `role = 'admin'` in the `profiles` table before allowing PDF uploads or cover image uploads.

## Project structure

```
src/
  index.ts     — Hono app, all route handlers
  auth.ts      — JWT verification middleware (Supabase JWKS)
  admin.ts     — Admin role-check middleware
  supabase.ts  — Supabase client factory
  types.ts     — Env and Issue types
```

---

## Setup

### 1. Create the R2 bucket

The bucket name **must** match `wrangler.jsonc` before the worker can deploy:

```bash
wrangler r2 bucket create ravna-gora-bckt
```

### 2. Set secrets

Run each command and enter the value when prompted:

```bash
wrangler secret put SUPABASE_URL              # e.g. https://yourref.supabase.co
wrangler secret put SUPABASE_PROJECT_REF      # e.g. yourref
wrangler secret put SUPABASE_SERVICE_ROLE_KEY # service role key — never expose to clients
wrangler secret put ALLOWED_ORIGIN            # frontend origin, e.g. https://yoursite.vercel.app
```

> **Note:** `SUPABASE_JWT_SECRET` is **not** used. Auth is done via JWKS (`/auth/v1/.well-known/jwks.json`), which rotates automatically and requires no secret stored in the worker.

### 3. Supabase: create the `profiles` table

If you do not already have a `profiles` table with a `role` column, run this in the Supabase SQL editor:

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role  text NOT NULL DEFAULT 'user'
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can read own profile"
ON profiles FOR SELECT
TO authenticated
USING (id = auth.uid());
```

To grant admin access to a user:

```sql
UPDATE profiles SET role = 'admin' WHERE id = '<user-uuid>';
```

### 4. Supabase: create the `issues` table

```sql
-- Helper function used by RLS policies
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER;

CREATE TABLE issues (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number     integer     UNIQUE NOT NULL,
  issue_date       date        NOT NULL,
  slug             text        UNIQUE NOT NULL,
  cover_image_url  text,
  pdf_object_key   text        NOT NULL,
  title            text,
  published        boolean     DEFAULT false,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

-- Anyone (anon or authenticated) can read published issues
CREATE POLICY "Public can read published issues"
ON issues FOR SELECT
TO anon, authenticated
USING (published = true);

-- Admins have full access
CREATE POLICY "Admins have full access"
ON issues FOR ALL
TO authenticated
USING (is_admin())
WITH CHECK (is_admin());
```

---

## Local development

Copy the example env file and fill in real values:

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` is gitignored. It is loaded automatically by `wrangler dev`.

Start the dev server:

```bash
npm run dev
# Worker available at http://localhost:8787
```

> The R2 binding in local dev hits the **real** bucket by default. Pass `--local` to `wrangler dev` if you want an in-memory R2 simulation instead.

---

## Deploy

```bash
npm run deploy
```

---

## API reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | Public | Returns `{"ok":true}` |
| `GET` | `/issues` | Public | List all published issues (slug, number, date, cover, title) |
| `GET` | `/issues/:slug/pdf` | JWT | Stream the PDF for a published issue from R2 |
| `POST` | `/admin/issues/:slug/pdf` | JWT + Admin | Upload a PDF for an issue (multipart `file` field) |
| `GET` | `/covers/:filename` | Public | Serve a cover image from R2 (long-lived cache headers) |
| `POST` | `/admin/issues/:slug/cover` | JWT + Admin | Upload a cover image; updates `cover_image_url` in Supabase |
| `GET` | `/debug/list-bucket` | JWT | List all R2 object keys — **remove before production** |

### Request / response notes

**`GET /issues`**
```json
{
  "issues": [
    {
      "slug": "issue-042",
      "issue_number": 42,
      "issue_date": "2024-03-01",
      "cover_image_url": "https://worker.example.com/covers/issue-042.jpg",
      "title": "Spring Edition"
    }
  ]
}
```

**`GET /issues/:slug/pdf`**
- Returns the PDF as `application/pdf` with `Content-Disposition: inline`.
- Returns `{"status":"authenticated","message":"Auth works. PDF not yet uploaded.",...}` if the issue exists but no PDF has been uploaded yet.

**`POST /admin/issues/:slug/pdf`**
- Body: `multipart/form-data` with a `file` field containing the PDF.
- The R2 key used is whatever is stored in `issues.pdf_object_key` for that slug.

**`POST /admin/issues/:slug/cover`**
- Body: `multipart/form-data` with a `file` field containing any image.
- The image is stored at `covers/<slug>.<ext>` in R2.
- `issues.cover_image_url` is updated to the public Worker URL for the image.

---

## curl examples

### Health check

```bash
curl http://localhost:8787/health
# {"ok":true}
```

### List issues

```bash
curl http://localhost:8787/issues
```

### Get a PDF (authenticated)

```bash
TOKEN="eyJhbGci..."

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/issues/issue-042/pdf \
  --output issue-042.pdf
```

### Upload a PDF (admin)

```bash
TOKEN="eyJhbGci..."

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/issue-042.pdf" \
  http://localhost:8787/admin/issues/issue-042/pdf
# {"ok":true,"key":"issues/issue-042.pdf"}
```

### Upload a cover image (admin)

```bash
TOKEN="eyJhbGci..."

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/cover.jpg" \
  http://localhost:8787/admin/issues/issue-042/cover
# {"ok":true,"key":"covers/issue-042.jpg","url":"https://worker.example.com/covers/issue-042.jpg"}
```

### Fetch a cover image (public)

```bash
curl http://localhost:8787/covers/issue-042.jpg --output cover.jpg
```

### List R2 bucket contents (debug)

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/debug/list-bucket
```

---

## Getting a Supabase JWT for curl testing

1. Sign in to your frontend app in a browser.
2. Open DevTools → Console and run:
   ```js
   JSON.parse(localStorage.getItem('sb-<your-ref>-auth-token')).access_token
   ```
   Replace `<your-ref>` with your Supabase project ref.
3. Copy the printed string — that is your JWT.
4. Use it as `TOKEN` in the curl commands above.

Tokens expire after 1 hour by default. Re-login and repeat to get a fresh one.

---

## Regenerating types after binding changes

After editing bindings in `wrangler.jsonc`, regenerate `worker-configuration.d.ts`:

```bash
npm run cf-typegen
```
