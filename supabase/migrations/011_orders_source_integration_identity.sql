-- =============================================================================
-- 011_orders_source_integration_identity.sql
-- ADDITIVE. Do NOT run until approved.
-- Do NOT run against the old ERP project.
-- Canonical attributed order identity:
--   (company_id, source_integration_id, order_id)
-- Manual/legacy NULL source remains unique on:
--   (company_id, order_id) WHERE source_integration_id IS NULL
-- No backfill. No product/Bosta/cost/order_reference changes.
-- =============================================================================

-- 1) Stop SET NULL from collapsing store-scoped orders into the NULL namespace.
alter table public.orders
  drop constraint if exists orders_source_integration_id_fkey;

alter table public.orders
  add constraint orders_source_integration_id_fkey
    foreign key (source_integration_id)
    references public.company_integrations (id)
    on delete restrict;

-- 2) Remove company-wide external-id uniqueness.
alter table public.orders
  drop constraint if exists orders_company_order_id_unique;

-- 3) Attributed provider orders: unique per store.
create unique index if not exists orders_company_source_external_uidx
  on public.orders (company_id, source_integration_id, order_id)
  where source_integration_id is not null;

-- 4) Manual/historical NULL-source orders: unique per company + external id.
create unique index if not exists orders_company_manual_external_uidx
  on public.orders (company_id, order_id)
  where source_integration_id is null;

comment on column public.orders.order_id is
  'Provider/manual external order id. Attributed uniqueness is (company_id, source_integration_id, order_id). NULL-source uniqueness is (company_id, order_id).';

comment on column public.orders.source_integration_id is
  'Commerce connection that ingested this order. Null = manual/historical. ON DELETE RESTRICT so store deletion cannot collide NULL-source identity.';
