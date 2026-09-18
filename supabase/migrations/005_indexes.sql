-- =============================================================================
-- 005_indexes.sql
-- NEW SaaS database only. Do NOT run against the old ERP project.
-- =============================================================================
-- Tenant-first indexes for ~30 companies and up to ~4,500 orders/day.
-- Unique constraints from earlier migrations already cover:
--   companies.slug
--   employees (company_id, email)
--   products (company_id, easyorder_id)
--   orders (company_id, order_id)
--   orders (company_id, order_reference) where not null
--   added_orders (company_id, order_reference) where not null
--   company_integrations (company_id, provider)
--   company_features (company_id, feature_id)
--   bosta_sku_mappings (company_id, mapping_type, entity_id)
--   bosta_unmapped_products (company_id, product_id)
--   order_cost_daily (company_id, cost_date)
-- =============================================================================

create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- orders — list, filters, analytics, Bosta lookup
-- -----------------------------------------------------------------------------

create index if not exists orders_company_created_idx
  on public.orders (company_id, created_at desc);

create index if not exists orders_company_status_created_idx
  on public.orders (company_id, status, created_at desc);

create index if not exists orders_company_customer_status_idx
  on public.orders (company_id, customer_status)
  where customer_status is not null;

create index if not exists orders_company_shipping_status_idx
  on public.orders (company_id, shipping_status)
  where shipping_status is not null;

create index if not exists orders_company_source_idx
  on public.orders (company_id, order_source)
  where order_source is not null;

create index if not exists orders_company_employee_idx
  on public.orders (company_id, assigned_employee_id)
  where assigned_employee_id is not null;

create index if not exists orders_company_customer_phone_idx
  on public.orders (company_id, customer_phone)
  where customer_phone is not null;

create index if not exists orders_company_customer_phone_trgm_idx
  on public.orders using gin (customer_phone gin_trgm_ops)
  where customer_phone is not null;

create index if not exists orders_company_customer_name_trgm_idx
  on public.orders using gin (customer_name gin_trgm_ops)
  where customer_name is not null;

create index if not exists orders_company_bosta_order_id_idx
  on public.orders (company_id, bosta_order_id)
  where bosta_order_id is not null;

create index if not exists orders_company_bosta_alias_idx
  on public.orders (company_id, bosta_order_alias)
  where bosta_order_alias is not null;

-- Supports the current ERP's raw_data @> contains filters until those
-- queries are rewritten onto the promoted columns.
create index if not exists orders_raw_data_gin_idx
  on public.orders using gin (raw_data jsonb_path_ops);

-- -----------------------------------------------------------------------------
-- order_items — product analytics and cart-level filters
-- -----------------------------------------------------------------------------

create index if not exists order_items_company_order_idx
  on public.order_items (company_id, order_id);

create index if not exists order_items_company_product_idx
  on public.order_items (company_id, product_id)
  where product_id is not null;

create index if not exists order_items_company_external_product_idx
  on public.order_items (company_id, external_product_id)
  where external_product_id is not null;

create index if not exists order_items_company_sku_idx
  on public.order_items (company_id, sku)
  where sku is not null;

-- -----------------------------------------------------------------------------
-- order_status_logs — employee activity filters
-- -----------------------------------------------------------------------------

create index if not exists order_status_logs_company_changed_by_at_idx
  on public.order_status_logs (company_id, changed_by, changed_at);

create index if not exists order_status_logs_company_order_id_idx
  on public.order_status_logs (company_id, order_id);

create index if not exists order_status_logs_company_order_uuid_idx
  on public.order_status_logs (company_id, order_uuid)
  where order_uuid is not null;

-- -----------------------------------------------------------------------------
-- products
-- -----------------------------------------------------------------------------

create index if not exists products_company_synced_idx
  on public.products (company_id, synced_at desc);

create index if not exists products_company_sku_idx
  on public.products (company_id, sku)
  where sku is not null;

create index if not exists products_name_trgm_idx
  on public.products using gin (name gin_trgm_ops)
  where name is not null;

create index if not exists products_sku_trgm_idx
  on public.products using gin (sku gin_trgm_ops)
  where sku is not null;

-- -----------------------------------------------------------------------------
-- added_orders
-- -----------------------------------------------------------------------------

create index if not exists added_orders_company_created_idx
  on public.added_orders (company_id, created_at desc);

create index if not exists added_orders_company_employee_idx
  on public.added_orders (company_id, added_by_employee_id);

create index if not exists added_orders_company_phone_idx
  on public.added_orders (company_id, phone);

create index if not exists added_orders_products_names_trgm_idx
  on public.added_orders using gin (products_names gin_trgm_ops)
  where products_names is not null;

-- -----------------------------------------------------------------------------
-- employees / audit / integrations / cost
-- -----------------------------------------------------------------------------

create index if not exists employees_company_active_idx
  on public.employees (company_id, is_active);

create index if not exists audit_logs_company_created_idx
  on public.audit_logs (company_id, created_at desc);

create index if not exists audit_logs_company_entity_idx
  on public.audit_logs (company_id, entity_type, entity_id);

create index if not exists audit_logs_actor_idx
  on public.audit_logs (actor_type, actor_id, created_at desc);

create index if not exists bosta_sku_mappings_company_type_idx
  on public.bosta_sku_mappings (company_id, mapping_type);

create index if not exists bosta_sku_mappings_company_product_idx
  on public.bosta_sku_mappings (company_id, product_id)
  where product_id is not null;

create index if not exists bosta_unmapped_products_company_name_idx
  on public.bosta_unmapped_products (company_id, name);

create index if not exists order_cost_daily_company_date_idx
  on public.order_cost_daily (company_id, cost_date desc);

create index if not exists company_subscriptions_company_started_idx
  on public.company_subscriptions (company_id, started_at desc);

create index if not exists bosta_districts_city_id_idx
  on public.bosta_districts (city_id);

create index if not exists bosta_cities_name_ar_idx
  on public.bosta_cities (name_ar);
