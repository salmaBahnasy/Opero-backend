-- =============================================================================
-- 003_integrations.sql
-- NEW SaaS database only. Do NOT run against the old ERP project.
-- =============================================================================
-- Per-company integration credentials/settings, Bosta lookup + mapping tables,
-- and daily order-cost snapshots.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- company_integrations
-- Structure only. Do NOT insert production API keys or tokens here.
-- Application must encrypt credentials before write (or use a secret manager).
-- -----------------------------------------------------------------------------

create table if not exists public.company_integrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  provider text not null,
  is_enabled boolean not null default false,
  credentials jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_integrations_provider_chk
    check (provider in ('easyorders', 'bosta', 'salla', 'shopify', 'whatsapp')),
  constraint company_integrations_company_provider_unique unique (company_id, provider)
);

comment on table public.company_integrations is
  'Per-tenant integration config. credentials is a placeholder JSON object — encrypt at the application layer before storing.';

comment on column public.company_integrations.credentials is
  'NEVER store plaintext production secrets in migrations or seeds. Encrypt in the app, or use a secret manager, then store a reference / ciphertext here.';

drop trigger if exists trg_company_integrations_updated_at on public.company_integrations;
create trigger trg_company_integrations_updated_at
  before update on public.company_integrations
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- bosta_cities / bosta_districts
-- GLOBAL shared Egypt geography from Bosta. Not tenant-scoped.
-- Primary keys stay as Bosta's own text ids because the current backend
-- upserts onConflict: "id".
-- -----------------------------------------------------------------------------

create table if not exists public.bosta_cities (
  id text primary key,
  name text,
  name_ar text,
  code text,
  alias text,
  hub_id text,
  hub_name text,
  sector integer,
  pickup_availability boolean default true,
  drop_off_availability boolean default true,
  show_as_drop_off boolean default true,
  show_as_pickup boolean default true,
  raw_data jsonb,
  synced_at timestamptz default now()
);

comment on table public.bosta_cities is
  'Global Bosta Egypt city reference. Shared by all tenants.';

create table if not exists public.bosta_districts (
  id text primary key,
  city_id text not null references public.bosta_cities (id) on delete cascade,
  zone_id text,
  zone_name text,
  zone_other_name text,
  district_name text,
  district_other_name text,
  pickup_availability boolean default true,
  drop_off_availability boolean default true,
  raw_data jsonb,
  synced_at timestamptz default now()
);

comment on table public.bosta_districts is
  'Global Bosta Egypt district reference. Cascades with its city because it is lookup data, not tenant history.';

-- -----------------------------------------------------------------------------
-- bosta_sku_mappings
-- Tenant-scoped. Old unique (mapping_type, entity_id) becomes
-- (company_id, mapping_type, entity_id).
-- -----------------------------------------------------------------------------

create table if not exists public.bosta_sku_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  mapping_type text not null,
  entity_id text not null,
  product_id text,
  name text not null default '',
  size text,
  skus jsonb not null default '[]'::jsonb,
  sizes jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bosta_sku_mappings_type_chk
    check (mapping_type in ('product', 'variant', 'size')),
  constraint bosta_sku_mappings_company_entity_unique
    unique (company_id, mapping_type, entity_id)
);

comment on table public.bosta_sku_mappings is
  'Per-company EasyOrders entity → Bosta SKU mapping. entity_id is unique only inside a company.';

drop trigger if exists trg_bosta_sku_mappings_updated_at on public.bosta_sku_mappings;
create trigger trg_bosta_sku_mappings_updated_at
  before update on public.bosta_sku_mappings
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- bosta_unmapped_products
-- Old PK was product_id text. SaaS PK is uuid; uniqueness is per company.
-- Backend currently upserts onConflict: "product_id" — must become
-- onConflict: "company_id,product_id".
-- -----------------------------------------------------------------------------

create table if not exists public.bosta_unmapped_products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id text not null,
  name text not null default '',
  reason text not null default '',
  updated_at timestamptz not null default now(),
  constraint bosta_unmapped_products_company_product_unique unique (company_id, product_id)
);

comment on table public.bosta_unmapped_products is
  'Products that could not be mapped to a Bosta SKU, scoped per company.';

drop trigger if exists trg_bosta_unmapped_products_updated_at on public.bosta_unmapped_products;
create trigger trg_bosta_unmapped_products_updated_at
  before update on public.bosta_unmapped_products
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- order_cost_daily
-- Old unique(cost_date) becomes unique(company_id, cost_date).
-- Backend currently upserts onConflict: "cost_date".
-- -----------------------------------------------------------------------------

create table if not exists public.order_cost_daily (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  cost_date date not null,
  expense numeric(14, 2) not null default 0,
  total_orders integer not null default 0,
  shipped_orders integer not null default 0,
  successful_orders integer not null default 0,
  total_sales numeric(14, 2) not null default 0,
  shipped_sales numeric(14, 2) not null default 0,
  successful_sales numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_cost_daily_company_date_unique unique (company_id, cost_date)
);

comment on table public.order_cost_daily is
  'Per-company daily expense + cached order/sales counts for cost-per-order charts.';

drop trigger if exists trg_order_cost_daily_updated_at on public.order_cost_daily;
create trigger trg_order_cost_daily_updated_at
  before update on public.order_cost_daily
  for each row
  execute function public.set_updated_at();
