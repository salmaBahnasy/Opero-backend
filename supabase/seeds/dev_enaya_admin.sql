-- =============================================================================
-- DEVELOPMENT SEED ONLY — Enaya company_admin
-- NEW SaaS Development database. Do NOT run against the old ERP project.
-- Do NOT run this in production.
-- =============================================================================
-- Depends on: supabase/seeds/dev_enaya_company.sql (slug = enaya)
-- Idempotent on (company_id, email).
-- Does NOT hardcode the company UUID — looks it up by slug.
--
-- Default development login (NOT a production password):
--   companySlug: enaya
--   email:       admin@enaya.local
--   password:    DevPassword123!
--
-- To use a different development password:
--   1. node scripts/hash-dev-password.js 'YourChosenDevPassword'
--   2. Replace the password hash below, then re-run this file
--      OR run:
--         update public.employees
--         set password = '<new bcrypt hash>'
--         where email = 'admin@enaya.local'
--           and company_id = (select id from public.companies where slug = 'enaya');
-- =============================================================================

insert into public.employees (
  company_id,
  name,
  email,
  password,
  role,
  is_active
)
select
  c.id,
  'Enaya Admin',
  'admin@enaya.local',
  '$2b$10$xch7HuCCVqJL.iOfzwIu/eYRNlvuFhbW9VNuII/r8A7ipVWpby3Kq',
  'company_admin',
  true
from public.companies c
where c.slug = 'enaya'
on conflict (company_id, email) do update
  set name = excluded.name,
      role = excluded.role,
      is_active = true;

-- select e.id, e.email, e.role, e.company_id
-- from public.employees e
-- join public.companies c on c.id = e.company_id
-- where c.slug = 'enaya' and e.email = 'admin@enaya.local';
