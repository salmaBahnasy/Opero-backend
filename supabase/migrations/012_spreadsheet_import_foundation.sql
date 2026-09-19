-- =============================================================================
-- 012_spreadsheet_import_foundation.sql
-- ADDITIVE. Do NOT run until approved.
-- SaaS Development only (project ref iydepmuniwybqgejawhf).
-- Do NOT run against the old Enaya production Supabase project.
-- =============================================================================
-- Spreadsheet import foundation:
--   SOURCE  = company_integrations row (provider = spreadsheet, category = commerce)
--   BATCH   = import_batches (+ staging rows + row errors)
-- Imported products/orders use source_integration_id = that spreadsheet UUID.
-- NULL source remains manual/legacy. NO BACKFILL.
-- Does not change products/orders uniqueness, order_reference, or category CHECK.
-- Does not enable RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Tenant-safe unique pair on company_integrations
-- PK is already unique(id). PostgreSQL composite FKs need UNIQUE(id, company_id).
-- -----------------------------------------------------------------------------
alter table public.company_integrations
  add constraint company_integrations_id_company_unique unique (id, company_id);

-- -----------------------------------------------------------------------------
-- 2) Provider CHECK: keep every live provider, add spreadsheet.
-- Live precheck allowed: easyorders, salla, shopify, bosta, mylerz, whatsapp.
-- spreadsheet is an ingestion origin only (not OAuth/webhook/API sync).
-- Category CHECK is unchanged: commerce | shipping.
-- -----------------------------------------------------------------------------
alter table public.company_integrations
  drop constraint if exists company_integrations_provider_chk;

alter table public.company_integrations
  add constraint company_integrations_provider_chk
    check (provider in (
      'easyorders',
      'salla',
      'shopify',
      'bosta',
      'mylerz',
      'whatsapp',
      'spreadsheet'
    ));

comment on column public.company_integrations.provider is
  'easyorders | salla | shopify | bosta | mylerz | whatsapp | spreadsheet. spreadsheet is a durable Excel/CSV import origin, not an API/webhook provider.';

-- -----------------------------------------------------------------------------
-- 3) import_batches
-- One upload/import execution. Durable origin is source_integration_id.
--
-- Composite FK delete note:
-- PostgreSQL ON DELETE SET NULL on a multi-column FK nulls EVERY referencing
-- column. company_id is NOT NULL, so SET NULL is invalid here.
-- created_by_employee_id uses ON DELETE RESTRICT (tenant-safe composite).
-- employees.id is globally unique, but a single-column FK alone would allow
-- a cross-tenant employee UUID. MATCH SIMPLE: NULL created_by_employee_id
-- skips the composite check, so the app may clear the employee then delete.
-- -----------------------------------------------------------------------------
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  source_integration_id uuid not null,
  entity_type text not null,
  original_filename text not null,
  file_type text not null,
  sheet_name text,
  status text not null default 'uploaded',
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  imported_rows integer not null default 0,
  updated_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  mapping jsonb not null default '{}'::jsonb,
  options jsonb not null default '{}'::jsonb,
  created_by_employee_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  constraint import_batches_id_company_unique unique (id, company_id),
  constraint import_batches_entity_type_chk
    check (entity_type in ('products', 'orders')),
  constraint import_batches_file_type_chk
    check (file_type in ('xlsx', 'csv')),
  constraint import_batches_status_chk
    check (status in (
      'uploaded',
      'validated',
      'committing',
      'completed',
      'failed',
      'expired'
    )),
  constraint import_batches_counts_chk
    check (
      total_rows >= 0
      and valid_rows >= 0
      and imported_rows >= 0
      and updated_rows >= 0
      and skipped_rows >= 0
      and failed_rows >= 0
    ),
  constraint import_batches_source_company_fk
    foreign key (source_integration_id, company_id)
    references public.company_integrations (id, company_id)
    on delete restrict,
  constraint import_batches_employee_company_fk
    foreign key (created_by_employee_id, company_id)
    references public.employees (id, company_id)
    on delete restrict
);

comment on table public.import_batches is
  'One spreadsheet import execution. source_integration_id is the durable spreadsheet connection. Staging PII lives in import_batch_rows until commit/expiry cleanup.';

comment on column public.import_batches.source_integration_id is
  'company_integrations.id for provider=spreadsheet. Application enforces provider; DB enforces same-company.';

comment on column public.import_batches.original_filename is
  'Sanitized basename only. Do not store filesystem paths.';

comment on column public.import_batches.created_by_employee_id is
  'Nullable. Composite FK ON DELETE RESTRICT so company_id cannot be nulled. Clear this column before deleting the employee.';

