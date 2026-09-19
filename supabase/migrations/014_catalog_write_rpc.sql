-- =============================================================================
-- 014_catalog_write_rpc.sql
-- ADDITIVE TRANSACTION PRIMITIVE ONLY. Do NOT run until approved.
-- SaaS Development only (project ref iydepmuniwybqgejawhf).
-- Do NOT run against the old Enaya production Supabase project.
-- =============================================================================
-- Inspected APPLIED Migration 013 (do not alter those tables here):
--   public.products.product_type text check (simple|variable|bundle)
--   public.product_variants (
--     id uuid pk default gen_random_uuid(),
--     company_id uuid, product_id uuid,
--     title text, internal_sku text, barcode text,
--     price numeric(14,2), compare_at_price numeric(14,2),
--     is_default boolean, is_active boolean, position integer,
--     raw_data jsonb,
--     unique (id, company_id), unique (id, product_id, company_id),
--     fk (product_id, company_id) -> products(id, company_id) on delete cascade,
--     unique index one default per (company_id, product_id) where is_default,
--     unique index (company_id, internal_sku) where internal_sku is not null,
--     unique index (company_id, barcode) where barcode is not null
--   )
--   public.product_options (
--     id uuid pk, company_id, product_id, name text, position integer,
--     unique (company_id, product_id, name),
--     fk (product_id, company_id) -> products on delete cascade
--   )
--   public.product_option_values (
--     id uuid pk, company_id, product_id, option_id, value text, position integer,
--     unique (company_id, option_id, value),
--     unique (id, option_id, company_id),
--     fk (option_id, product_id, company_id) -> product_options on delete cascade
--   )
--   public.variant_option_values (
--     id uuid pk, company_id, product_id, variant_id, option_id, option_value_id,
--     unique (company_id, variant_id, option_id),
--     composite FKs to variants/options/values including product_id + option_id
--   )
--   public.catalog_source_mappings (
--     id uuid pk, company_id, integration_id,
--     external_product_id text, external_variant_id text not null default '',
--     internal_product_id uuid, internal_variant_id uuid,
--     external_sku text, metadata jsonb,
--     unique (company_id, integration_id, external_product_id, external_variant_id),
--     fk (integration_id, company_id) -> company_integrations on delete restrict,
--     fk (internal_variant_id, internal_product_id, company_id) -> product_variants
--   )
--
-- Executor RPC: public.apply_catalog_product_plan(uuid, uuid, text, jsonb)
-- One call = one product subtransaction. No BEGIN/COMMIT inside the function.
-- NOT a planner. SECURITY INVOKER. No catalog DELETE.
--
-- Fail-closed operations (no implicit upsert):
--   CREATE = insert a new canonical row; existing identity is an error
--            (variant-option links are the documented exception: CREATE of the
--            same relationship is a no-op because the JS builder always sends
--            link operation "create" on retries).
--   REUSE  = the row MUST already exist; validate + map; missing is an error.
--            Variant REUSE may set is_default only as part of the exact-one
--            default switch.
--   UPDATE = the row MUST already exist; mutate only approved fields.
--   CONFLICT must never reach this RPC.
--
-- Payload UUID/boolean/integer/numeric JSON is parsed by helpers so malformed
-- values raise P0001 CATALOG_* instead of native 22P02.
-- numeric(14,2) overflow may still raise native 22003 as the final range guard.
-- Unique/FK violations may still raise native 23505 / 23503.
-- =============================================================================

create or replace function public.catalog_write_raise(p_code text, p_detail text)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_raise$
begin
  raise exception using
    errcode = 'P0001',
    message = p_code || ': ' || coalesce(p_detail, ''),
    hint = p_code;
end;
$catalog_raise$;

create or replace function public.catalog_write_payload_array(
  p_payload jsonb,
  p_field text
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_array$
declare
  v_arr jsonb;
begin
  v_arr := p_payload -> p_field;
  if v_arr is null or jsonb_typeof(v_arr) = 'null' then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(v_arr) is distinct from 'array' then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' must be a JSON array'
    );
  end if;
  return v_arr;
end;
$catalog_array$;

