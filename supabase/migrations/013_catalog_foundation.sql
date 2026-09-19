-- =============================================================================
-- 013_catalog_foundation.sql
-- ADDITIVE SCHEMA FOUNDATION ONLY. Do NOT run until approved.
-- SaaS Development only (project ref iydepmuniwybqgejawhf).
-- Do NOT run against the old Enaya production Supabase project.
-- =============================================================================
-- Provider-neutral internal catalog:
--   sales channel  →  catalog_source_mappings
--   internal       →  products + product_variants + options
--   fulfillment    →  fulfillment_item_mappings
--
-- Compatibility preserved:
--   products.easyorder_id / sku / raw_data / source_integration_id / import_batch_id
--   orders.raw_data (including cart_items)
--   bosta_sku_mappings (unchanged; no backfill)
--
-- NO DATA BACKFILL:
--   no default variants, no raw_data.variants parse, no source/Bosta conversion,
--   no order_items population.
-- Does not enable RLS. Does not change features/plans or provider CHECK.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) products.product_type
-- Existing rows receive DEFAULT 'simple' because today's catalog has no
-- first-class variants. Later backfill may promote variable/bundle.
-- Compatibility columns are not renamed or dropped.
-- -----------------------------------------------------------------------------
alter table public.products
  add column if not exists product_type text not null default 'simple';

alter table public.products
  drop constraint if exists products_product_type_chk;

alter table public.products
  add constraint products_product_type_chk
    check (product_type in ('simple', 'variable', 'bundle'));

comment on column public.products.product_type is
  'simple | variable | bundle. Parent catalog card only. Sellable identity is product_variants. Existing rows default to simple until a later backfill.';

comment on column public.products.sku is
  'COMPATIBILITY ONLY. Canonical merchant SKU is product_variants.internal_sku. Do not treat products.sku as identity.';

comment on column public.products.easyorder_id is
  'COMPATIBILITY: external product id for EasyOrders / Shopify / Salla / local hash-*. Canonical channel identity moves to catalog_source_mappings.';

comment on column public.products.raw_data is
  'Provider payload compatibility. Nested variants remain here until dual-write/backfill. Do not drop.';

-- -----------------------------------------------------------------------------
-- 2) product_variants
-- Every sellable item will later have at least one variant (including a hidden
-- default for simple products). This migration does NOT insert those rows.
--
-- Product delete: CASCADE variants (catalog structure). Historical order_items
-- keep snapshots; catalog FKs on order_items are nulled by trigger (section 10).
-- Company delete stays RESTRICT via companies FK.
-- -----------------------------------------------------------------------------
create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id uuid not null,
  title text,
  internal_sku text,
  barcode text,
  price numeric(14, 2),
  compare_at_price numeric(14, 2),
  is_default boolean not null default false,
  is_active boolean not null default true,
  position integer not null default 0,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_variants_id_company_unique unique (id, company_id),
  constraint product_variants_id_product_company_unique unique (id, product_id, company_id),
  constraint product_variants_internal_sku_nonempty_chk
    check (internal_sku is null or length(trim(internal_sku)) > 0),
  constraint product_variants_barcode_nonempty_chk
    check (barcode is null or length(trim(barcode)) > 0),
  constraint product_variants_product_company_fk
    foreign key (product_id, company_id)
    references public.products (id, company_id)
    on delete cascade
);

comment on table public.product_variants is
  'Canonical sellable catalog grain. Simple products get a hidden default variant in a later backfill, not in this migration.';

comment on column public.product_variants.internal_sku is
  'Merchant-facing SaaS SKU. Unique per company when not null. Distinct from channel SKU and fulfillment SKU.';

comment on column public.product_variants.barcode is
  'Optional barcode/GTIN. Unique per company when not null.';

comment on column public.product_variants.price is
  'Catalog list price. numeric(14,2) matches orders.total_amount / order_items.unit_price.';

comment on column public.product_variants.raw_data is
  'Leftover provider variant fields (GIDs, metafields). Not identity.';

drop trigger if exists trg_product_variants_updated_at on public.product_variants;
create trigger trg_product_variants_updated_at
  before update on public.product_variants
  for each row
  execute function public.set_updated_at();

