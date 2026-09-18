-- =============================================================================
-- 002_commerce.sql
-- NEW SaaS database only. Do NOT run against the old ERP project.
-- =============================================================================
-- Products, orders, line items, status history, manual added_orders,
-- and concurrency-safe per-company order numbering.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- products
-- easyorder_id is unique per company, never globally.
-- Backend currently upserts onConflict: "easyorder_id" — that must become
-- onConflict: "company_id,easyorder_id" when the app is wired to this schema.
-- -----------------------------------------------------------------------------

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  easyorder_id text not null,
  name text,
  sku text,
  is_active boolean not null default true,
  raw_data jsonb not null default '{}'::jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_company_easyorder_unique unique (company_id, easyorder_id),
  constraint products_id_company_unique unique (id, company_id)
);

comment on table public.products is
  'Tenant product catalog. easyorder_id / future Salla/Shopify ids are tenant-scoped.';

comment on column public.products.easyorder_id is
  'External catalog id from EasyOrders (or a hash-* fallback). Unique only with company_id.';

drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at
  before update on public.products
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- orders
-- Internal PK is id (uuid). order_id is the EXTERNAL source id (EasyOrders etc).
-- Current ERP uses order_id as the identity and stores almost everything in
-- raw_data. We keep raw_data and promote the columns the dashboard actually
-- filters on, so tenant queries do not have to scan JSONB.
-- -----------------------------------------------------------------------------

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  order_id text not null,
  order_reference integer,
  status text not null default 'new',
  customer_status text,
  customer_name text,
  customer_phone text,
  customer_phone_2 text,
  order_source text,
  order_type text,
  shipping_status text,
  ingestion_source text,
  is_manual boolean not null default false,
  assigned_employee_id uuid,
  bosta_order_id text,
  bosta_order_alias text,
  bosta_tracking_number text,
  total_amount numeric(14, 2),
  payment_method text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_company_order_id_unique unique (company_id, order_id),
  constraint orders_id_company_unique unique (id, company_id),
  constraint orders_assigned_employee_fk
    foreign key (assigned_employee_id, company_id)
    references public.employees (id, company_id)
    on delete set null
);

comment on table public.orders is
  'Tenant orders. order_id = external EasyOrders/Salla/Shopify/manual id. Unique per company only.';

comment on column public.orders.order_id is
  'External source order id. Current ERP upserts on this column globally; SaaS uniqueness is (company_id, order_id).';

comment on column public.orders.order_reference is
  'Per-company sequential number (1001, 1002, …). Allocate via next_company_order_reference().';

comment on column public.orders.raw_data is
  'Full webhook / manual payload. Kept for EasyOrders, Bosta, exports, and debugging. Do not drop.';

comment on column public.orders.status is
  'ERP status. Current values: canceled, new, no_replay, follow up, repeater, Confirmed, Shipped.';

comment on column public.orders.customer_status is
  'WhatsApp / EasyOrders confirmation: pending | confirmed | canceled | failed.';

comment on column public.orders.order_source is
  'store | messenger | whatsapp | lost_order | old_customer.';

comment on column public.orders.order_type is
  'new | replacement | return.';

comment on column public.orders.shipping_status is
  'in_progress | delivered | failed.';

comment on column public.orders.ingestion_source is
  'Where the row was created: easyorders | salla | shopify | manual | webhook.';

