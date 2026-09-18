-- =============================================================================
-- 004_features_plans.sql
-- NEW SaaS database only. Do NOT run against the old ERP project.
-- =============================================================================
-- Feature flags, subscription plans, company ↔ plan relationship.
-- No payment provider is wired here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- features (global catalog)
-- -----------------------------------------------------------------------------

create table if not exists public.features (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint features_key_unique unique (key),
  constraint features_key_format_chk check (key ~ '^[a-z][a-z0-9_]*$')
);

comment on table public.features is
  'Global feature catalog. Entitlement per tenant is stored in company_features.';

drop trigger if exists trg_features_updated_at on public.features;
create trigger trg_features_updated_at
  before update on public.features
  for each row
  execute function public.set_updated_at();

insert into public.features (key, name, description)
values
  ('orders', 'Orders', 'Order inbox, status, filters, and exports'),
  ('products', 'Products', 'Product catalog and EasyOrders product sync'),
  ('employees', 'Employees', 'Company users and roles'),
  ('analytics', 'Analytics', 'Dashboard stats, charts, and order-cost reports'),
  ('easyorders', 'EasyOrders', 'EasyOrders webhook + API integration'),
  ('bosta', 'Bosta', 'Bosta fulfillment, locations, and SKU mapping'),
  ('salla', 'Salla', 'Salla store integration'),
  ('shopify', 'Shopify', 'Shopify store integration'),
  ('whatsapp', 'WhatsApp', 'WhatsApp confirmation / messaging'),
  ('ai', 'AI', 'Future AI features')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- company_features
-- -----------------------------------------------------------------------------

create table if not exists public.company_features (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  feature_id uuid not null references public.features (id) on delete restrict,
  is_enabled boolean not null default false,
  configuration jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_features_unique unique (company_id, feature_id)
);

comment on table public.company_features is
  'Which features a tenant may use. Platform admin toggles is_enabled. configuration is optional per-feature JSON.';

drop trigger if exists trg_company_features_updated_at on public.company_features;
create trigger trg_company_features_updated_at
  before update on public.company_features
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- plans
-- -----------------------------------------------------------------------------

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  price numeric(12, 2) not null default 0,
  billing_period text not null default 'monthly',
  max_employees integer,
  max_orders_per_month integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_code_unique unique (code),
  constraint plans_billing_period_chk check (billing_period in ('monthly', 'yearly')),
  constraint plans_price_chk check (price >= 0),
  constraint plans_max_employees_chk check (max_employees is null or max_employees >= 0),
  constraint plans_max_orders_chk check (max_orders_per_month is null or max_orders_per_month >= 0)
);

comment on table public.plans is
  'SaaS plan catalog. max_* null means unlimited. Prices are placeholders — no payment provider yet.';

drop trigger if exists trg_plans_updated_at on public.plans;
create trigger trg_plans_updated_at
  before update on public.plans
  for each row
  execute function public.set_updated_at();

insert into public.plans (
  name,
  code,
  price,
  billing_period,
  max_employees,
  max_orders_per_month,
  is_active
)
values
  ('Starter', 'starter', 0, 'monthly', 3, 500, true),
  ('Growth', 'growth', 0, 'monthly', 15, 3000, true),
  ('Scale', 'scale', 0, 'monthly', null, null, true)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- companies.plan_id (current plan) + subscription history
-- Added here because `plans` did not exist in 001.
-- ON DELETE RESTRICT: do not drop a plan that companies still reference.
-- -----------------------------------------------------------------------------

alter table public.companies
  add column if not exists plan_id uuid references public.plans (id) on delete restrict;

alter table public.companies
  add column if not exists subscription_status text not null default 'none';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'companies_subscription_status_chk'
  ) then
    alter table public.companies
      add constraint companies_subscription_status_chk
      check (subscription_status in ('none', 'trial', 'active', 'past_due', 'canceled'));
  end if;
end
$$;

comment on column public.companies.plan_id is
  'Current plan. History lives in company_subscriptions. No payment provider yet.';

create table if not exists public.company_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  plan_id uuid not null references public.plans (id) on delete restrict,
  status text not null default 'trial',
  started_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_subscriptions_status_chk
    check (status in ('trial', 'active', 'past_due', 'canceled'))
);

comment on table public.company_subscriptions is
  'Plan assignment history per company. Ready for a future billing provider; not connected yet.';

drop trigger if exists trg_company_subscriptions_updated_at on public.company_subscriptions;
create trigger trg_company_subscriptions_updated_at
  before update on public.company_subscriptions
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Default entitlements for a newly created company:
--   core: orders, products, employees, analytics → enabled
--   integrations / ai → disabled until the platform owner turns them on
-- -----------------------------------------------------------------------------

create or replace function public.provision_company_defaults(p_company_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into public.company_features (company_id, feature_id, is_enabled)
  select
    p_company_id,
    f.id,
    f.key in ('orders', 'products', 'employees', 'analytics')
  from public.features f
  where f.is_active = true
  on conflict (company_id, feature_id) do nothing;

  insert into public.company_order_sequences (company_id, next_value, start_value)
  values (p_company_id, 1001, 1001)
  on conflict (company_id) do nothing;
end;
$$;

create or replace function public.trg_provision_company_defaults()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.provision_company_defaults(new.id);
  return new;
end;
$$;

drop trigger if exists trg_companies_provision_defaults on public.companies;
create trigger trg_companies_provision_defaults
  after insert on public.companies
  for each row
  execute function public.trg_provision_company_defaults();
