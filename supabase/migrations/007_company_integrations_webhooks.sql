-- =============================================================================
-- 007_integration_connections.sql
-- ADDITIVE. Do NOT edit 001–006. Do NOT run this against the old ERP project.
-- This file is NOT executed by the backend. Apply it manually in the SaaS
-- Supabase SQL editor after review.
-- =============================================================================
-- Phase 1 stored one row per (company, provider):
--   unique (company_id, provider)
-- That blocks multiple stores/accounts of the same provider.
--
-- This migration turns company_integrations into CONNECTION records:
--   company -> many integrations (EasyOrders + Shopify + Shopify + Bosta + …)
-- Webhook tokens identify an exact connection, not only a company/provider.
-- Orders gain nullable source_integration_id / shipping_integration_id.
-- =============================================================================

-- 1) Drop the one-provider-per-company uniqueness.
alter table public.company_integrations
  drop constraint if exists company_integrations_company_provider_unique;

alter table public.company_integrations
  drop constraint if exists company_integrations_provider_chk;

-- 2) Connection identity: category + human label + provider account id.
alter table public.company_integrations
  add column if not exists category text,
  add column if not exists name text,
  add column if not exists provider_account_id text;

-- 3) Per-connection webhook identity (token hash for lookup; encrypted token
--    so Super Admin can redisplay the URL).
alter table public.company_integrations
  add column if not exists webhook_token_hash text,
  add column if not exists webhook_token_encrypted jsonb,
  add column if not exists webhook_token_created_at timestamptz,
  add column if not exists webhook_token_rotated_at timestamptz,
  add column if not exists last_webhook_at timestamptz;

-- Backfill any pre-existing rows (empty on a fresh SaaS project).
update public.company_integrations
set
  category = coalesce(
    category,
    case
      when provider in ('bosta', 'mylerz') then 'shipping'
      else 'commerce'
    end
  ),
  name = coalesce(nullif(name, ''), initcap(provider) || ' connection')
where category is null or name is null or name = '';

alter table public.company_integrations
  alter column category set not null,
  alter column name set not null;

alter table public.company_integrations
  add constraint company_integrations_category_chk
    check (category in ('commerce', 'shipping'));

alter table public.company_integrations
  add constraint company_integrations_provider_chk
    check (provider in (
      'easyorders',
      'salla',
      'shopify',
      'bosta',
      'mylerz',
      'whatsapp'
    ));

comment on table public.company_integrations is
  'Per-company integration CONNECTIONS (stores/accounts). A company may have many rows, including multiple of the same provider. Credentials are encrypted by the application.';

comment on column public.company_integrations.category is
  'commerce | shipping. Not a company-level flag.';

comment on column public.company_integrations.name is
  'Super Admin label for this connection, e.g. "Enaya Shopify Egypt".';

comment on column public.company_integrations.provider_account_id is
  'Optional provider-side store/account identifier. Not a secret.';

comment on column public.company_integrations.webhook_token_hash is
  'SHA-256 hex of the public webhook token. Resolves inbound webhooks to exactly one connection.';

comment on column public.company_integrations.webhook_token_encrypted is
  'AES-256-GCM envelope of the raw webhook token so Super Admin can redisplay the URL.';

create unique index if not exists company_integrations_webhook_token_hash_uidx
  on public.company_integrations (webhook_token_hash)
  where webhook_token_hash is not null;

create index if not exists company_integrations_company_category_idx
  on public.company_integrations (company_id, category);

create index if not exists company_integrations_company_provider_idx
  on public.company_integrations (company_id, provider);

-- 4) Orders remember which connection created them / which shipping account was used.
--    Historical rows stay NULL.
alter table public.orders
  add column if not exists source_integration_id uuid
    references public.company_integrations (id) on delete set null,
  add column if not exists shipping_integration_id uuid
    references public.company_integrations (id) on delete set null;

comment on column public.orders.source_integration_id is
  'Commerce connection that ingested this order (EasyOrders store, Shopify store, …). Null for historical/manual rows.';

comment on column public.orders.shipping_integration_id is
  'Shipping connection used to fulfill this order when known. Null until a carrier send is recorded.';

create index if not exists orders_source_integration_idx
  on public.orders (company_id, source_integration_id);

create index if not exists orders_shipping_integration_idx
  on public.orders (company_id, shipping_integration_id);