-- At most one default variant per product (zero defaults allowed until backfill).
create unique index if not exists product_variants_one_default_uidx
  on public.product_variants (company_id, product_id)
  where is_default = true;

create unique index if not exists product_variants_company_internal_sku_uidx
  on public.product_variants (company_id, internal_sku)
  where internal_sku is not null;

create unique index if not exists product_variants_company_barcode_uidx
  on public.product_variants (company_id, barcode)
  where barcode is not null;

create index if not exists product_variants_company_product_idx
  on public.product_variants (company_id, product_id, position);

-- -----------------------------------------------------------------------------
-- 3) product_options  (arbitrary dimensions: Color, Size, Crust, Height, …)
-- No hardcoded size/color columns.
-- -----------------------------------------------------------------------------
create table if not exists public.product_options (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id uuid not null,
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_options_name_nonempty_chk
    check (length(trim(name)) > 0),
  constraint product_options_id_company_unique unique (id, company_id),
  constraint product_options_id_product_company_unique unique (id, product_id, company_id),
  constraint product_options_product_name_unique unique (company_id, product_id, name),
  constraint product_options_product_company_fk
    foreign key (product_id, company_id)
    references public.products (id, company_id)
    on delete cascade
);

comment on table public.product_options is
  'Per-product option dimensions. Names are merchant-defined; never size/color columns.';

drop trigger if exists trg_product_options_updated_at on public.product_options;
create trigger trg_product_options_updated_at
  before update on public.product_options
  for each row
  execute function public.set_updated_at();

create index if not exists product_options_company_product_idx
  on public.product_options (company_id, product_id, position);

-- -----------------------------------------------------------------------------
-- 4) product_option_values
-- product_id is denormalized so values cannot be attached to another product
-- through a weak option FK.
-- unique (id, option_id, company_id) lets variant_option_values require that
-- a chosen value belongs to that exact option (and tenant).
-- -----------------------------------------------------------------------------
create table if not exists public.product_option_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id uuid not null,
  option_id uuid not null,
  value text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_option_values_value_nonempty_chk
    check (length(trim(value)) > 0),
  constraint product_option_values_id_company_unique unique (id, company_id),
  constraint product_option_values_id_option_company_unique unique (id, option_id, company_id),
  constraint product_option_values_option_value_unique unique (company_id, option_id, value),
  constraint product_option_values_option_product_company_fk
    foreign key (option_id, product_id, company_id)
    references public.product_options (id, product_id, company_id)
    on delete cascade
);

comment on table public.product_option_values is
  'Values for one product option (e.g. Black, XL, Thin crust). Bound to option + product + company.';

drop trigger if exists trg_product_option_values_updated_at on public.product_option_values;
create trigger trg_product_option_values_updated_at
  before update on public.product_option_values
  for each row
  execute function public.set_updated_at();

create index if not exists product_option_values_option_idx
  on public.product_option_values (company_id, option_id, position);

-- -----------------------------------------------------------------------------
-- 5) variant_option_values
-- One value per option per variant. product_id binds variant and option to the
-- same parent product. option_value_id + option_id binds value to that option.
-- -----------------------------------------------------------------------------
create table if not exists public.variant_option_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id uuid not null,
  variant_id uuid not null,
  option_id uuid not null,
  option_value_id uuid not null,
  created_at timestamptz not null default now(),
  constraint variant_option_values_id_company_unique unique (id, company_id),
  constraint variant_option_values_variant_option_unique unique (company_id, variant_id, option_id),
  constraint variant_option_values_variant_product_company_fk
    foreign key (variant_id, product_id, company_id)
    references public.product_variants (id, product_id, company_id)
    on delete cascade,
  constraint variant_option_values_option_product_company_fk
    foreign key (option_id, product_id, company_id)
    references public.product_options (id, product_id, company_id)
    on delete cascade,
  constraint variant_option_values_value_option_company_fk
    foreign key (option_value_id, option_id, company_id)
    references public.product_option_values (id, option_id, company_id)
    on delete cascade
);

comment on table public.variant_option_values is
  'Assigns option values to a variant. Unique (company, variant, option) prevents two sizes on one variant. Value FK includes option_id so a Color value cannot be used as Size.';

create index if not exists variant_option_values_variant_idx
  on public.variant_option_values (company_id, variant_id);

create index if not exists variant_option_values_option_value_idx
  on public.variant_option_values (company_id, option_value_id);