create or replace function public.catalog_write_payload_object(
  p_elem jsonb,
  p_label text
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_object$
begin
  if p_elem is null or jsonb_typeof(p_elem) is distinct from 'object' then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_label || ' element must be a JSON object'
    );
  end if;
  return p_elem;
end;
$catalog_object$;

create or replace function public.catalog_write_payload_uuid(
  p_elem jsonb,
  p_field text
)
returns uuid
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_uuid$
declare
  v_j jsonb;
  v_txt text;
  v_id uuid;
begin
  v_j := p_elem -> p_field;
  if v_j is null or jsonb_typeof(v_j) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_j) is distinct from 'string' then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' must be a UUID string'
    );
  end if;
  v_txt := nullif(trim(both from (p_elem ->> p_field)), '');
  if v_txt is null then
    return null;
  end if;
  begin
    v_id := v_txt::uuid;
  exception when invalid_text_representation then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' is not a valid UUID'
    );
  end;
  return v_id;
end;
$catalog_uuid$;

create or replace function public.catalog_write_payload_bool(
  p_elem jsonb,
  p_field text,
  p_default boolean
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_bool$
declare
  v_j jsonb;
begin
  v_j := p_elem -> p_field;
  if v_j is null or jsonb_typeof(v_j) = 'null' then
    return p_default;
  end if;
  if jsonb_typeof(v_j) is distinct from 'boolean' then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' must be a JSON boolean'
    );
  end if;
  return v_j = 'true'::jsonb;
end;
$catalog_bool$;

create or replace function public.catalog_write_payload_int(
  p_elem jsonb,
  p_field text,
  p_default integer
)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_int$
declare
  v_j jsonb;
  v_n numeric;
begin
  v_j := p_elem -> p_field;
  if v_j is null or jsonb_typeof(v_j) = 'null' then
    return p_default;
  end if;
  if jsonb_typeof(v_j) is distinct from 'number' then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' must be a JSON number'
    );
  end if;
  v_n := (p_elem ->> p_field)::numeric;
  if v_n <> trunc(v_n) then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' must be an integer'
    );
  end if;
  if v_n < -2147483648 or v_n > 2147483647 then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' is out of integer range'
    );
  end if;
  return v_n::integer;
end;
$catalog_int$;

create or replace function public.catalog_write_payload_numeric(
  p_elem jsonb,
  p_field text
)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $catalog_num$
declare
  v_j jsonb;
begin
  v_j := p_elem -> p_field;
  if v_j is null or jsonb_typeof(v_j) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_j) is distinct from 'number' then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      p_field || ' must be a JSON number'
    );
  end if;
  -- Assignment to numeric(14,2) in the caller may still raise native 22003.
  return (p_elem ->> p_field)::numeric;
end;
$catalog_num$;

