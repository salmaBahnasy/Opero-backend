-- =============================================================================
-- DEVELOPMENT SEED ONLY — Platform Super Admin
-- NEW SaaS Development database. Do NOT run against the old ERP project.
-- Do NOT run this in production.
-- =============================================================================
-- Default development login (NOT a production password):
--   POST /api/platform/auth/login
--   email:    platform@saas.local
--   password: DevPassword123!
-- =============================================================================

insert into public.platform_admins (name, email, password, is_active)
values (
  'Platform Super Admin',
  'platform@saas.local',
  '$2b$10$xch7HuCCVqJL.iOfzwIu/eYRNlvuFhbW9VNuII/r8A7ipVWpby3Kq',
  true
)
on conflict (email) do update
  set name = excluded.name,
      is_active = true;
