process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const {
  COMMIT_DISABLED_MESSAGE,
  planCatalogBackfill,
  parseCatalogBackfillCliArgs,
} = require("../src/services/catalogBackfill.service");
const {
  WRITE_CODE,
  createSupabaseRestCatalogTransaction,
} = require("../src/services/catalogWriter.service");
const {
  APPLY_CATALOG_PRODUCT_PLAN_RPC,
  buildApplyCatalogProductPlanArgs,
  applyCatalogProductPlanViaRpc,
} = require("../src/services/catalogWriteRpc.js");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const MIGRATION_014 = path.join(
  BACKEND_ROOT,
  "supabase/migrations/014_catalog_write_rpc.sql",
);
const MIGRATION_013 = path.join(
  BACKEND_ROOT,
  "supabase/migrations/013_catalog_foundation.sql",
);
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const SHOPIFY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

function product(overrides = {}) {
  return {
    id: "11111111-aaaa-4111-8111-111111111111",
    company_id: COMPANY_A,
    product_type: "simple",
    source_integration_id: null,
    easyorder_id: "LOCAL-SKU",
    sku: "LOCAL-SKU",
    raw_data: { name: "Pillow", sku: "LOCAL-SKU", price: 120 },
    ...overrides,
  };
}

function integration(id, provider) {
  return { id, company_id: COMPANY_A, provider, category: "commerce", is_enabled: true };
}

function shopifyVariablePlan() {
  return planCatalogBackfill({
    products: [
      product({
        source_integration_id: SHOPIFY_A,
        easyorder_id: "200",
        sku: "TS-B-M",
        raw_data: {
          provider: "shopify",
          variants: [
            {
              id: "1",
              sku: "TS-B-M",
              price: "10.00",
              title: "Black / M",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
            },
          ],
        },
      }),
    ],
    integrations: [integration(SHOPIFY_A, "shopify")],
  }).plans[0];
}