create index if not exists import_batches_company_created_idx
  on public.import_batches (company_id, created_at desc);

create index if not exists import_batches_source_idx
  on public.import_batches (company_id, source_integration_id);

create index if not exists import_batches_status_expires_idx
  on public.import_batches (status, expires_at);

-- -----------------------------------------------------------------------------
-- 4) import_batch_rows (temporary staging; may contain PII)
-- UNIQUE(batch_id, row_number) already indexes that pair.
-- -----------------------------------------------------------------------------
create table if not exists public.import_batch_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  company_id uuid not null,
  row_number integer not null,
  raw_cells jsonb not null default '{}'::jsonb,
  normalized jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint import_batch_rows_row_number_chk check (row_number > 0),
  constraint import_batch_rows_status_chk
    check (status in ('pending', 'valid', 'invalid', 'imported', 'skipped')),
  constraint import_batch_rows_batch_row_unique unique (batch_id, row_number),
  constraint import_batch_rows_batch_company_fk
    foreign key (batch_id, company_id)
    references public.import_batches (id, company_id)
    on delete cascade
);

comment on table public.import_batch_rows is
  'Parsed staging rows for commit replay. Delete after successful commit or expiry. Do not keep original files.';

-- -----------------------------------------------------------------------------
-- 5) import_row_errors (codes/messages only; no customer payload)
-- -----------------------------------------------------------------------------
create table if not exists public.import_row_errors (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  company_id uuid not null,
  row_number integer,
  field text,
  code text not null,
  message text not null,
  created_at timestamptz not null default now(),
  constraint import_row_errors_batch_company_fk
    foreign key (batch_id, company_id)
    references public.import_batches (id, company_id)
    on delete cascade
);

comment on table public.import_row_errors is
  'Per-row validation/commit errors. No phones, emails, addresses, or full row dumps.';

create index if not exists import_row_errors_batch_idx
  on public.import_row_errors (batch_id, row_number);

-- -----------------------------------------------------------------------------
-- 6–7) Nullable batch attribution on orders/products
--
-- Composite FK (import_batch_id, company_id) cannot use ON DELETE SET NULL:
-- PostgreSQL would null company_id as well.
-- MATCH SIMPLE (default): import_batch_id NULL is allowed and skips the FK.
-- ON DELETE RESTRICT: batch delete is blocked while attribution remains.
-- BEFORE DELETE trigger nulls ONLY import_batch_id (same company), then the
-- batch row can be deleted. Staging/errors CASCADE. Business rows remain.
-- source_integration_id is unchanged and stays the durable origin.
-- -----------------------------------------------------------------------------
alter table public.orders
  add column if not exists import_batch_id uuid;

alter table public.products
  add column if not exists import_batch_id uuid;

alter table public.orders
  drop constraint if exists orders_import_batch_company_fk;

alter table public.orders
  add constraint orders_import_batch_company_fk
    foreign key (import_batch_id, company_id)
    references public.import_batches (id, company_id)
    on delete restrict;

alter table public.products
  drop constraint if exists products_import_batch_company_fk;

alter table public.products
  add constraint products_import_batch_company_fk
    foreign key (import_batch_id, company_id)
    references public.import_batches (id, company_id)
    on delete restrict;

comment on column public.orders.import_batch_id is
  'Optional spreadsheet batch that created/updated this order. Durable origin is source_integration_id. Nullable; never a substitute for local UUID identity.';

comment on column public.products.import_batch_id is
  'Optional spreadsheet batch that created/updated this product. Durable origin is source_integration_id.';

create index if not exists orders_import_batch_idx
  on public.orders (company_id, import_batch_id);

create index if not exists products_import_batch_idx
  on public.products (company_id, import_batch_id);

create or replace function public.clear_import_batch_attribution()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.orders
     set import_batch_id = null
   where import_batch_id = old.id
     and company_id = old.company_id;

  update public.products
     set import_batch_id = null
   where import_batch_id = old.id
     and company_id = old.company_id;

  return old;
end;
$$;

comment on function public.clear_import_batch_attribution() is
  'BEFORE DELETE on import_batches: null only orders/products.import_batch_id. Never touches company_id or source_integration_id.';

drop trigger if exists trg_import_batches_clear_attribution on public.import_batches;
create trigger trg_import_batches_clear_attribution
  before delete on public.import_batches
  for each row
  execute function public.clear_import_batch_attribution();

-- -----------------------------------------------------------------------------
-- 8) Feature catalog (004 convention). Does not assign plans/company_features.
-- -----------------------------------------------------------------------------
insert into public.features (key, name, description)
values (
  'imports',
  'Spreadsheet import',
  'Excel/CSV product and order import'
)
on conflict (key) do nothing;
