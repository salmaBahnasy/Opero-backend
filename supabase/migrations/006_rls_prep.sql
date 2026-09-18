-- =============================================================================
-- 006_rls_prep.sql
-- NEW SaaS database only. Do NOT run against the old ERP project.
-- =============================================================================
-- Prepares helpers for a later RLS rollout. Does NOT enable restrictive RLS.
--
-- Why RLS is not enabled now
-- --------------------------
-- The current backend uses the Supabase service_role key for every query.
-- service_role bypasses RLS, so enabling RLS with no policies would not break
-- service_role — but it would silently lock out anon/authenticated if anyone
-- pointed a client at this project. More importantly, the existing queries do
-- not set `request.jwt.claims` or `app.company_id`, so tenant policies would
-- have nothing to key off yet.
--
-- Recommended future RLS strategy (do this only after the backend always
-- sends company_id and never relies on RLS as the only isolation layer)
-- ---------------------------------------------------------------------
-- 1. Keep using service_role in the Node backend for webhooks and admin jobs.
--    Tenant isolation MUST be enforced in application queries:
--      .eq("company_id", req.company.id)
--    RLS is defense-in-depth, not the primary control.
--
-- 2. When you introduce a user-scoped Supabase client (anon / authenticated):
--      alter table public.orders enable row level security;
--    and add policies such as:
--      create policy orders_tenant_isolation on public.orders
--        for all
--        using (company_id = public.app_current_company_id())
--        with check (company_id = public.app_current_company_id());
--
-- 3. Set the tenant at the start of each request, either:
--      select set_config('app.company_id', '<uuid>', true);
--    or by putting company_id in the JWT and reading
--      auth.jwt() ->> 'company_id'
--
-- 4. Enable RLS on every tenant-scoped table, never on global lookup tables
--    (features, plans, bosta_cities, bosta_districts) unless you want to
--    hide inactive catalog rows.
--
-- 5. platform_admins should use a separate policy (or service_role only).
--    Do not give company JWTs permission to read other companies.
--
-- 6. Do not enable FORCE ROW LEVEL SECURITY on tables the service_role must
--    write during webhooks unless you also add an explicit service policy.
-- =============================================================================

create or replace function public.app_current_company_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(current_setting('app.company_id', true), '')::uuid;
$$;

comment on function public.app_current_company_id() is
  'Reads SET LOCAL app.company_id. Used by future RLS policies. Returns null if unset — do not enable RLS until the backend always sets this (or a JWT claim).';

-- Reload PostgREST so the new public tables are visible immediately.
notify pgrst, 'reload schema';