-- Fill promoted columns from raw_data when the writer (current ERP style)
-- only sends order_id / status / raw_data / created_at / order_reference.
create or replace function public.sync_order_denormalized_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  raw jsonb;
begin
  raw := coalesce(new.raw_data, '{}'::jsonb);

  if new.customer_phone is null then
    new.customer_phone := nullif(
      trim(coalesce(raw->>'phone', raw->>'mobile', raw->>'customer_phone', '')),
      ''
    );
  end if;

  if new.customer_phone_2 is null then
    new.customer_phone_2 := nullif(
      trim(coalesce(
        raw->>'phone2',
        raw->>'phone_2',
        raw->>'secondaryPhone',
        raw->>'secondary_phone',
        ''
      )),
      ''
    );
  end if;

  if new.customer_name is null then
    new.customer_name := nullif(
      trim(coalesce(
        raw->>'full_name',
        raw->>'fullName',
        raw->>'customer_name',
        raw->>'customerName',
        raw->>'first_name',
        raw->>'firstName',
        ''
      )),
      ''
    );
  end if;

  if new.order_source is null then
    new.order_source := nullif(trim(coalesce(raw->>'order_source', raw->>'orderSource', '')), '');
  end if;

  if new.order_type is null then
    new.order_type := nullif(trim(coalesce(raw->>'order_type', raw->>'orderType', '')), '');
  end if;

  if new.shipping_status is null then
    new.shipping_status := nullif(
      trim(coalesce(raw->>'shipping_status', raw->>'shippingStatus', '')),
      ''
    );
  end if;

  if new.customer_status is null then
    new.customer_status := nullif(
      trim(coalesce(raw->>'customer_status', raw->>'customerStatus', '')),
      ''
    );
  end if;

  if new.is_manual is not true then
    begin
      new.is_manual := coalesce(
        (raw->>'is_manual')::boolean,
        (raw->>'isManual')::boolean,
        new.is_manual,
        false
      );
    exception
      when others then
        new.is_manual := coalesce(new.is_manual, false);
    end;
  end if;

  if new.bosta_order_id is null then
    new.bosta_order_id := nullif(
      trim(coalesce(raw->>'bosta_order_id', raw->>'bosta_fulfillment_id', '')),
      ''
    );
  end if;

  if new.bosta_order_alias is null then
    new.bosta_order_alias := nullif(
      trim(coalesce(raw->>'bosta_order_alias', raw->>'orderAlias', '')),
      ''
    );
  end if;

  if new.bosta_tracking_number is null then
    new.bosta_tracking_number := nullif(trim(coalesce(raw->>'bosta_tracking_number', '')), '');
  end if;

  if new.total_amount is null then
    begin
      new.total_amount := nullif(
        coalesce(raw->>'total_cost', raw->>'totalCost', raw->>'total', raw->>'cost'),
        ''
      )::numeric;
    exception
      when invalid_text_representation then
        new.total_amount := null;
    end;
  end if;

  if new.payment_method is null then
    new.payment_method := nullif(
      trim(coalesce(raw->>'payment_method', raw->>'paymentMethod', '')),
      ''
    );
  end if;

  -- Do not infer assigned_employee_id from raw_data: a webhook may store an
  -- employee uuid that is not in this tenant, and the composite FK would fail.

  if new.ingestion_source is null then
    if new.is_manual then
      new.ingestion_source := 'manual';
    else
      new.ingestion_source := 'easyorders';
    end if;
  end if;

  if new.order_reference is null then
    begin
      new.order_reference := nullif(
        trim(coalesce(
          raw->>'order_reference',
          raw->>'orderReference',
          raw->>'order_ref',
          raw->>'orderRef',
          ''
        )),
        ''
      )::integer;
    exception
      when invalid_text_representation then
        new.order_reference := null;
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_orders_denormalize on public.orders;
create trigger trg_orders_denormalize
  before insert or update
  on public.orders
  for each row
  execute function public.sync_order_denormalized_columns();

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();

-- Per-company unique order_reference (nulls allowed for pre-cutoff rows).
create unique index if not exists orders_company_order_reference_uidx
  on public.orders (company_id, order_reference)
  where order_reference is not null;

-- -----------------------------------------------------------------------------
-- order_items
-- Normalized cart lines. orders.raw_data remains the integration source of truth
-- until the backend starts writing this table. order_id here is orders.id (uuid),
-- not the external orders.order_id text.
-- -----------------------------------------------------------------------------

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  order_id uuid not null,
  product_id uuid,
  external_product_id text,
  product_name text,
  sku text,
  quantity integer not null default 1,
  unit_price numeric(14, 2),
  total_price numeric(14, 2),
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint order_items_quantity_chk check (quantity > 0),
  constraint order_items_order_company_fk
    foreign key (order_id, company_id)
    references public.orders (id, company_id)
    on delete cascade,
  constraint order_items_product_company_fk
    foreign key (product_id, company_id)
    references public.products (id, company_id)
    on delete set null
);

comment on table public.order_items is
  'Normalized line items for analytics and product filters. Backend does not write this yet; keep orders.raw_data.cart_items.';

comment on column public.order_items.order_id is
  'FK to orders.id (uuid). This is NOT the external EasyOrders order_id text.';

comment on column public.order_items.external_product_id is
  'EasyOrders / Salla / Shopify product id from the cart line.';

-- -----------------------------------------------------------------------------
-- order_status_logs
-- Current ERP inserts: order_id (external text), old_status, new_status,
-- changed_by, changed_at. We keep those columns and add company_id + order_uuid.
-- -----------------------------------------------------------------------------

create table if not exists public.order_status_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  order_id text not null,
  order_uuid uuid,
  old_status text,
  new_status text,
  changed_by text,
  changed_at timestamptz not null default now(),
  constraint order_status_logs_order_company_fk
    foreign key (order_uuid, company_id)
    references public.orders (id, company_id)
    on delete cascade
);

comment on table public.order_status_logs is
  'ERP status history. changed_by is employee uuid text or a system actor such as bosta_webhook.';

