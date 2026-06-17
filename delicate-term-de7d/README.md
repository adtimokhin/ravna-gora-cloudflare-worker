# ravna-gora PDF Worker

Cloudflare Worker that serves PDF issues from R2, gated by Supabase JWT authentication.

## Setup

### 1. Set secrets

```bash
wrangler secret put SUPABASE_JWT_SECRET
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_PROJECT_REF
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_ORIGIN
```

Each command prompts for the value interactively.

- `SUPABASE_JWT_SECRET` — from Supabase → Project Settings → API → JWT Secret
- `SUPABASE_URL` — e.g. `https://yourref.supabase.co`
- `SUPABASE_PROJECT_REF` — the ref string alone, e.g. `yourref`
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (never expose to clients)
- `ALLOWED_ORIGIN` — frontend origin, e.g. `https://yoursite.vercel.app`

### 2. Create the R2 bucket

```bash
wrangler r2 bucket create nass-pdfs
```

### 3. Supabase: create the `issues` table

```sql
-- Helper: check if the current user is an admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER;

-- Table
CREATE TABLE issues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number     integer UNIQUE NOT NULL,
  issue_date       date NOT NULL,
  slug             text UNIQUE NOT NULL,
  cover_image_url  text,
  pdf_object_key   text NOT NULL,
  title            text,
  published        boolean DEFAULT false,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

-- Anon and authenticated users can read published issues
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

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

Run the dev server:

```bash
npm run dev
# Worker available at http://localhost:8787
```

`.dev.vars` is gitignored. The R2 binding in local dev hits the real bucket unless you use `--local` flag with `wrangler dev`, in which case R2 is simulated in-memory.

## Deploy

```bash
npm run deploy
```

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Public | Health check |
| GET | `/issues/:slug/pdf` | JWT required | Stream PDF from R2 |
| GET | `/debug/list-bucket` | JWT required | List R2 keys (remove before prod) |

## Testing with curl

### Health check

```bash
curl http://localhost:8787/health
# {"ok":true}
```

### PDF endpoint without a token (expect 401)

```bash
curl http://localhost:8787/issues/my-slug/pdf
# {"error":"Missing or malformed Authorization header"}
```

### PDF endpoint with a token for a nonexistent slug (expect 404)

```bash
TOKEN="eyJhbGci..."

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/issues/does-not-exist/pdf
# {"error":"Issue not found"}
```

### PDF endpoint with a token for a slug that exists but no PDF uploaded yet (expect placeholder JSON)

```bash
TOKEN="eyJhbGci..."

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/issues/issue-042/pdf
# {
#   "status": "authenticated",
#   "message": "Auth works. PDF not yet uploaded.",
#   "issue": { "slug": "issue-042", "issue_number": 42, ... }
# }
```

### List bucket contents

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/debug/list-bucket
```

## Getting a real Supabase JWT for curl testing

1. Sign in to your frontend app in a browser.
2. Open DevTools → Console and run:
   ```js
   JSON.parse(localStorage.getItem('sb-<your-ref>-auth-token')).access_token
   ```
   Replace `<your-ref>` with your Supabase project ref.
3. Copy the printed string — that is your JWT.
4. Use it as `TOKEN` in the curl commands above.

The token expires after 1 hour by default. Re-login and repeat if you get 401s.
