-- =============================================================================
-- 010_bosta_shipping_catalog_identity.sql
-- HISTORY FILE ONLY.
-- Already applied to SaaS Development. Do NOT execute again.
-- Reconstructs the approved 7G revised DDL. Optional catalog backfill UPDATEs
-- were NOT executed. Historical mapping/unmapped rows remain NULL/legacy.
-- =============================================================================

-- --- mappings ---
alter table public.bosta_sku_mappings
  add column if not exists shipping_integration_id uuid
    references public.company_integrations (id) on delete cascade,
  add column if not exists catalog_product_id uuid;

alter table public.bosta_sku_mappings
  add constraint bosta_sku_mappings_catalog_product_company_fk
    foreign key (catalog_product_id, company_id)
    references public.products (id, company_id)
    on delete cascade;

comment on column public.bosta_sku_mappings.shipping_integration_id is
  'Bosta connection these SKUs belong to. Null = legacy company-wide row.';

comment on column public.bosta_sku_mappings.catalog_product_id is
  'Local products.id. Null = legacy row keyed only by entity_id. Implies commerce store via products.source_integration_id.';

comment on column public.bosta_sku_mappings.entity_id is
  'Legacy EasyOrders-style key, and for mapping_type=variant the provider variant id.';

alter table public.bosta_sku_mappings
  drop constraint if exists bosta_sku_mappings_company_entity_unique;

-- New product/size rows: one mapping per Bosta account + local product
create unique index if not exists bosta_sku_map_shipping_catalog_product_uidx
  on public.bosta_sku_mappings (
    company_id, shipping_integration_id, mapping_type, catalog_product_id
  )
  where shipping_integration_id is not null
    and catalog_product_id is not null
    and mapping_type in ('product', 'size');

-- New variant rows: provider variant id is unique only inside that local product + Bosta account
create unique index if not exists bosta_sku_map_shipping_catalog_variant_uidx
  on public.bosta_sku_mappings (
    company_id, shipping_integration_id, catalog_product_id, entity_id
  )
  where shipping_integration_id is not null
    and catalog_product_id is not null
    and mapping_type = 'variant';

-- Legacy rows (neither shipping nor catalog assigned): keep old EasyOrders uniqueness
create unique index if not exists bosta_sku_map_legacy_entity_uidx
  on public.bosta_sku_mappings (company_id, mapping_type, entity_id)
  where shipping_integration_id is null
    and catalog_product_id is null;

create index if not exists bosta_sku_map_shipping_idx
  on public.bosta_sku_mappings (company_id, shipping_integration_id);

create index if not exists bosta_sku_map_catalog_idx
  on public.bosta_sku_mappings (company_id, catalog_product_id)
  where catalog_product_id is not null;

-- --- unmapped ---
alter table public.bosta_unmapped_products
  add column if not exists shipping_integration_id uuid
    references public.company_integrations (id) on delete cascade,
  add column if not exists catalog_product_id uuid;

alter table public.bosta_unmapped_products
  add constraint bosta_unmapped_catalog_product_company_fk
    foreign key (catalog_product_id, company_id)
    references public.products (id, company_id)
    on delete cascade;

comment on column public.bosta_unmapped_products.product_id is
  'Legacy external product id (EasyOrders/etc). Not products.id.';

comment on column public.bosta_unmapped_products.catalog_product_id is
  'Local products.id when known. Null = legacy external-only row.';

alter table public.bosta_unmapped_products
  drop constraint if exists bosta_unmapped_products_company_product_unique;

create unique index if not exists bosta_unmapped_shipping_catalog_uidx
  on public.bosta_unmapped_products (
    company_id, shipping_integration_id, catalog_product_id
  )
  where shipping_integration_id is not null
    and catalog_product_id is not null;

create unique index if not exists bosta_unmapped_legacy_product_uidx
  on public.bosta_unmapped_products (company_id, product_id)
  where shipping_integration_id is null
    and catalog_product_id is null;
