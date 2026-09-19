-- =============================================================================
-- 009_products_source_integration.sql
-- HISTORY FILE ONLY.
-- Already applied to SaaS Development. Do NOT execute again.
-- Reconstructs the approved 7C schema from verified live indexes:
--   products_company_source_external_unique
--   products_company_manual_external_uidx
--   products_company_source_idx
-- Old products_company_easyorder_unique was dropped.
-- The optional EasyOrders backfill was NOT executed (0 EasyOrders connections
-- at apply time). Historical/manual products remain source_integration_id NULL.
-- =============================================================================

alter table public.products
  add column if not exists source_integration_id uuid
    references public.company_integrations (id) on delete set null;

comment on column public.products.source_integration_id is
  'Commerce connection this catalog row was synced from. Null for historical/manual rows.';

comment on column public.products.easyorder_id is
  'External provider product id (EasyOrders / Shopify / Salla / local hash-*). Unique only together with company_id and source_integration_id.';

alter table public.products
  drop constraint if exists products_company_easyorder_unique;

-- Synced listings: same external id may exist on two connections.
alter table public.products
  add constraint products_company_source_external_unique
  unique (company_id, source_integration_id, easyorder_id);

-- Manual/legacy rows (NULL source): still unique per company + external id.
create unique index if not exists products_company_manual_external_uidx
  on public.products (company_id, easyorder_id)
  where source_integration_id is null;

create index if not exists products_company_source_idx
  on public.products (company_id, source_integration_id);