create or replace function public.apply_catalog_product_plan(
  p_company_id uuid,
  p_product_id uuid,
  p_product_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $catalog$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_locked_id uuid;
  v_arr jsonb;
  v_len integer;
  v_i integer;
  v_elem jsonb;
  v_op text;
  v_key text;
  v_id uuid;
  v_title text;
  v_sku text;
  v_barcode text;
  v_price numeric(14, 2);
  v_compare numeric(14, 2);
  v_default boolean;
  v_active boolean;
  v_position integer;
  v_raw jsonb;
  v_found_id uuid;
  v_found_company uuid;
  v_found_product uuid;
  v_found_option uuid;
  v_found_value uuid;
  v_default_count integer := 0;
  v_default_key text;
  v_variant_keys jsonb := '{}'::jsonb;
  v_option_keys jsonb := '{}'::jsonb;
  v_value_plan jsonb := '{}'::jsonb;
  v_variant_ids jsonb := '{}'::jsonb;
  v_option_ids jsonb := '{}'::jsonb;
  v_value_ids jsonb := '{}'::jsonb;
  v_mapping_rows jsonb := '[]'::jsonb;
  v_option_key text;
  v_value_key text;
  v_value_text text;
  v_option_id uuid;
  v_value_id uuid;
  v_variant_id uuid;
  v_bucket jsonb;
  v_integration_id uuid;
  v_ext_product text;
  v_ext_variant text;
  v_ext_sku text;
  v_metadata jsonb;
  v_existing_product uuid;
  v_existing_variant uuid;
  v_existing_sku text;
  v_existing_metadata jsonb;
  v_j jsonb;
begin
  if p_company_id is null then
    perform public.catalog_write_raise('CATALOG_TENANT_MISMATCH', 'company_id is required');
  end if;
  if p_product_id is null then
    perform public.catalog_write_raise('CATALOG_PRODUCT_NOT_FOUND', 'product_id is required');
  end if;
  if p_product_type is null or p_product_type not in ('simple', 'variable') then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_PRODUCT_TYPE',
      'RPC allows only simple|variable'
    );
  end if;
  if jsonb_typeof(v_payload) is distinct from 'object' then
    perform public.catalog_write_raise('CATALOG_INVALID_OPERATION', 'payload must be a JSON object');
  end if;

  select p.id
    into v_locked_id
    from public.products p
   where p.id = p_product_id
     and p.company_id = p_company_id
   for update;

  if v_locked_id is null then
    if exists (select 1 from public.products p where p.id = p_product_id) then
      perform public.catalog_write_raise(
        'CATALOG_TENANT_MISMATCH',
        'product does not belong to company'
      );
    end if;
    perform public.catalog_write_raise('CATALOG_PRODUCT_NOT_FOUND', 'product row was not found');
  end if;

  -- ---------- structural validation (no catalog mutations yet) ----------
  v_arr := public.catalog_write_payload_array(v_payload, 'variants');
  v_len := jsonb_array_length(v_arr);
  if v_len < 1 then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_OPERATION',
      'at least one variant operation is required'
    );
  end if;
  for v_i in 0 .. v_len - 1 loop
    v_elem := public.catalog_write_payload_object(v_arr -> v_i, 'variants');
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_key := nullif(trim(both from coalesce(v_elem->>'key', v_elem->>'variant_key', '')), '');
    if v_op not in ('create', 'reuse', 'update') then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant operation must be create|reuse|update'
      );
    end if;
    if v_key is null then
      perform public.catalog_write_raise('CATALOG_INVALID_OPERATION', 'variant key is required');
    end if;
    if jsonb_exists(v_variant_keys, v_key) then
      perform public.catalog_write_raise('CATALOG_INVALID_OPERATION', 'duplicate variant key');
    end if;
    v_variant_keys := v_variant_keys || jsonb_build_object(v_key, true);
    v_default := public.catalog_write_payload_bool(v_elem, 'is_default', false);
    perform public.catalog_write_payload_bool(v_elem, 'is_active', true);
    perform public.catalog_write_payload_int(v_elem, 'position', 0);
    perform public.catalog_write_payload_numeric(v_elem, 'price');
    perform public.catalog_write_payload_numeric(v_elem, 'compare_at_price');
    if v_default then
      v_default_count := v_default_count + 1;
      v_default_key := v_key;
    end if;
    if v_op in ('reuse', 'update') then
      v_id := public.catalog_write_payload_uuid(v_elem, 'id');
      if v_id is null then
        perform public.catalog_write_raise(
          'CATALOG_VARIANT_NOT_FOUND',
          'reuse/update requires existing variant id'
        );
      end if;
      select pv.id, pv.company_id, pv.product_id
        into v_found_id, v_found_company, v_found_product
        from public.product_variants pv
       where pv.id = v_id;
      if not found then
        perform public.catalog_write_raise('CATALOG_VARIANT_NOT_FOUND', 'variant UUID was not found');
      end if;
      if v_found_company is distinct from p_company_id
         or v_found_product is distinct from p_product_id then
        perform public.catalog_write_raise(
          'CATALOG_TENANT_MISMATCH',
          'variant does not belong to company/product'
        );
      end if;
    end if;
  end loop;

  if v_default_count is distinct from 1 then
    perform public.catalog_write_raise(
      'CATALOG_INVALID_DEFAULT_VARIANT_COUNT',
      'payload must nominate exactly one default variant'
    );
  end if;

  v_arr := public.catalog_write_payload_array(v_payload, 'options');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := public.catalog_write_payload_object(v_arr -> v_i, 'options');
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_key := nullif(trim(both from coalesce(v_elem->>'key', v_elem->>'name', '')), '');
    if v_op not in ('create', 'reuse') then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'option operation must be create|reuse'
      );
    end if;
    if v_key is null then
      perform public.catalog_write_raise('CATALOG_INVALID_OPERATION', 'option key/name is required');
    end if;
    if jsonb_exists(v_option_keys, v_key) then
      perform public.catalog_write_raise('CATALOG_INVALID_OPERATION', 'duplicate option key');
    end if;
    v_option_keys := v_option_keys || jsonb_build_object(v_key, true);
    perform public.catalog_write_payload_int(v_elem, 'position', 0);
    if v_op = 'reuse' then
      v_id := public.catalog_write_payload_uuid(v_elem, 'id');
      if v_id is null then
        perform public.catalog_write_raise(
          'CATALOG_OPTION_NOT_FOUND',
          'reuse requires existing option id'
        );
      end if;
      select po.id, po.company_id, po.product_id
        into v_found_id, v_found_company, v_found_product
        from public.product_options po
       where po.id = v_id;
      if not found then
        perform public.catalog_write_raise('CATALOG_OPTION_NOT_FOUND', 'option UUID was not found');
      end if;
      if v_found_company is distinct from p_company_id
         or v_found_product is distinct from p_product_id then
        perform public.catalog_write_raise(
          'CATALOG_TENANT_MISMATCH',
          'option does not belong to company/product'
        );
      end if;
    end if;
  end loop;

  v_arr := public.catalog_write_payload_array(v_payload, 'option_values');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := public.catalog_write_payload_object(v_arr -> v_i, 'option_values');
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_option_key := nullif(trim(both from coalesce(v_elem->>'option_key', v_elem->>'option_name', '')), '');
    v_value_text := nullif(trim(both from coalesce(v_elem->>'value', v_elem->>'value_key', '')), '');
    if v_op not in ('create', 'reuse') then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'option value operation must be create|reuse'
      );
    end if;
    if v_option_key is null or v_value_text is null then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'option value requires option_key and value'
      );
    end if;
    if not jsonb_exists(v_option_keys, v_option_key) then
      perform public.catalog_write_raise(
        'CATALOG_OPTION_NOT_FOUND',
        'option value references an option_key that is not in the payload'
      );
    end if;
    v_bucket := coalesce(v_value_plan -> v_option_key, '{}'::jsonb);
    if jsonb_exists(v_bucket, v_value_text) then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'duplicate option value for the same option_key'
      );
    end if;
    v_value_plan := jsonb_set(
      v_value_plan,
      array[v_option_key],
      v_bucket || jsonb_build_object(v_value_text, true),
      true
    );
    perform public.catalog_write_payload_int(v_elem, 'position', 0);
    if v_op = 'reuse' then
      v_id := public.catalog_write_payload_uuid(v_elem, 'id');
      if v_id is null then
        perform public.catalog_write_raise(
          'CATALOG_OPTION_VALUE_NOT_FOUND',
          'reuse requires existing option value id'
        );
      end if;
      select pov.id, pov.company_id, pov.product_id, pov.option_id
        into v_found_id, v_found_company, v_found_product, v_found_option
        from public.product_option_values pov
       where pov.id = v_id;
      if not found then
        perform public.catalog_write_raise(
          'CATALOG_OPTION_VALUE_NOT_FOUND',
          'option value UUID was not found'
        );
      end if;
      if v_found_company is distinct from p_company_id
         or v_found_product is distinct from p_product_id then
        perform public.catalog_write_raise(
          'CATALOG_TENANT_MISMATCH',
          'option value does not belong to company/product'
        );
      end if;
    end if;
  end loop;

  v_arr := public.catalog_write_payload_array(v_payload, 'variant_option_values');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := public.catalog_write_payload_object(v_arr -> v_i, 'variant_option_values');
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', 'create')));
    if v_op not in ('create', 'reuse') then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant-option link operation must be create|reuse'
      );
    end if;
    v_key := nullif(trim(both from coalesce(v_elem->>'variant_key', '')), '');
    v_option_key := nullif(trim(both from coalesce(v_elem->>'option_key', v_elem->>'option_name', '')), '');
    v_value_key := nullif(trim(both from coalesce(v_elem->>'value_key', v_elem->>'value', '')), '');
    if v_key is null or v_option_key is null or v_value_key is null then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant-option link requires variant_key, option_key, and value_key'
      );
    end if;
    if not jsonb_exists(v_variant_keys, v_key) then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant-option link variant_key is not in the payload'
      );
    end if;
    if not jsonb_exists(v_option_keys, v_option_key) then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant-option link option_key is not in the payload'
      );
    end if;
    if not jsonb_exists(coalesce(v_value_plan -> v_option_key, '{}'::jsonb), v_value_key) then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant-option link value_key is not in the payload for that option'
      );
    end if;
  end loop;

  v_arr := public.catalog_write_payload_array(v_payload, 'source_mappings');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := public.catalog_write_payload_object(v_arr -> v_i, 'source_mappings');
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    if v_op not in ('create', 'reuse', 'update') then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'mapping operation must be create|reuse|update'
      );
    end if;
    v_integration_id := public.catalog_write_payload_uuid(v_elem, 'integration_id');
    if v_integration_id is null then
      perform public.catalog_write_raise(
        'CATALOG_INTEGRATION_NOT_FOUND',
        'mapping requires exact integration UUID'
      );
    end if;
    v_ext_product := nullif(trim(both from coalesce(v_elem->>'external_product_id', '')), '');
    v_j := v_elem -> 'external_product_id';
    if v_j is not null and jsonb_typeof(v_j) is distinct from 'null'
       and jsonb_typeof(v_j) is distinct from 'string' then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'external_product_id must be a string'
      );
    end if;
    if v_ext_product is null then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'mapping requires external_product_id'
      );
    end if;
    v_j := v_elem -> 'external_variant_id';
    if v_j is not null and jsonb_typeof(v_j) is distinct from 'null'
       and jsonb_typeof(v_j) is distinct from 'string' then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'external_variant_id must be a string'
      );
    end if;
    v_key := nullif(trim(both from coalesce(v_elem->>'variant_key', '')), '');
    if v_key is null then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'mapping requires variant_key'
      );
    end if;
    if not jsonb_exists(v_variant_keys, v_key) then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'mapping variant_key is not in the payload'
      );
    end if;
    select ci.id, ci.company_id
      into v_found_id, v_found_company
      from public.company_integrations ci
     where ci.id = v_integration_id;
    if not found then
      perform public.catalog_write_raise(
        'CATALOG_INTEGRATION_NOT_FOUND',
        'integration UUID was not found'
      );
    end if;
    if v_found_company is distinct from p_company_id then
      perform public.catalog_write_raise(
        'CATALOG_TENANT_MISMATCH',
        'integration does not belong to company'
      );
    end if;
    perform ci.id
      from public.company_integrations ci
     where ci.id = v_integration_id
       and ci.company_id = p_company_id
     for share;
  end loop;

  -- ---------- mutations (exact-one-default already enforced) ----------
  update public.product_variants
     set is_default = false
   where company_id = p_company_id
     and product_id = p_product_id
     and is_default = true;

  v_arr := public.catalog_write_payload_array(v_payload, 'variants');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := v_arr -> v_i;
    v_variant_id := null;
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_key := trim(both from coalesce(v_elem->>'key', v_elem->>'variant_key', ''));
    v_title := v_elem->>'title';
    v_sku := nullif(trim(both from coalesce(v_elem->>'internal_sku', '')), '');
    v_barcode := nullif(trim(both from coalesce(v_elem->>'barcode', '')), '');
    v_price := public.catalog_write_payload_numeric(v_elem, 'price');
    v_compare := public.catalog_write_payload_numeric(v_elem, 'compare_at_price');
    v_default := public.catalog_write_payload_bool(v_elem, 'is_default', false);
    v_active := public.catalog_write_payload_bool(v_elem, 'is_active', true);
    v_position := public.catalog_write_payload_int(v_elem, 'position', 0);
    if jsonb_typeof(v_elem->'raw_data') = 'object' then
      v_raw := v_elem->'raw_data';
    else
      v_raw := '{}'::jsonb;
    end if;

    if v_op = 'create' then
      insert into public.product_variants (
        company_id, product_id, title, internal_sku, barcode, price,
        compare_at_price, is_default, is_active, position, raw_data
      )
      values (
        p_company_id, p_product_id, v_title, v_sku, v_barcode, v_price,
        v_compare, v_default, v_active, v_position, v_raw
      )
      returning id into v_variant_id;
    else
      v_id := public.catalog_write_payload_uuid(v_elem, 'id');
      if v_op = 'update' then
        update public.product_variants
           set title = v_title,
               internal_sku = v_sku,
               barcode = v_barcode,
               price = v_price,
               compare_at_price = v_compare,
               is_default = v_default,
               is_active = v_active,
               position = v_position,
               raw_data = v_raw
         where id = v_id
           and company_id = p_company_id
           and product_id = p_product_id
        returning id into v_variant_id;
      else
        update public.product_variants
           set is_default = v_default
         where id = v_id
           and company_id = p_company_id
           and product_id = p_product_id
        returning id into v_variant_id;
      end if;
      if v_variant_id is null then
        perform public.catalog_write_raise('CATALOG_VARIANT_NOT_FOUND', 'variant reuse/update did not resolve');
      end if;
    end if;
    v_variant_ids := v_variant_ids || jsonb_build_object(v_key, v_variant_id);
  end loop;

  if public.catalog_write_payload_uuid(
       jsonb_build_object('id', v_variant_ids ->> v_default_key),
       'id'
     ) is null then
    perform public.catalog_write_raise(
      'CATALOG_VARIANT_NOT_FOUND',
      'nominated default variant key did not resolve'
    );
  end if;

  update public.products
     set product_type = p_product_type
   where id = p_product_id
     and company_id = p_company_id;

  v_arr := public.catalog_write_payload_array(v_payload, 'options');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := v_arr -> v_i;
    v_option_id := null;
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_key := trim(both from coalesce(v_elem->>'key', v_elem->>'name', ''));
    v_title := nullif(trim(both from coalesce(v_elem->>'name', v_key)), '');
    v_position := public.catalog_write_payload_int(v_elem, 'position', 0);
    if v_title is null then
      perform public.catalog_write_raise('CATALOG_INVALID_OPERATION', 'option name is required');
    end if;
    if v_op = 'create' then
      insert into public.product_options (company_id, product_id, name, position)
      values (p_company_id, p_product_id, v_title, v_position)
      returning id into v_option_id;
    else
      v_option_id := public.catalog_write_payload_uuid(v_elem, 'id');
    end if;
    v_option_ids := v_option_ids || jsonb_build_object(v_key, v_option_id);
  end loop;

  v_arr := public.catalog_write_payload_array(v_payload, 'option_values');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := v_arr -> v_i;
    v_value_id := null;
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_option_key := trim(both from coalesce(v_elem->>'option_key', v_elem->>'option_name', ''));
    v_value_text := trim(both from coalesce(v_elem->>'value', v_elem->>'value_key', ''));
    v_position := public.catalog_write_payload_int(v_elem, 'position', 0);
    v_option_id := public.catalog_write_payload_uuid(
      jsonb_build_object('id', v_option_ids ->> v_option_key),
      'id'
    );
    if v_option_id is null then
      perform public.catalog_write_raise(
        'CATALOG_OPTION_NOT_FOUND',
        'option value parent was not resolved'
      );
    end if;
    if v_op = 'create' then
      insert into public.product_option_values (
        company_id, product_id, option_id, value, position
      )
      values (
        p_company_id, p_product_id, v_option_id, v_value_text, v_position
      )
      returning id into v_value_id;
    else
      v_value_id := public.catalog_write_payload_uuid(v_elem, 'id');
      select pov.option_id
        into v_found_option
        from public.product_option_values pov
       where pov.id = v_value_id
         and pov.company_id = p_company_id
         and pov.product_id = p_product_id;
      if not found then
        perform public.catalog_write_raise(
          'CATALOG_OPTION_VALUE_NOT_FOUND',
          'option value reuse id was not found'
        );
      end if;
      if v_found_option is distinct from v_option_id then
        perform public.catalog_write_raise(
          'CATALOG_TENANT_MISMATCH',
          'option value does not belong to expected option'
        );
      end if;
    end if;
    v_bucket := coalesce(v_value_ids -> v_option_key, '{}'::jsonb);
    v_value_ids := jsonb_set(
      v_value_ids,
      array[v_option_key],
      v_bucket || jsonb_build_object(v_value_text, v_value_id),
      true
    );
  end loop;

  v_arr := public.catalog_write_payload_array(v_payload, 'variant_option_values');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := v_arr -> v_i;
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', 'create')));
    v_key := trim(both from coalesce(v_elem->>'variant_key', ''));
    v_option_key := trim(both from coalesce(v_elem->>'option_key', v_elem->>'option_name', ''));
    v_value_key := trim(both from coalesce(v_elem->>'value_key', v_elem->>'value', ''));
    v_variant_id := public.catalog_write_payload_uuid(
      jsonb_build_object('id', v_variant_ids ->> v_key),
      'id'
    );
    v_option_id := public.catalog_write_payload_uuid(
      jsonb_build_object('id', v_option_ids ->> v_option_key),
      'id'
    );
    v_value_id := public.catalog_write_payload_uuid(
      jsonb_build_object('id', coalesce(v_value_ids -> v_option_key, '{}'::jsonb) ->> v_value_key),
      'id'
    );
    if v_variant_id is null or v_option_id is null or v_value_id is null then
      perform public.catalog_write_raise(
        'CATALOG_INVALID_OPERATION',
        'variant-option link keys did not resolve'
      );
    end if;
    select vov.id, vov.option_value_id
      into v_found_id, v_found_value
      from public.variant_option_values vov
     where vov.company_id = p_company_id
       and vov.variant_id = v_variant_id
       and vov.option_id = v_option_id;
    if found then
      if v_found_value is distinct from v_value_id then
        perform public.catalog_write_raise(
          'CATALOG_INVALID_OPERATION',
          'existing variant-option link points at a different value'
        );
      end if;
    else
      if v_op = 'reuse' then
        perform public.catalog_write_raise(
          'CATALOG_INVALID_OPERATION',
          'REUSE variant-option link was not found'
        );
      end if;
      insert into public.variant_option_values (
        company_id, product_id, variant_id, option_id, option_value_id
      )
      values (
        p_company_id, p_product_id, v_variant_id, v_option_id, v_value_id
      );
    end if;
  end loop;

  v_arr := public.catalog_write_payload_array(v_payload, 'source_mappings');
  v_len := jsonb_array_length(v_arr);
  for v_i in 0 .. v_len - 1 loop
    v_elem := v_arr -> v_i;
    v_op := lower(trim(both from coalesce(v_elem->>'operation', v_elem->>'action', '')));
    v_integration_id := public.catalog_write_payload_uuid(v_elem, 'integration_id');
    v_ext_product := nullif(trim(both from coalesce(v_elem->>'external_product_id', '')), '');
    v_ext_variant := coalesce(v_elem->>'external_variant_id', '');
    v_ext_sku := nullif(trim(both from coalesce(v_elem->>'external_sku', '')), '');
    if jsonb_typeof(v_elem->'metadata') = 'object' then
      v_metadata := v_elem->'metadata';
    else
      v_metadata := '{}'::jsonb;
    end if;
    v_key := trim(both from coalesce(v_elem->>'variant_key', ''));
    v_variant_id := public.catalog_write_payload_uuid(
      jsonb_build_object('id', v_variant_ids ->> v_key),
      'id'
    );
    if v_variant_id is null then
      perform public.catalog_write_raise(
        'CATALOG_VARIANT_NOT_FOUND',
        'mapping variant_key was not resolved'
      );
    end if;

    v_found_id := null;
    select csm.id, csm.internal_product_id, csm.internal_variant_id, csm.external_sku, csm.metadata
      into v_found_id, v_existing_product, v_existing_variant, v_existing_sku, v_existing_metadata
      from public.catalog_source_mappings csm
     where csm.company_id = p_company_id
       and csm.integration_id = v_integration_id
       and csm.external_product_id = v_ext_product
       and csm.external_variant_id = v_ext_variant;

    if found then
      if v_op = 'create' then
        perform public.catalog_write_raise(
          'CATALOG_MAPPING_CONFLICT',
          'CREATE mapping identity already exists'
        );
      end if;
      if v_existing_product is distinct from p_product_id
         or v_existing_variant is distinct from v_variant_id then
        perform public.catalog_write_raise(
          'CATALOG_MAPPING_CONFLICT',
          'mapping identity points at a different internal product/variant'
        );
      end if;
      if v_op = 'update'
         or v_existing_sku is distinct from v_ext_sku
         or v_existing_metadata is distinct from v_metadata then
        update public.catalog_source_mappings
           set external_sku = v_ext_sku,
               metadata = v_metadata
         where id = v_found_id
           and company_id = p_company_id
        returning id into v_found_id;
      end if;
    else
      if v_op in ('reuse', 'update') then
        perform public.catalog_write_raise(
          'CATALOG_MAPPING_CONFLICT',
          'REUSE/UPDATE mapping identity was not found'
        );
      end if;
      insert into public.catalog_source_mappings (
        company_id, integration_id, external_product_id, external_variant_id,
        internal_product_id, internal_variant_id, external_sku, metadata
      )
      values (
        p_company_id, v_integration_id, v_ext_product, v_ext_variant,
        p_product_id, v_variant_id, v_ext_sku, v_metadata
      )
      returning id into v_found_id;
    end if;
    v_mapping_rows := v_mapping_rows || jsonb_build_array(
      jsonb_build_object(
        'integrationId', v_integration_id,
        'externalProductId', v_ext_product,
        'externalVariantId', v_ext_variant,
        'id', v_found_id
      )
    );
  end loop;

  return jsonb_build_object(
    'productId', p_product_id,
    'productType', p_product_type,
    'variants', v_variant_ids,
    'options', v_option_ids,
    'optionValues', v_value_ids,
    'mappings', v_mapping_rows
  );