describe("C1H3 catalog write RPC migration (review only)", () => {
  const sql = fs.readFileSync(MIGRATION_014, "utf8");
  const sql013 = fs.readFileSync(MIGRATION_013, "utf8");

  it("creates 014 in place with the expected function signature and search_path", () => {
    assert.equal(fs.existsSync(MIGRATION_014), true);
    assert.equal(fs.existsSync(path.join(BACKEND_ROOT, "supabase/migrations/015_catalog_write_rpc.sql")), false);
    assert.match(
      sql,
      /create or replace function public\.apply_catalog_product_plan\(\s*p_company_id uuid,\s*p_product_id uuid,\s*p_product_type text,\s*p_payload jsonb\s*\)/s,
    );
    assert.match(sql, /set search_path = public, pg_temp/);
    assert.equal(APPLY_CATALOG_PRODUCT_PLAN_RPC, "apply_catalog_product_plan");
    const header = sql.slice(
      sql.lastIndexOf("create or replace function public.apply_catalog_product_plan"),
      sql.indexOf("$catalog$", sql.lastIndexOf("create or replace function public.apply_catalog_product_plan")),
    );
    assert.doesNotMatch(header, /security\s+definer/i);
    assert.match(header, /set search_path = public, pg_temp/);
  });

  it("requires exactly one default before any default-clear mutation", () => {
    assert.match(sql, /CATALOG_INVALID_DEFAULT_VARIANT_COUNT/);
    assert.match(sql, /v_default_count is distinct from 1/);
    const countIdx = sql.indexOf("v_default_count is distinct from 1");
    const clearIdx = sql.indexOf("set is_default = false");
    assert.ok(countIdx > 0 && clearIdx > countIdx);
    assert.match(sql, /nominated default variant key did not resolve/);
  });

  it("parses payload UUID/boolean/integer/numeric without raw mutation ::uuid", () => {
    assert.match(sql, /catalog_write_payload_uuid/);
    assert.match(sql, /catalog_write_payload_bool/);
    assert.match(sql, /catalog_write_payload_int/);
    assert.match(sql, /catalog_write_payload_numeric/);
    assert.match(sql, /must be a UUID string/);
    assert.match(sql, /must be a JSON boolean/);
    assert.match(sql, /must be a JSON number/);
    const mutateStart = sql.indexOf("-- ---------- mutations");
    const mutateSql = sql.slice(mutateStart);
    assert.doesNotMatch(mutateSql, /->>\s*'id'\)\s*,\s*''\)\)\s*,\s*''\)\)::uuid/);
    assert.match(sql, /native 22003/);
  });

  it("uses nested option/value maps instead of :: concatenation", () => {
    assert.doesNotMatch(sql, /v_option_key \|\| '::' \|\| /);
    assert.match(sql, /jsonb_set\(/);
    assert.match(sql, /v_value_ids -> v_option_key/);
    assert.match(sql, /array\[v_option_key\]/);
  });

  it("pre-validates variant_option_values and source mappings before mutation", () => {
    const mutateStart = sql.indexOf("-- ---------- mutations");
    const before = sql.slice(0, mutateStart);
    assert.match(before, /variant-option link requires variant_key, option_key, and value_key/);
    assert.match(before, /variant-option link variant_key is not in the payload/);
    assert.match(before, /variant-option link option_key is not in the payload/);
    assert.match(before, /variant-option link value_key is not in the payload/);
    assert.match(before, /mapping variant_key is not in the payload/);
    assert.match(before, /mapping requires exact integration UUID/);
    assert.match(before, /element must be a JSON object/);
    assert.match(sql, /CREATE mapping identity already exists/);
    assert.match(sql, /REUSE\/UPDATE mapping identity was not found/);
    assert.match(sql, /REUSE variant-option link was not found/);
    assert.match(sql, /Fail-closed operations/);
    assert.match(sql, /invalid_text_representation/);
  });

  it("locks the product, stays tenant-safe, and does not DELETE catalog rows", () => {
    assert.match(sql, /for update/);
    assert.match(sql, /p\.id = p_product_id/);
    assert.match(sql, /p\.company_id = p_company_id/);
    assert.match(sql, /for share/);
    assert.match(sql, /CATALOG_TENANT_MISMATCH/);
    assert.doesNotMatch(sql, /delete\s+from\s+public\.(product_variants|product_options|product_option_values|variant_option_values|catalog_source_mappings|products)/i);
    assert.doesNotMatch(sql, /\bcommit\s*;/i);
  });

  it("returns structured mapping objects and revokes PUBLIC execute", () => {
    assert.match(sql, /'integrationId'/);
    assert.match(sql, /'externalProductId'/);
    assert.match(sql, /'externalVariantId'/);
    assert.match(sql, /v_mapping_rows jsonb := '\[\]'::jsonb/);
    assert.match(
      sql,
      /revoke all on function public\.apply_catalog_product_plan\(uuid, uuid, text, jsonb\) from public/i,
    );
    assert.match(sql, /from anon/i);
    assert.match(sql, /from authenticated/i);
    assert.match(sql, /grant execute on function ' \|\| fn \|\| ' to service_role/);
  });

  it("does not alter Migration 013 or parse providers", () => {
    assert.doesNotMatch(sql, /alter table public\.products/i);
    assert.doesNotMatch(sql, /drop table/i);
    assert.doesNotMatch(sql, /shopify|salla|easyorder/i);
    assert.match(sql013, /create table if not exists public\.product_variants/);
    assert.match(sql, /Inspected APPLIED Migration 013/);
  });

  it("keeps live adapters, provider sync, and CLI --commit disconnected", () => {
    assert.throws(
      () => createSupabaseRestCatalogTransaction(),
      (err) => err.code === WRITE_CODE.TRANSACTION_UNAVAILABLE,
    );
    const writerSrc = read("src/services/catalogWriter.service.js");
    assert.doesNotMatch(writerSrc, /require\(["'][^"']*supabase/);
    assert.match(writerSrc, /applyCatalogProductPlanViaRpc/);
    assert.match(writerSrc, /REUSE\/UPDATE mapping identity was not found/);
    const rpcSrc = read("src/services/catalogWriteRpc.js");
    assert.match(rpcSrc, /require\(["']\.\.\/config\/supabase["']\)/);
    assert.doesNotMatch(rpcSrc.slice(0, rpcSrc.indexOf("function resolveCatalogRpc")), /require\(["'][^"']*supabase/);
    const cliSrc = read("scripts/catalog-backfill.js");
    assert.doesNotMatch(cliSrc, /catalogWriter|catalogWriteRpc|apply_catalog_product_plan/);
    const commit = parseCatalogBackfillCliArgs(["--commit"]);
    assert.equal(commit.commit, true);
    assert.match(COMMIT_DISABLED_MESSAGE, /disabled/i);
    for (const relative of [
      "src/services/products.service.js",
      "src/services/shopifyProducts.service.js",
      "src/services/sallaProducts.service.js",
      "src/services/easyorder.service.js",
    ]) {
      assert.doesNotMatch(read(relative), /catalogWriteRpc|apply_catalog_product_plan/);
    }
  });

  it("builds a collision-safe payload with exactly one default", async () => {
    const originalGet = axios.get;
    let httpCalls = 0;
    axios.get = async (...args) => {
      httpCalls += 1;
      return originalGet(...args);
    };
    try {
      const plan = shopifyVariablePlan();
      const args = buildApplyCatalogProductPlanArgs(plan, { companyId: COMPANY_A });
      const defaults = args.p_payload.variants.filter((row) => row.is_default);
      assert.equal(defaults.length, 1);
      assert.equal(args.p_payload.variants[0].price, 10);
      assert.equal(args.p_payload.option_values[0].value_key, args.p_payload.option_values[0].value);
      assert.notEqual(
        args.p_payload.option_values[0].value_key,
        `${args.p_payload.option_values[0].option_key}::${args.p_payload.option_values[0].value}`,
      );
      assert.equal(args.p_payload.variant_option_values[0].value_key, "Black");
      assert.equal(args.p_payload.variant_option_values[1].value_key, "M");
      assert.equal(httpCalls, 0);

      const data = await applyCatalogProductPlanViaRpc(plan, {
        companyId: COMPANY_A,
        integrations: [integration(SHOPIFY_A, "shopify")],
        rpc: async (name, rpcArgs) => ({
          data: {
            productId: rpcArgs.p_product_id,
            productType: rpcArgs.p_product_type,
            variants: { [plan.variants[0].variant_key]: "var-1" },
            options: { Color: "opt-color", Size: "opt-size" },
            optionValues: { Color: { Black: "val-black" }, Size: { M: "val-m" } },
            mappings: [
              {
                integrationId: SHOPIFY_A,
                externalProductId: "200",
                externalVariantId: "1",
                id: "map-1",
              },
            ],
          },
          error: null,
        }),
      });
      assert.equal(data.sourceMappings[0].id, "map-1");
      await assert.rejects(
        () => applyCatalogProductPlanViaRpc(plan, {
          companyId: COMPANY_A,
          integrations: [integration(SHOPIFY_A, "shopify")],
        }),
        (err) => err.code === WRITE_CODE.TRANSACTION_UNAVAILABLE,
      );
    } finally {
      axios.get = originalGet;
    }
  });

  it("preserves Arabic, colon, quote, slash, and dot keys in the builder", () => {
    const plan = shopifyVariablePlan();
    plan.options = [
      { action: "CREATE", name: "لون", position: 0 },
      { action: "CREATE", name: 'a::b/c.d"', position: 1 },
    ];
    plan.option_values = [
      { action: "CREATE", option_name: "لون", value: "أسود", position: 0 },
      { action: "CREATE", option_name: 'a::b/c.d"', value: "x::y", position: 1 },
    ];
    plan.variants[0].option_pairs = [
      { name: "لون", value: "أسود" },
      { name: 'a::b/c.d"', value: "x::y" },
    ];
    const args = buildApplyCatalogProductPlanArgs(plan, { companyId: COMPANY_A });
    assert.equal(args.p_payload.options[0].key, "لون");
    assert.equal(args.p_payload.option_values[0].value_key, "أسود");
    assert.equal(args.p_payload.option_values[1].option_key, 'a::b/c.d"');
    assert.equal(args.p_payload.option_values[1].value_key, "x::y");
    assert.equal(args.p_payload.variant_option_values[1].value_key, "x::y");
    assert.notEqual(
      args.p_payload.option_values[1].value_key,
      `${args.p_payload.option_values[1].option_key}::${args.p_payload.option_values[1].value}`,
    );
  });

  it("does not pretend memory tests executed PostgreSQL or coerced invalid prices to 0", () => {
    assert.match(sql, /Do NOT run until approved/);
    assert.doesNotMatch(sql, /insert into public\.products/);
    const plan = shopifyVariablePlan();
    plan.variants[0].price = null;
    const args = buildApplyCatalogProductPlanArgs(plan, { companyId: COMPANY_A });
    assert.equal(args.p_payload.variants[0].price, null);
    assert.notEqual(args.p_payload.variants[0].price, 0);
  });
});
