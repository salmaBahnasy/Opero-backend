process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const {
  STATUS,
  ACTION,
  COMMIT_DISABLED_MESSAGE,
  planCatalogBackfill,
  parseCatalogBackfillCliArgs,
} = require("../src/services/catalogBackfill.service");
const {
  WRITE_CODE,
  writeCatalogProductPlan,
} = require("../src/services/catalogWriter.service");
const {
  APPLY_CATALOG_PRODUCT_PLAN_RPC,
  buildApplyCatalogProductPlanArgs,
} = require("../src/services/catalogWriteRpc");
const {
  createMemoryCatalogStore,
  createMemoryCatalogTransaction,
} = require("./helpers/memoryCatalogTransaction");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SHOPIFY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EASY_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

function integration(id, provider, companyId = COMPANY_A) {
  return { id, company_id: companyId, provider, category: "commerce", is_enabled: true };
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

function shopifySimpleProduct() {
  return product({
    source_integration_id: SHOPIFY_A,
    easyorder_id: "100",
    sku: "SH-1",
    raw_data: {
      provider: "shopify",
      variants: [
        {
          id: "1231",
          sku: "SH-1",
          price: "10.00",
          title: "Default Title",
          selected_options: [{ name: "Title", value: "Default Title" }],
        },
      ],
    },
  });
}

function shopifyVariableProduct() {
  return product({
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
  });
}

function planFor(products, integrations) {
  return planCatalogBackfill({ products, integrations }).plans[0];
}

function successfulRpcData(plan, args) {
  const variants = {};
  for (const row of plan.variants || []) variants[row.variant_key] = `var-${row.variant_key}`;
  const options = {};
  for (const row of plan.options || []) options[row.name] = `opt-${row.name}`;
  const optionValues = {};
  for (const row of plan.option_values || []) {
    optionValues[row.option_name] = optionValues[row.option_name] || {};
    optionValues[row.option_name][row.value] = `val-${row.value}`;
  }
  return {
    productId: args.p_product_id,
    productType: args.p_product_type,
    variants,
    options,
    optionValues,
    mappings: (plan.source_mappings || []).map((row) => ({
      integrationId: row.integration_id,
      externalProductId: row.external_product_id,
      externalVariantId: row.external_variant_id,
      id: `map-${row.external_variant_id || "none"}`,
    })),
  };
}

function mockRpc(plan, { error, data, mutate } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (typeof mutate === "function") mutate(args);
    if (error) return { data: null, error };
    return { data: data ? data(plan, args) : successfulRpcData(plan, args), error: null };
  };
  return { rpc, calls };
}

async function writeViaRpc(plan, { integrations, rpc, companyId } = {}) {
  return writeCatalogProductPlan(plan, {
    companyId: companyId || COMPANY_A,
    integrations: integrations || [],
    rpc,
  });
}

