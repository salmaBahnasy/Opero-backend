-- =============================================================================
-- 001_core_saas.sql
-- NEW SaaS database only ("SaaS Development").
-- Do NOT run against the old single-store ERP Supabase project.
-- =============================================================================
-- Creates tenant, identity, and audit foundations.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.normalize_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.email is not null then
    new.email = lower(trim(new.email));
  end if;
  return new;
end;
$$;

create or replace function public.normalize_company_slug()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.slug = lower(trim(new.slug));
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- companies (SaaS tenants)
-- Soft-deactivate with is_active. Hard delete is intentionally difficult
-- because child FKs use ON DELETE RESTRICT (see later migrations).
-- -----------------------------------------------------------------------------

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  logo_url text,
  primary_color text,
  secondary_color text,
  timezone text not null default 'Africa/Cairo',
  currency text not null default 'EGP',
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_slug_format_chk
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint companies_slug_unique unique (slug)
);

comment on table public.companies is
  'SaaS customers / tenants. Branding lives here. Soft-deactivate via is_active; do not cascade-delete operational data.';

comment on column public.companies.slug is
  'Public tenant identifier for login routing and URLs. Unique globally.';

drop trigger if exists trg_companies_slug on public.companies;
create trigger trg_companies_slug
  before insert or update of slug
  on public.companies
  for each row
  execute function public.normalize_company_slug();

drop trigger if exists trg_companies_updated_at on public.companies;
create trigger trg_companies_updated_at
  before update on public.companies
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- platform_admins
-- SaaS owner / super-admin. NOT a company employee. Global identity.
-- -----------------------------------------------------------------------------

create table if not exists public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  password text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_admins_email_unique unique (email)
);

comment on table public.platform_admins is
  'Platform operators (SaaS owner / super-admin). Separate from employees so a company_admin is never treated as a platform owner.';

comment on column public.platform_admins.password is
  'Store a bcrypt (or stronger) hash only. Never store plaintext.';

drop trigger if exists trg_platform_admins_email on public.platform_admins;
create trigger trg_platform_admins_email
  before insert or update of email
  on public.platform_admins
  for each row
  execute function public.normalize_email();

drop trigger if exists trg_platform_admins_updated_at on public.platform_admins;
create trigger trg_platform_admins_updated_at
  before update on public.platform_admins
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- employees (tenant users)
-- Kept as `employees` to minimize later backend rename work.
-- Email is unique per company, not globally — same person may join two tenants.
-- Roles: company_admin | employee. `admin` is accepted as a legacy alias.
-- -----------------------------------------------------------------------------

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  name text not null,
  email text not null,
  password text not null,
  phone text,
  role text not null default 'employee',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_role_chk
    check (role in ('company_admin', 'admin', 'employee')),
  constraint employees_company_email_unique unique (company_id, email),
  constraint employees_id_company_unique unique (id, company_id)
);

comment on table public.employees is
  'Company-scoped users. company_admin is the tenant administrator. Platform owners live in platform_admins.';

comment on column public.employees.role is
  'company_admin | employee. Value `admin` is a legacy alias for company_admin (current ERP JWT uses admin).';

comment on column public.employees.password is
  'Store a bcrypt hash only. Current ERP hashes with bcryptjs cost 10.';

drop trigger if exists trg_employees_email on public.employees;
create trigger trg_employees_email
  before insert or update of email
  on public.employees
  for each row
  execute function public.normalize_email();

drop trigger if exists trg_employees_updated_at on public.employees;
create trigger trg_employees_updated_at
  before update on public.employees
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- audit_logs
-- company_id is nullable so platform-admin actions can be recorded too.
-- -----------------------------------------------------------------------------

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete restrict,
  actor_type text not null default 'employee',
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_logs_actor_type_chk
    check (actor_type in ('platform_admin', 'employee', 'system'))
);

comment on table public.audit_logs is
  'Who changed what. Backend should write here for orders, employees, integrations, features, and plan changes.';

comment on column public.audit_logs.company_id is
  'Tenant that owns the change. Null only for platform-level actions.';

comment on column public.audit_logs.actor_id is
  'employees.id or platform_admins.id depending on actor_type. No FK because actor_type is polymorphic.';