-- -----------------------------------------------------------------------------
-- 6) catalog_source_mappings
-- Exact sales-channel identity → internal product/variant.
-- Identity includes integration UUID, never provider alone.
--
-- external_variant_id is NOT NULL default '' (empty string = default/simple
-- channel variant). PostgreSQL UNIQUE treats NULLs as distinct, so a nullable
-- column would allow duplicate (store, product, NULL) rows. Empty string is
-- the portable strategy; NULLS NOT DISTINCT is not required.
--
-- Integration delete: RESTRICT (do not weaken attributed identity / INTEGRATION_IN_USE).
-- Product/variant delete: CASCADE (operational mapping, not order history).
-- -----------------------------------------------------------------------------
create table if not exists public.catalog_source_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  integration_id uuid not null,
  external_product_id text not null,
  external_variant_id text not null default '',
  internal_product_id uuid not null,
  internal_variant_id uuid not null,
  external_sku text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_source_mappings_id_company_unique unique (id, company_id),
  constraint catalog_source_mappings_external_ids_nonempty_chk
    check (length(trim(external_product_id)) > 0),
  constraint catalog_source_mappings_identity_unique
    unique (company_id, integration_id, external_product_id, external_variant_id),
  constraint catalog_source_mappings_integration_company_fk
    foreign key (integration_id, company_id)
    references public.company_integrations (id, company_id)
    on delete restrict,
  constraint catalog_source_mappings_product_company_fk
    foreign key (internal_product_id, company_id)
    references public.products (id, company_id)
    on delete cascade,
  constraint catalog_source_mappings_variant_product_company_fk
    foreign key (internal_variant_id, internal_product_id, company_id)
    references public.product_variants (id, product_id, company_id)
    on delete cascade
);

comment on table public.catalog_source_mappings is
  'Maps one sales-channel connection (EasyOrders / Shopify / Salla / spreadsheet / future) to an internal variant. Same external ids on two stores are two rows.';

comment on column public.catalog_source_mappings.integration_id is
  'Exact company_integrations.id. Never identify source by provider name.';

comment on column public.catalog_source_mappings.external_variant_id is
  'Provider variant id. Empty string = channel product with no distinct variant id / default variant. NOT NULL so UNIQUE is deterministic.';

comment on column public.catalog_source_mappings.external_sku is
  'SKU as reported by the sales channel. Not internal_sku and not fulfillment SKU.';

drop trigger if exists trg_catalog_source_mappings_updated_at on public.catalog_source_mappings;
create trigger trg_catalog_source_mappings_updated_at
  before update on public.catalog_source_mappings
  for each row
  execute function public.set_updated_at();

create index if not exists catalog_source_mappings_variant_idx
  on public.catalog_source_mappings (company_id, internal_variant_id);

create index if not exists catalog_source_mappings_product_idx
  on public.catalog_source_mappings (company_id, internal_product_id);

-- -----------------------------------------------------------------------------
-- 7) fulfillment_item_mappings
-- Internal variant → one or more fulfillment SKUs (Bosta is one adapter).
-- Does NOT replace bosta_sku_mappings. No backfill.
--
-- Multiple SKUs per variant+account are legal (priority for stock fallback).
-- Shipping integration delete: RESTRICT so mappings are not silently dropped
-- if application INTEGRATION_IN_USE is bypassed. Matches orders RESTRICT
-- posture more than bosta_sku_mappings CASCADE; table is empty until later.
-- Variant delete: CASCADE (operational).
-- -----------------------------------------------------------------------------
create table if not exists public.fulfillment_item_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  shipping_integration_id uuid not null,
  internal_variant_id uuid not null,
  external_sku text not null,
  external_item_id text,
  priority integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fulfillment_item_mappings_id_company_unique unique (id, company_id),
  constraint fulfillment_item_mappings_sku_nonempty_chk
    check (length(trim(external_sku)) > 0),
  constraint fulfillment_item_mappings_identity_unique
    unique (
      company_id,
      shipping_integration_id,
      internal_variant_id,
      external_sku
    ),
  constraint fulfillment_item_mappings_shipping_company_fk
    foreign key (shipping_integration_id, company_id)
    references public.company_integrations (id, company_id)
    on delete restrict,
  constraint fulfillment_item_mappings_variant_company_fk
    foreign key (internal_variant_id, company_id)
    references public.product_variants (id, company_id)
    on delete cascade
);