describe("C1I-B catalog writer RPC adapter", () => {
  it("1-2. READY and READY_WITH_WARNINGS invoke mocked RPC exactly once", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const ready = planFor([shopifySimpleProduct()], integrations);
    assert.equal(ready.status, STATUS.READY);
    const readyMock = mockRpc(ready);
    const readyResult = await writeViaRpc(ready, { integrations, rpc: readyMock.rpc });
    assert.equal(readyMock.calls.length, 1);
    assert.equal(readyResult.productId, ready.product_id);
    assert.equal(readyResult.productType, "simple");
    assert.ok(Array.isArray(readyResult.variantIds));
    assert.ok(Array.isArray(readyResult.sourceMappings));

    const warned = planFor([shopifySimpleProduct()], integrations);
    warned.status = STATUS.READY_WITH_WARNINGS;
    const warnedMock = mockRpc(warned);
    await writeViaRpc(warned, { integrations, rpc: warnedMock.rpc });
    assert.equal(warnedMock.calls.length, 1);
  });

  it("3-4. BLOCKED and CONFLICT invoke zero RPC calls", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const blocked = planFor([shopifySimpleProduct()], integrations);
    blocked.status = STATUS.BLOCKED;
    const blockedMock = mockRpc(blocked);
    await assert.rejects(
      () => writeViaRpc(blocked, { integrations, rpc: blockedMock.rpc }),
      (err) => err.code === WRITE_CODE.BLOCKED,
    );
    assert.equal(blockedMock.calls.length, 0);

    const conflict = planFor([shopifySimpleProduct()], integrations);
    conflict.variants[0].action = ACTION.CONFLICT;
    const conflictMock = mockRpc(conflict);
    await assert.rejects(
      () => writeViaRpc(conflict, { integrations, rpc: conflictMock.rpc }),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(conflictMock.calls.length, 0);
  });

  it("5-7. wrong tenant and integration ownership invoke zero RPC calls", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planFor([shopifySimpleProduct()], integrations);
    const tenantMock = mockRpc(plan);
    await assert.rejects(
      () => writeViaRpc(plan, { integrations, rpc: tenantMock.rpc, companyId: COMPANY_B }),
      (err) => err.code === WRITE_CODE.TENANT_MISMATCH,
    );
    assert.equal(tenantMock.calls.length, 0);

    const missingMock = mockRpc(plan);
    await assert.rejects(
      () => writeViaRpc(plan, { integrations: [], rpc: missingMock.rpc }),
      (err) => err.code === WRITE_CODE.INVALID_PLAN,
    );
    assert.equal(missingMock.calls.length, 0);

    const foreign = [integration(SHOPIFY_A, "shopify", COMPANY_B)];
    const foreignMock = mockRpc(plan);
    await assert.rejects(
      () => writeViaRpc(plan, { integrations: foreign, rpc: foreignMock.rpc }),
      (err) => err.code === WRITE_CODE.TENANT_MISMATCH,
    );
    assert.equal(foreignMock.calls.length, 0);
  });

  it("8-9. zero or multiple defaults invoke zero RPC calls", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const zero = planFor([shopifySimpleProduct()], integrations);
    zero.variants[0].is_default = false;
    const zeroMock = mockRpc(zero);
    await assert.rejects(
      () => writeViaRpc(zero, { integrations, rpc: zeroMock.rpc }),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(zeroMock.calls.length, 0);

    const many = planFor([shopifySimpleProduct()], integrations);
    many.variants.push({ ...many.variants[0], variant_key: "second", is_default: true });
    const manyMock = mockRpc(many);
    await assert.rejects(
      () => writeViaRpc(many, { integrations, rpc: manyMock.rpc }),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(manyMock.calls.length, 0);
  });

  it("10-12. simple and variable are accepted; bundle is rejected", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const simple = planFor([shopifySimpleProduct()], integrations);
    assert.equal(simple.planned_product_type, "simple");
    const simpleMock = mockRpc(simple);
    const simpleResult = await writeViaRpc(simple, { integrations, rpc: simpleMock.rpc });
    assert.equal(simpleResult.productType, "simple");

    const variable = planFor([shopifyVariableProduct()], integrations);
    assert.equal(variable.planned_product_type, "variable");
    const variableMock = mockRpc(variable);
    const variableResult = await writeViaRpc(variable, { integrations, rpc: variableMock.rpc });
    assert.equal(variableResult.productType, "variable");

    const bundle = planFor([shopifySimpleProduct()], integrations);
    bundle.planned_product_type = "bundle";
    const bundleMock = mockRpc(bundle);
    await assert.rejects(
      () => writeViaRpc(bundle, { integrations, rpc: bundleMock.rpc }),
      (err) => err.code === WRITE_CODE.INVALID_PLAN,
    );
    assert.equal(bundleMock.calls.length, 0);
  });

  it("13-17. RPC name, argument names, trusted companyId, builder payload, no credentials", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planFor([shopifyVariableProduct()], integrations);
    const expected = buildApplyCatalogProductPlanArgs(plan, { companyId: COMPANY_A });
    const mock = mockRpc(plan);
    await writeViaRpc(plan, { integrations, rpc: mock.rpc });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].name, APPLY_CATALOG_PRODUCT_PLAN_RPC);
    assert.deepEqual(Object.keys(mock.calls[0].args).sort(), [
      "p_company_id",
      "p_payload",
      "p_product_id",
      "p_product_type",
    ]);
    assert.equal(mock.calls[0].args.p_company_id, COMPANY_A);
    assert.deepEqual(mock.calls[0].args, expected);
    const payloadText = JSON.stringify(mock.calls[0].args.p_payload);
    assert.equal(payloadText.includes("test-service-role-key"), false);
    assert.equal(payloadText.includes("access_token"), false);
    assert.equal(payloadText.includes("service_role"), false);
    assert.deepEqual(Object.keys(mock.calls[0].args.p_payload).sort(), [
      "option_values",
      "options",
      "source_mappings",
      "variant_option_values",
      "variants",
    ]);
  });

  it("18-21. successful result is normalized; malformed/mismatched results fail closed", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planFor([shopifySimpleProduct()], integrations);
    const ok = await writeViaRpc(plan, { integrations, rpc: mockRpc(plan).rpc });
    assert.equal(ok.productId, plan.product_id);
    assert.equal(ok.productType, plan.planned_product_type);
    assert.ok(ok.optionIds && typeof ok.optionIds === "object");
    assert.ok(ok.optionValueIds && typeof ok.optionValueIds === "object");

    const malformed = mockRpc(plan, { data: () => "nope" });
    await assert.rejects(
      () => writeViaRpc(plan, { integrations, rpc: malformed.rpc }),
      (err) => err.code === WRITE_CODE.MALFORMED_RPC_RESULT,
    );

    const idMismatch = mockRpc(plan, {
      data: (_plan, args) => ({
        ...successfulRpcData(plan, args),
        productId: "99999999-9999-4999-8999-999999999999",
      }),
    });
    await assert.rejects(
      () => writeViaRpc(plan, { integrations, rpc: idMismatch.rpc }),
      (err) => err.code === WRITE_CODE.MALFORMED_RPC_RESULT,
    );

    const typeMismatch = mockRpc(plan, {
      data: (_plan, args) => ({
        ...successfulRpcData(plan, args),
        productType: "bundle",
      }),
    });
    await assert.rejects(
      () => writeViaRpc(plan, { integrations, rpc: typeMismatch.rpc }),
      (err) => err.code === WRITE_CODE.MALFORMED_RPC_RESULT,
    );
  });

  it("22-27. catalog and native PG errors are normalized, never success, and never retried", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planFor([shopifySimpleProduct()], integrations);

    const catalog = mockRpc(plan, {
      error: {
        code: "P0001",
        hint: "CATALOG_TENANT_MISMATCH",
        message: "CATALOG_TENANT_MISMATCH: product does not belong to company",
      },
    });
    await assert.rejects(
      () => writeViaRpc(plan, { integrations, rpc: catalog.rpc }),
      (err) => err.code === "CATALOG_TENANT_MISMATCH" && err.sqlState === "P0001",
    );
    assert.equal(catalog.calls.length, 1);

    for (const sqlState of ["23505", "23503", "22003"]) {
      const mock = mockRpc(plan, { error: { code: sqlState, message: `pg ${sqlState}` } });
      await assert.rejects(
        () => writeViaRpc(plan, { integrations, rpc: mock.rpc }),
        (err) => err.code === sqlState && err.sqlState === sqlState,
      );
      assert.equal(mock.calls.length, 1);
    }
  });

  it("28-31. one success call, no live host, memory writer still works, EasyOrders incomplete blocked", async () => {
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planFor([shopifySimpleProduct()], integrations);
    const mock = mockRpc(plan);
    await writeViaRpc(plan, { integrations, rpc: mock.rpc });
    assert.equal(mock.calls.length, 1);

    process.env.SUPABASE_URL = "https://iydepmuniwybqgejawhf.supabase.co";
    try {
      await assert.rejects(
        () => writeCatalogProductPlan(plan, { companyId: COMPANY_A, integrations }),
        (err) => err.code === WRITE_CODE.TRANSACTION_UNAVAILABLE,
      );
    } finally {
      process.env.SUPABASE_URL = "https://example.supabase.co";
    }

    const manual = planCatalogBackfill({
      products: [product()],
      integrations: [],
    }).plans[0];
    const store = createMemoryCatalogStore({
      products: [product()],
      integrations: [],
    });
    const memory = await writeCatalogProductPlan(manual, {
      companyId: COMPANY_A,
      tx: createMemoryCatalogTransaction(store),
      integrations: [],
    });
    assert.equal(memory.product_id, "11111111-aaaa-4111-8111-111111111111");
    assert.equal(store.product_variants.length, 1);

    const incomplete = planCatalogBackfill({
      products: [
        product({
          source_integration_id: EASY_A,
          easyorder_id: "eo-1",
          sku: "EO-1",
          raw_data: { provider: "easyorders", variants: [] },
        }),
      ],
      integrations: [integration(EASY_A, "easyorders")],
    }).plans[0];
    const incompleteMock = mockRpc(incomplete);
    await assert.rejects(
      () => writeViaRpc(incomplete, {
        integrations: [integration(EASY_A, "easyorders")],
        rpc: incompleteMock.rpc,
      }),
      (err) => err.code === WRITE_CODE.INCOMPLETE_EASYORDERS,
    );
    assert.equal(incompleteMock.calls.length, 0);
  });

  it("32-37. no provider/import/manual/CLI caller, migrations unchanged, no frontend, no HTTP", async () => {
    const originalGet = axios.get;
    let httpCalls = 0;
    axios.get = async (...args) => {
      httpCalls += 1;
      return originalGet(...args);
    };
    try {
      const integrations = [integration(SHOPIFY_A, "shopify")];
      const plan = planFor([shopifySimpleProduct()], integrations);
      await writeViaRpc(plan, { integrations, rpc: mockRpc(plan).rpc });
      assert.equal(httpCalls, 0);
    } finally {
      axios.get = originalGet;
    }

    const cliSrc = read("scripts/catalog-backfill.js");
    assert.doesNotMatch(cliSrc, /catalogWriter|catalogWriteRpc|apply_catalog_product_plan/);
    const commit = parseCatalogBackfillCliArgs(["--commit"]);
    assert.equal(commit.commit, true);
    assert.match(COMMIT_DISABLED_MESSAGE, /disabled/i);

    for (const relative of [
      "src/services/products.service.js",
      "src/services/sallaProducts.service.js",
      "src/services/easyorder.service.js",
      "src/controllers/ordersImport.controller.js",
      "src/services/importSources.service.js",
    ]) {
      const src = read(relative);
      assert.doesNotMatch(src, /writeCatalogProductPlan\(/);
      assert.doesNotMatch(src, /apply_catalog_product_plan/);
    }
    const shopifySrc = read("src/services/shopifyProducts.service.js");
    assert.match(shopifySrc, /writeShopifyCatalogDualWrite\(/);
    assert.doesNotMatch(shopifySrc, /apply_catalog_product_plan/);
    assert.doesNotMatch(shopifySrc, /catalogWriteRpc/);

    assert.match(read("supabase/migrations/013_catalog_foundation.sql"), /create table if not exists public\.product_variants/);
    assert.match(read("supabase/migrations/014_catalog_write_rpc.sql"), /apply_catalog_product_plan/);
    assert.equal(fs.existsSync(path.join(BACKEND_ROOT, "supabase/migrations/015_catalog_write_rpc.sql")), false);
    assert.doesNotMatch(read("src/services/catalogWriter.service.js"), /VITE_/);
    assert.doesNotMatch(read("src/services/catalogWriteRpc.js"), /VITE_/);
  });
});