end;
$catalog$;

comment on function public.apply_catalog_product_plan(uuid, uuid, text, jsonb) is
  'C1H3 executor: apply one already-reviewed canonical catalog product plan atomically. Invoker rights. Exactly one default variant. Collision-safe option/value maps. service_role only.';

revoke all on function public.catalog_write_raise(text, text) from public;
revoke all on function public.catalog_write_payload_array(jsonb, text) from public;
revoke all on function public.catalog_write_payload_object(jsonb, text) from public;
revoke all on function public.catalog_write_payload_uuid(jsonb, text) from public;
revoke all on function public.catalog_write_payload_bool(jsonb, text, boolean) from public;
revoke all on function public.catalog_write_payload_int(jsonb, text, integer) from public;
revoke all on function public.catalog_write_payload_numeric(jsonb, text) from public;
revoke all on function public.apply_catalog_product_plan(uuid, uuid, text, jsonb) from public;

do $priv$
declare
  fn text;
begin
  foreach fn in array array[
    'public.catalog_write_raise(text, text)',
    'public.catalog_write_payload_array(jsonb, text)',
    'public.catalog_write_payload_object(jsonb, text)',
    'public.catalog_write_payload_uuid(jsonb, text)',
    'public.catalog_write_payload_bool(jsonb, text, boolean)',
    'public.catalog_write_payload_int(jsonb, text, integer)',
    'public.catalog_write_payload_numeric(jsonb, text)',
    'public.apply_catalog_product_plan(uuid, uuid, text, jsonb)'
  ]
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'revoke all on function ' || fn || ' from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on function ' || fn || ' from authenticated';
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'grant execute on function ' || fn || ' to service_role';
    end if;
  end loop;
end;
$priv$;

notify pgrst, 'reload schema';