comment on table public.fulfillment_item_mappings is
  'Provider-neutral fulfillment SKU map. Bosta/Mylerz/warehouse are adapters. bosta_sku_mappings remains until a later conversion phase.';

comment on column public.fulfillment_item_mappings.shipping_integration_id is
  'Exact shipping connection UUID. Application should require category=shipping; DB enforces same-company.';

comment on column public.fulfillment_item_mappings.priority is
  'Lower sends first when several SKUs exist for the same variant+account. Same priority is allowed.';

drop trigger if exists trg_fulfillment_item_mappings_updated_at on public.fulfillment_item_mappings;
create trigger trg_fulfillment_item_mappings_updated_at
  before update on public.fulfillment_item_mappings
  for each row
  execute function public.set_updated_at();

-- identity UNIQUE already covers (company, shipping, variant) prefix lookups.

-- -----------------------------------------------------------------------------
-- 8) bundle_components
-- Schema foundation only. No explosion/send behavior in this phase.
-- Self-reference is blocked. Recursive kits are not detected in SQL.
-- Either variant delete: CASCADE (catalog composition). Order history uses
-- order_items.components_snapshot, not this table.
-- -----------------------------------------------------------------------------
create table if not exists public.bundle_components (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  bundle_variant_id uuid not null,
  component_variant_id uuid not null,
  quantity integer not null default 1,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bundle_components_id_company_unique unique (id, company_id),
  constraint bundle_components_quantity_chk check (quantity > 0),
  constraint bundle_components_not_self_chk
    check (bundle_variant_id <> component_variant_id),
  constraint bundle_components_pair_unique
    unique (company_id, bundle_variant_id, component_variant_id),
  constraint bundle_components_bundle_variant_company_fk
    foreign key (bundle_variant_id, company_id)
    references public.product_variants (id, company_id)
    on delete cascade,
  constraint bundle_components_component_variant_company_fk
    foreign key (component_variant_id, company_id)
    references public.product_variants (id, company_id)
    on delete cascade
);

comment on table public.bundle_components is
  'Kit/combo composition: bundle sellable variant → component variants × quantity. Behavior not implemented in C1A.';

drop trigger if exists trg_bundle_components_updated_at on public.bundle_components;
create trigger trg_bundle_components_updated_at
  before update on public.bundle_components
  for each row
  execute function public.set_updated_at();

create index if not exists bundle_components_bundle_idx
  on public.bundle_components (company_id, bundle_variant_id, position);

create index if not exists bundle_components_component_idx
  on public.bundle_components (company_id, component_variant_id);

-- -----------------------------------------------------------------------------
-- 9) order_items — evolve in place (do not create order_lines)
--
-- Reuse existing columns:
--   product_id              = internal product UUID (nullable)
--   external_product_id     = channel product id
--   product_name            = name snapshot
--   sku                     = SKU snapshot
--   unit_price              = unit price snapshot
--   total_price             = line total snapshot
--   raw_data                = leftover provider payload (no second metadata column)
--
-- Add:
--   variant_id, source_integration_id, external_variant_id, variant_name,
--   options_snapshot, discount_amount, is_bundle, components_snapshot
--
-- 002's order_items_product_company_fk used ON DELETE SET NULL on
-- (product_id, company_id). PostgreSQL nulls EVERY FK column, which cannot
-- null company_id (NOT NULL). That made product delete fail instead of
-- clearing product_id. Replace with RESTRICT + BEFORE DELETE triggers that
-- null only catalog columns (same portable pattern as 012 import_batch_id).
-- MATCH SIMPLE: NULL variant_id / product_id / source_integration_id skips FK.
-- -----------------------------------------------------------------------------
alter table public.order_items
  add column if not exists variant_id uuid,
  add column if not exists source_integration_id uuid,
  add column if not exists external_variant_id text,
  add column if not exists variant_name text,
  add column if not exists options_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists discount_amount numeric(14, 2),
  add column if not exists is_bundle boolean not null default false,
  add column if not exists components_snapshot jsonb not null default '[]'::jsonb;

