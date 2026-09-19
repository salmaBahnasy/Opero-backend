# SaaS ERP — Production Deployment Guide (Phase 15A)

**Status:** Preparation only. Do **not** deploy from this document until Phase 15B.

This guide covers three repositories:

| Service | Role |
|---------|------|
| Backend API | Node/Express + Supabase service role |
| Company Frontend | Vite React SPA (customer ERP) |
| Super Admin Frontend | Vite React SPA (platform ops) |

---

## 1. Architecture

```
Browser (Company App)  ──HTTPS──►  Backend API  ──service_role──►  Supabase Postgres
Browser (Super Admin)  ──HTTPS──►  Backend API
Providers (Shopify / Salla / EasyOrders / Bosta)
                       ──HTTPS webhooks/OAuth──►  Backend API
```

- Employee auth = **application JWT** (`JWT_SECRET`, scope `company`). **Not** Supabase Auth.
- Platform auth = **application JWT** (same `JWT_SECRET`, scope `platform_admin`). There is **no** separate `PLATFORM_JWT_SECRET`.
- Integration secrets encrypted with `INTEGRATION_ENCRYPTION_KEY` (backend only).
- Rate limits are **in-memory** (OK for a single backend instance).

---

## 2. Hosting discovered in repo

| Service | Config found |
|---------|--------------|
| Backend | None (provider-neutral Node service) |
| Company Frontend | `vercel.json` SPA rewrite + `public/_redirects` |
| Super Admin | `vercel.json` SPA rewrite + `public/_redirects` |

Choose any HTTPS host that meets the requirements below. Do not invent domains here.

---

## 3. Production domain placeholders

Configure these **after** domains exist (Phase 15B):

```bash
COMPANY_APP_ORIGIN=https://<company-app-domain>
SUPER_ADMIN_ORIGIN=https://<admin-domain>
BACKEND_ORIGIN=https://<api-domain>
```

| Placeholder | Where configured |
|-------------|------------------|
| `BACKEND_ORIGIN` | Backend `APP_PUBLIC_BASE_URL`; Company/SA `VITE_API_BASE_URL` (build-time) |
| `COMPANY_APP_ORIGIN` | Backend `CORS_ALLOWED_ORIGINS`; SA `VITE_COMPANY_APP_BASE_URL` |
| `SUPER_ADMIN_ORIGIN` | Backend `CORS_ALLOWED_ORIGINS`; Backend `PLATFORM_ADMIN_PUBLIC_BASE_URL` |

All production URLs must be **HTTPS**.

---

## 4. Backend required environment variables

### REQUIRED (fail-fast in production)

| Variable | Purpose |
|----------|---------|
| `NODE_ENV=production` | Production behavior |
| `PORT` | Cloud listen port (host usually injects) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only DB access |
| `JWT_SECRET` | Signs company + platform JWTs |
| `INTEGRATION_ENCRYPTION_KEY` | 32-byte key (64 hex chars); ≠ `JWT_SECRET` |
| `APP_PUBLIC_BASE_URL` | Public HTTPS API origin for webhooks/OAuth |
| `CORS_ALLOWED_ORIGINS` | Comma-separated HTTPS origins (Company + Super Admin) |

### OPTIONAL

| Variable | Purpose |
|----------|---------|
| `TRUST_PROXY` | Default `1` in production (first reverse-proxy hop) |
| `EASYORDERS_API_BASE_URL` | Server-controlled EasyOrders host (default trusted URL) |
| `SHOPIFY_ADMIN_API_VERSION` | Default `2026-07` |
| `LOGIN_RATE_*` / `SIGNUP_RATE_*` / `WEBHOOK_RATE_*` / `PLATFORM_LOGIN_RATE_*` | Rate-limit knobs |
| `CATALOG_DUAL_WRITE_SHOPIFY` | Keep **false** / unset for production MVP |

### PROVIDER_SPECIFIC (required only if using that provider platform-wide)

| Variable | Purpose |
|----------|---------|
| `SALLA_OAUTH_CLIENT_ID` | Salla Partner App |
| `SALLA_OAUTH_CLIENT_SECRET` | Salla Partner App |
| `SALLA_OAUTH_REDIRECT_URI` | Must equal `{APP_PUBLIC_BASE_URL}/api/integrations/salla/oauth/callback` |
| `SALLA_OAUTH_STATE_SECRET` | OAuth state HMAC |
| `SALLA_APP_WEBHOOK_SECRET` | `POST /webhooks/salla/app` |
| `PLATFORM_ADMIN_PUBLIC_BASE_URL` | Super Admin origin after Salla OAuth |

Shopify / EasyOrders / Bosta **store credentials are per-company** (encrypted). Do not put store tokens in global env.

