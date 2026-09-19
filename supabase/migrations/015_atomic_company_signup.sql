-- =============================================================================
-- 015_atomic_company_signup.sql
-- ADDITIVE TRANSACTION PRIMITIVE ONLY. Do NOT run until approved.
-- SaaS Development only. Do NOT run against the old Enaya production project.
-- =============================================================================
-- Inspected APPLIED schema (do not alter tables/triggers here):
--   public.companies (
--     id uuid pk default gen_random_uuid(),
--     name text not null,
--     slug text not null,
--     logo_url text, primary_color text, secondary_color text,
--     login_image_url text, favicon_url text,
--     timezone text not null default 'Africa/Cairo',
--     currency text not null default 'EGP',
--     is_active boolean not null default true,
--     deleted_at timestamptz,
--     plan_id uuid null,
--     subscription_status text not null default 'none',
--     created_at timestamptz not null default now(),
--     updated_at timestamptz not null default now(),
--     companies_slug_format_chk slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$',
--     companies_slug_unique unique (slug)
--   )
--   AFTER INSERT public.companies:
--     trg_companies_provision_defaults
--       -> public.provision_company_defaults(new.id)
--          company_features: orders/products/employees/analytics enabled;
--          other active features inserted disabled;
--          company_order_sequences (1001)
--     trg_companies_order_sequence
--       -> public.ensure_company_order_sequence() (idempotent)
--   public.employees (
--     id uuid pk default gen_random_uuid(),
--     company_id uuid not null references companies on delete restrict,
--     name text not null,
--     email text not null,
--     password text not null,  -- bcrypt hash only
--     phone text,
--     role text not null default 'employee'
--       check (role in ('company_admin', 'admin', 'employee')),
--     is_active boolean not null default true,
--     unique (company_id, email)
--   )
--   Email uniqueness is per company, not global.
--
-- Executor RPC: public.signup_company_workspace(text, text, text, text, text)
-- One call = one PostgreSQL statement/transaction. No BEGIN/COMMIT/ROLLBACK.
-- SECURITY DEFINER + execute granted only to service_role.
-- Node hashes the password with existing bcryptjs and must never pass plaintext.
-- Does NOT duplicate provision_company_defaults.
-- =============================================================================

create or replace function public.signup_company_workspace(
  p_company_name text,
  p_slug text,
  p_admin_name text,
  p_admin_email text,
  p_password_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $signup$
declare
  v_company_name text;
  v_slug text;
  v_admin_name text;
  v_admin_email text;
  v_password_hash text;
  v_company public.companies%rowtype;
  v_employee public.employees%rowtype;
  v_constraint text;
begin
  v_company_name := nullif(btrim(p_company_name), '');
  v_slug := lower(nullif(btrim(p_slug), ''));
  v_admin_name := nullif(btrim(p_admin_name), '');
  v_admin_email := lower(nullif(btrim(p_admin_email), ''));
  v_password_hash := nullif(btrim(p_password_hash), '');

  if v_company_name is null
     or char_length(v_company_name) > 200
     or v_slug is null
     or char_length(v_slug) < 2
     or char_length(v_slug) > 63
     or v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or v_slug in (
       'admin',
       'api',
       'login',
       'signup',
       'settings',
       'dashboard',
       'platform',
       'www'
     )
     or v_admin_name is null
     or char_length(v_admin_name) > 200
     or v_admin_email is null
     or v_admin_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or v_password_hash is null
     or v_password_hash !~ '^[$]2[aby][$][0-9]{2}[$][A-Za-z0-9./]{53}$'
  then
    raise exception using
      errcode = 'P0001',
      message = 'SIGNUP_INVALID_INPUT: company name, slug, admin identity, or password hash is invalid',
      hint = 'SIGNUP_INVALID_INPUT';
  end if;

  insert into public.companies (name, slug)
  values (v_company_name, v_slug)
  returning * into v_company;

  insert into public.employees (
    company_id,
    name,
    email,
    password,
    role,
    is_active
  )
  values (
    v_company.id,
    v_admin_name,
    v_admin_email,
    v_password_hash,
    'company_admin',
    true
  )
  returning * into v_employee;

  return jsonb_build_object(
    'companyId', v_company.id,
    'companySlug', v_company.slug,
    'companyName', v_company.name,
    'employeeId', v_employee.id,
    'employeeEmail', v_employee.email,
    'employeeName', v_employee.name,
    'role', v_employee.role
  );

exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'companies_slug_unique' then
      raise exception using
        errcode = 'P0001',
        message = 'SIGNUP_SLUG_CONFLICT: workspace slug already exists',
        hint = 'SIGNUP_SLUG_CONFLICT';
    end if;
    if v_constraint = 'employees_company_email_unique' then
      raise exception using
        errcode = 'P0001',
        message = 'SIGNUP_EMPLOYEE_CONFLICT: employee email already exists for this company',
        hint = 'SIGNUP_EMPLOYEE_CONFLICT';
    end if;
    raise;
end;
$signup$;

comment on function public.signup_company_workspace(text, text, text, text, text) is
  'Atomically creates a company and its first company_admin. Call from the Node service_role backend only. Password argument is a bcrypt hash, never plaintext. Existing company-insert triggers provision MVP defaults.';

revoke all on function public.signup_company_workspace(text, text, text, text, text) from public;

do $priv$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.signup_company_workspace(text, text, text, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.signup_company_workspace(text, text, text, text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.signup_company_workspace(text, text, text, text, text) to service_role';
  end if;
end;
$priv$;

notify pgrst, 'reload schema';