comment on column public.order_status_logs.order_id is
  'External source order id (same value as orders.order_id). Kept so the current backend insert shape still matches.';

comment on column public.order_status_logs.order_uuid is
  'FK to orders.id. Preferred join key once the backend is updated.';

comment on column public.order_status_logs.changed_by is
  'Text on purpose: employee uuid, email, or system labels (bosta_webhook).';

-- If the writer sends company_id + external order_id, attach order_uuid.
-- Does not guess when the same external id exists in more than one company
-- unless company_id is provided.
create or replace function public.sync_order_status_log_refs()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  matched_id uuid;
  matched_company uuid;
begin
  if new.order_uuid is not null and new.company_id is not null then
    return new;
  end if;

  if new.company_id is not null and new.order_id is not null then
    select o.id
      into matched_id
    from public.orders o
    where o.company_id = new.company_id
      and o.order_id = new.order_id
    limit 1;

    if matched_id is not null then
      new.order_uuid := coalesce(new.order_uuid, matched_id);
    end if;

    return new;
  end if;

  if new.order_uuid is not null and new.company_id is null then
    select o.company_id
      into matched_company
    from public.orders o
    where o.id = new.order_uuid
    limit 1;

    new.company_id := matched_company;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_order_status_logs_refs on public.order_status_logs;
create trigger trg_order_status_logs_refs
  before insert or update
  on public.order_status_logs
  for each row
  execute function public.sync_order_status_log_refs();

-- -----------------------------------------------------------------------------
-- added_orders
-- RECOMMENDATION: keep as a separate tenant-scoped table (option A).
--
-- Why not merge into orders for this initial migration:
--   1. Different API (`/api/added-orders`) and a different payload
--      (customer_name, phone, products jsonb, total_cost) — no ERP status,
--      shipping_status, customer_status, or EasyOrders raw_data.
--   2. Dashboard/analytics/Bosta/webhooks read `orders`, not this table.
--   3. The only shared concept is the order_reference sequence.
--   4. Merging would force a large backend rewrite before the SaaS cutover.
--
-- Revisit a unified orders model after company_id is wired everywhere.
-- Both tables share next_company_order_reference(company_id).
-- -----------------------------------------------------------------------------

create table if not exists public.added_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  added_by_employee_id uuid,
  added_by_name text,
  added_by_email text,
  customer_name text not null,
  phone text not null,
  products jsonb not null default '[]'::jsonb,
  products_names text,
  order_reference integer,
  total_cost numeric(12, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint added_orders_employee_company_fk
    foreign key (added_by_employee_id, company_id)
    references public.employees (id, company_id)
    on delete set null
);

comment on table public.added_orders is
  'Manual add-on orders, kept separate from orders for ERP compatibility. Tenant-scoped. Shares per-company reference numbering.';

create unique index if not exists added_orders_company_order_reference_uidx
  on public.added_orders (company_id, order_reference)
  where order_reference is not null;

drop trigger if exists trg_added_orders_updated_at on public.added_orders;
create trigger trg_added_orders_updated_at
  before update on public.added_orders
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- company_order_sequences
-- Concurrency-safe per-tenant numbering. Do NOT use SELECT MAX(...) + 1.
-- -----------------------------------------------------------------------------

create table if not exists public.company_order_sequences (
  company_id uuid primary key references public.companies (id) on delete restrict,
  next_value integer not null default 1001,
  start_value integer not null default 1001,
  updated_at timestamptz not null default now(),
  constraint company_order_sequences_next_chk check (next_value >= start_value),
  constraint company_order_sequences_start_chk check (start_value >= 1)
);

comment on table public.company_order_sequences is
  'One sequence per company. next_value is the next integer to issue. Used by both orders and added_orders.';

create or replace function public.next_company_order_reference(p_company_id uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_issued integer;
begin
  if p_company_id is null then
    raise exception 'company_id is required to allocate an order reference';
  end if;

  insert into public.company_order_sequences (company_id, next_value, start_value)
  values (p_company_id, 1002, 1001)
  on conflict (company_id) do update
    set next_value = public.company_order_sequences.next_value + 1,
        updated_at = now()
  returning next_value - 1 into v_issued;

  return v_issued;
end;
$$;

comment on function public.next_company_order_reference(uuid) is
  'Atomically issues the next per-company order_reference. Call from the backend instead of SELECT MAX + 1.';

create or replace function public.ensure_company_order_sequence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.company_order_sequences (company_id, next_value, start_value)
  values (new.id, 1001, 1001)
  on conflict (company_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_companies_order_sequence on public.companies;
create trigger trg_companies_order_sequence
  after insert on public.companies
  for each row
  execute function public.ensure_company_order_sequence();