### DEVELOPMENT_ONLY

| Variable | Notes |
|----------|-------|
| Local `.env` localhost URLs | Never use in production |
| `supabase/seeds/dev_platform_admin.sql` | **Do not run in production** |
| `CATALOG_DUAL_WRITE_*` demo allowlists | Keep off |

---

## 5. Secret rules

**Backend only:** `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, provider OAuth secrets, encrypted integration credentials.

**Frontend (public):** `VITE_API_BASE_URL`, `VITE_COMPANY_APP_BASE_URL` only.

Never put service_role / JWT / encryption keys / provider tokens in Vite env or docs with real values.

---

## 6. Supabase project selection

Signup and catalog write RPCs intentionally refuse hosts other than:

`iydepmuniwybqgejawhf.supabase.co`

**Production MVP strategy:** deploy the backend against **that existing SaaS Supabase project** (set `SUPABASE_URL` / service role for it). Do not invent a second project in Phase 15B without an explicit host-allowlist change.

Employee auth is **not** Supabase Auth — no Auth redirect configuration is required for login/signup.

---

## 7. Migration procedure (NO Migration 016)

Migrations live in `supabase/migrations/` as `001` … `015`.

### New empty production database

Run **exactly once, in order:**

`001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015`

### Existing SaaS database (already applied)

**Do not rerun** historical migrations. Apply only migrations that are not yet recorded as applied.

### Absolute rules

- **NO Migration 016**
- Do **not** modify/rerun `013`, `014`, `015`
- Forward-only; no automatic destructive DB rollback

---

## 8. First Platform Super Admin bootstrap

There is **no** public platform-admin signup.

### Safe production procedure

1. Ensure migrations applied and backend env configured.
2. Generate a strong password (never commit it).
3. Run:

```bash
cd "<backend-repo>"
PLATFORM_ADMIN_EMAIL='ops@your-domain.com' \
PLATFORM_ADMIN_PASSWORD='<long-random-password>' \
PLATFORM_ADMIN_NAME='Platform Ops' \
node scripts/bootstrap-platform-admin.js --confirm
```

4. Sign in on Super Admin: `POST /api/platform/auth/login`.
5. If rotating an existing admin password, add `--force`.

`supabase/seeds/dev_platform_admin.sql` is **development only** — do not run in production.

---

## 9. Company signup production flow

1. User opens `{COMPANY_APP_ORIGIN}/signup`
2. Frontend `POST {VITE_API_BASE_URL}/api/public/signup`
3. Backend creates company + `company_admin` via `signup_company_workspace` RPC
4. Returns JWT → frontend stores session → navigates to `/getting-started`
5. No Platform Admin required for signup

---

## 10. Default feature flags

On signup, core features are enabled:

`orders`, `products`, `employees`, `analytics`

Disabled by design:

`bosta`, `imports`

### Enable Bosta for a shipping customer

1. Super Admin → Company → Features
2. Enable `bosta`
3. Company admin configures Bosta under Settings → Integrations (credentials self-service)
4. SKU mappings + Send to Bosta become available

---

## 11. Health check

```http
GET {BACKEND_ORIGIN}/health
```

Example response:

```json
{ "ok": true, "service": "saas-backend", "version": "1.0.0" }
```

No DB scan, no providers, no secrets.

Root `GET /` remains a human-readable liveness message.

---

## 12. CORS

```bash
CORS_ALLOWED_ORIGINS=https://<company-app-domain>,https://<admin-domain>
```

- No wildcards
- No-Origin requests (webhooks/server-to-server) continue to work
- Localhost origins are **not** allowed when `NODE_ENV=production`

---

## 13. Trust proxy

Production defaults to `trust proxy = 1` (first reverse-proxy hop). Compatible with typical Render/Railway/Fly/Nginx TLS termination.

Set explicitly if needed:

```bash
TRUST_PROXY=1
```

---

## 14. Webhook & OAuth paths

Base: `{APP_PUBLIC_BASE_URL}` (HTTPS). Tokenized URLs are generated on create/rotate; GET responses must not re-expose the live token URL.

| Provider | Path |
|----------|------|
| EasyOrders orders | `POST /webhooks/easyorders/:webhookToken/order-created` |
| Shopify orders | `POST /webhooks/shopify/:webhookToken/orders` |
| Salla orders | `POST /webhooks/salla/:webhookToken/orders` |
| Salla app lifecycle | `POST /webhooks/salla/app` |
| Bosta status | `POST /webhooks/bosta/:webhookToken/order-status` |
| Salla OAuth callback | `GET /api/integrations/salla/oauth/callback` |

### Shopify topics to register (Phase 15B, not now)

Against the Shopify webhook endpoint above:

- `orders/create`
- `orders/updated`
- `orders/cancelled`

### EasyOrders

Trusted API base is **server-controlled** (`EASYORDERS_API_BASE_URL` / default). Companies cannot override host.

### Bosta

Token authentication via URL path. Do not publish example tokens.

### Salla OAuth

Set Partner App redirect URI exactly to:

`{APP_PUBLIC_BASE_URL}/api/integrations/salla/oauth/callback`

---

## 15. Frontend environment

### Company Frontend

```bash
VITE_API_BASE_URL=https://<api-domain>
```

Build-time Vite variable (no trailing slash).

### Super Admin

```bash
VITE_API_BASE_URL=https://<api-domain>
VITE_COMPANY_APP_BASE_URL=https://<company-app-domain>
```

---

## 16. SPA routing / static assets

Both frontends need:

- Build output: `dist/`
- Rewrite all routes → `index.html` (see `vercel.json` / `public/_redirects`)
- Cache hashed `/assets/*` aggressively
- Do **not** aggressively cache `index.html`

Lazy route chunks from Performance Phase must be served from the same origin/root.

---

## 17. Build & start commands

Requires **Node.js 20+** (lockfiles present; no alternate package manager).

### Backend

```bash
npm ci
npm start
# or: NODE_ENV=production node src/server.js
```

### Company Frontend

```bash
npm ci
npm run build
# serve dist/ with SPA rewrite
```

### Super Admin

```bash
npm ci
npm run build
# serve dist/ with SPA rewrite
```

### Tests (pre-deploy gate)

```bash
# backend
npm test

# company frontend
npm test && npm run build

# super admin
npm test && npm run build
```

---

## 18. Persistent filesystem

Backend does **not** require durable local disk for orders, credentials, or imports (Supabase + encrypted DB columns). Ephemeral cloud filesystems are acceptable. Do not mount volumes for MVP business data.

---

## 19. Webhook reliability note

Prefer a backend instance that does **not** sleep:

- Provider webhooks may timeout on cold starts
- Salla OAuth callback can fail if the API is asleep
- Free sleeping tiers are risky for production webhooks

---

## 20. Exact deployment order (Phase 15B)

1. Confirm Supabase project (`iydepmuniwybqgejawhf.supabase.co`) + migrations state (`001`–`015`)
2. Set backend production env (secrets, `APP_PUBLIC_BASE_URL`, CORS)
3. Deploy backend
4. Verify `GET /health`
5. Build+deploy Company Frontend with `VITE_API_BASE_URL`
6. Build+deploy Super Admin with `VITE_API_BASE_URL` + `VITE_COMPANY_APP_BASE_URL`
7. Finalize CORS origins to real domains
8. Bootstrap first Platform Admin (`scripts/bootstrap-platform-admin.js --confirm`)
9. Smoke: platform login → company list
10. Smoke: `/signup` → JWT → `/getting-started` → bootstrap
11. Configure provider apps (Shopify topics, Salla OAuth redirect, EasyOrders/Bosta webhooks) using production webhook URLs
12. Live provider smoke (manual)
13. Enable `bosta` feature for shipping customers via Super Admin

---

## 21. Live smoke checklist (Phase 15B)

- [ ] `GET /health` → `ok: true`
- [ ] Platform admin login
- [ ] Company public signup + getting-started
- [ ] Company login via `/login/:companySlug`
- [ ] Bootstrap returns tenant data (no foreign tenants)
- [ ] Create Shopify/EasyOrders/Bosta connections (no secret leakage on GET)
- [ ] Rotate webhook once; GET hides token
- [ ] Manual product create/list
- [ ] Manual order create + details (0 provider calls on open)
- [ ] Analytics overview+trend
- [ ] Feature disable blocks API
- [ ] Company deactivate rejects JWT

---

## 22. Rollback (MVP)

| Layer | Action |
|-------|--------|
| Frontend | Redeploy previous `dist` / previous git commit build |
| Backend | Redeploy previous commit/image |
| Database | **No** automatic rollback; migrations are forward-only |
| Provider webhooks | Keep previous endpoint until new URL verified |

---

## 23. Logging

Allowed: safe error codes, provider names, non-secret integration ids, company ids.

Never log: passwords, JWTs, service_role, encryption keys, access tokens, webhook tokens, full credentials.

---

## 24. Rate limiting scale note

In-memory limiters are acceptable for **one** backend instance. If you scale horizontally, move rate limiting to a shared store later. Do not add Redis in MVP.

---

## Related files

- Backend `.env.example`
- Company Frontend `.env.example`
- Super Admin `.env.example`
- `scripts/bootstrap-platform-admin.js`
- `scripts/hash-dev-password.js` (hash helper only)