comment on column public.order_items.product_id is
  'Internal products.id snapshot link. Nullable. Historical lines survive catalog deletion (trigger nulls this column).';

comment on column public.order_items.variant_id is
  'Internal product_variants.id snapshot link. Nullable. Canonical sellable grain once writers dual-write.';

comment on column public.order_items.source_integration_id is
  'Commerce connection for this line when known. ON DELETE RESTRICT. Null = unknown/manual.';

comment on column public.order_items.external_variant_id is
  'Channel variant id snapshot. Independent of catalog_source_mappings.';

comment on column public.order_items.product_name is
  'Immutable-ish product title snapshot.';

comment on column public.order_items.variant_name is
  'Immutable-ish variant title / option summary snapshot.';

comment on column public.order_items.options_snapshot is
  'Copied option name/value pairs at order time. Survives option deletion.';

comment on column public.order_items.sku is
  'SKU snapshot at order time. Not a live catalog join key.';

comment on column public.order_items.discount_amount is
  'Line discount as received from the channel. Not a SaaS promotion engine.';

comment on column public.order_items.total_price is
  'Line total snapshot (after line discount when the channel supplied it).';

comment on column public.order_items.components_snapshot is
  'Frozen bundle explosion (component variant ids/SKUs/qty) at order time.';

comment on column public.order_items.raw_data is
  'Provider leftover payload. Use this instead of a duplicate metadata column.';

alter table public.order_items
  drop constraint if exists order_items_product_company_fk;

alter table public.order_items
  add constraint order_items_product_company_fk
    foreign key (product_id, company_id)
    references public.products (id, company_id)
    on delete restrict;

alter table public.order_items
  drop constraint if exists order_items_variant_company_fk;

alter table public.order_items
  add constraint order_items_variant_company_fk
    foreign key (variant_id, company_id)
    references public.product_variants (id, company_id)
    on delete restrict;

alter table public.order_items
  drop constraint if exists order_items_source_company_fk;

alter table public.order_items
  add constraint order_items_source_company_fk
    foreign key (source_integration_id, company_id)
    references public.company_integrations (id, company_id)
    on delete restrict;

alter table public.order_items
  drop constraint if exists order_items_discount_amount_chk;

alter table public.order_items
  add constraint order_items_discount_amount_chk
    check (discount_amount is null or discount_amount >= 0);

create index if not exists order_items_company_variant_idx
  on public.order_items (company_id, variant_id)
  where variant_id is not null;

create index if not exists order_items_company_source_idx
  on public.order_items (company_id, source_integration_id)
  where source_integration_id is not null;

-- 005 already has order_items_company_order_idx and order_items_company_product_idx.

-- -----------------------------------------------------------------------------
-- 10) Catalog-delete triggers
-- Null only order_items.product_id / variant_id. Never touch company_id,
-- snapshots, or orders.raw_data. Then RESTRICT FKs allow the catalog row
-- to be deleted. Integration delete remains RESTRICT (no trigger).
-- -----------------------------------------------------------------------------
create or replace function public.clear_order_item_product_refs()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.order_items
     set product_id = null
   where product_id = old.id
     and company_id = old.company_id;

  update public.order_items
     set variant_id = null
   where company_id = old.company_id
     and variant_id in (
       select pv.id
         from public.product_variants pv
        where pv.product_id = old.id
          and pv.company_id = old.company_id
     );

  return old;
end;
$$;

comment on function public.clear_order_item_product_refs() is
  'BEFORE DELETE on products: null only order_items.product_id and variant_id for this tenant product. Snapshots remain.';

drop trigger if exists trg_products_clear_order_item_refs on public.products;
create trigger trg_products_clear_order_item_refs
  before delete on public.products
  for each row
  execute function public.clear_order_item_product_refs();

create or replace function public.clear_order_item_variant_refs()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.order_items
     set variant_id = null
   where variant_id = old.id
     and company_id = old.company_id;

  return old;
end;
$$;

comment on function public.clear_order_item_variant_refs() is
  'BEFORE DELETE on product_variants: null only order_items.variant_id. Does not alter snapshots or company_id.';

drop trigger if exists trg_product_variants_clear_order_item_refs on public.product_variants;
create trigger trg_product_variants_clear_order_item_refs
  before delete on public.product_variants
  for each row
  execute function public.clear_order_item_variant_refs();
