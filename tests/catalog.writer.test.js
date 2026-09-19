process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, beforeEach, afterEach } = require("node:test");
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
const { planCatalogBackfillFromEasyOrdersSnapshots } = require("../src/services/catalogPlanning.adapter");
const {
  WRITE_CODE,
  assertWriteEligible,
  createSupabaseRestCatalogTransaction,
  writeCatalogProductPlan,
  writeCatalogProductPlans,
} = require("../src/services/catalogWriter.service");
const {
  createMemoryCatalogStore,
  createMemoryCatalogTransaction,
  existingFromStore,
} = require("./helpers/memoryCatalogTransaction");
const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { deleteConnection } = require("../src/services/companyIntegrations.service");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SHOPIFY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SALLA_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EASY_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EASY_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BACKEND_ROOT = path.resolve(__dirname, "..");

function integration(id, provider, companyId = COMPANY_A) {
  return { id, company_id: companyId, provider, category: "commerce", is_enabled: true };
}

function product(overrides = {}) {
  return {
    id: "prod-1",
    company_id: COMPANY_A,
    product_type: "simple",
    source_integration_id: null,
    easyorder_id: "LOCAL-SKU",
    sku: "LOCAL-SKU",
    raw_data: { name: "Pillow", sku: "LOCAL-SKU", price: 120 },
    ...overrides,
  };
}

function shopifyVariant(id, extra = {}) {
  return {
    id: String(id),
    product_id: "100",
    title: extra.title ?? "Default Title",
    sku: extra.sku ?? "SH-1",
    price: extra.price ?? "10.00",
    sale_price: extra.price ?? "10.00",
    selected_options: extra.selected_options ?? [
      { name: "Title", value: "Default Title" },
    ],
    gid: `gid://shopify/ProductVariant/${id}`,
    shopify: { variant_id: String(id) },
    ...extra,
  };
}

function completeSimpleSnapshot(extra = {}) {
  return {
    externalProductId: extra.externalProductId || "eo-1",
    title: extra.title || "Cream",
    sku: extra.sku || "EO-1",
    price: extra.price ?? 15,
    variantsComplete: true,
    incomplete: false,
    productType: "simple",
    variants: [
      {
        externalVariantId: extra.variantId || "eo-v-simple",
        sku: extra.sku || "EO-1",
        price: extra.price ?? 15,
        isDefault: true,
        options: extra.options || [],
      },
    ],
  };
}

function completeVariableSnapshot() {
  const cells = [
    ["v1", "Black", "M", "TS-B-M"],
    ["v2", "Black", "L", "TS-B-L"],
    ["v3", "White", "M", "TS-W-M"],
    ["v4", "White", "L", "TS-W-L"],
  ];
  return {
    externalProductId: "eo-shirt",
    title: "T-Shirt",
    sku: "TS-B-M",
    price: 100,
    variantsComplete: true,
    incomplete: false,
    productType: "variable",
    variants: cells.map(([id, color, size, sku], index) => ({
      externalVariantId: id,
      sku,
      price: 100 + index,
      isDefault: index === 0,
      options: [
        { name: "Color", value: color },
        { name: "Size", value: size },
      ],
    })),
  };
}

function snapshotEntry(snapshot, extra = {}) {
  return {
    company_id: extra.company_id || COMPANY_A,
    source_integration_id: extra.source_integration_id || EASY_A,
    snapshot,
  };
}

function seedStore(products, integrations = []) {
  return createMemoryCatalogStore({
    products: products.map((row) => ({
      product_type: "simple",
      raw_data: row.raw_data || {},
      easyorder_id: row.easyorder_id,
      sku: row.sku,
      source_integration_id: row.source_integration_id || null,
      ...row,
    })),
    integrations,
  });
}

async function writePlan(plan, store, extra = {}) {
  const tx = createMemoryCatalogTransaction(store);
  if (extra.failOn) tx.failOn(extra.failOn);
  const result = await writeCatalogProductPlan(plan, {
    companyId: extra.companyId || COMPANY_A,
    tx,
    integrations: extra.integrations || store.company_integrations,
  });
  return { result, tx };
}

function snapshotStore(store) {
  return JSON.stringify(store);
}

function defaultsFor(store, productId) {
  return store.product_variants.filter(
    (row) => row.product_id === productId && row.is_default === true,
  );
}

describe("C1G canonical catalog writer", () => {
  it("1. blocked plan is refused with zero writes", async () => {
    const products = [
      product({
        id: "p-trunc",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "300",
        raw_data: {
          provider: "shopify",
          shopify: { variants_truncated: true },
          variants: [shopifyVariant("10", { sku: "X", title: "X" })],
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planCatalogBackfill({ products, integrations }).plans[0];
    assert.equal(plan.status, STATUS.BLOCKED);
    const store = seedStore(products, integrations);
    const before = snapshotStore(store);
    await assert.rejects(
      () => writePlan(plan, store),
      (err) => err.code === WRITE_CODE.BLOCKED,
    );
    assert.equal(snapshotStore(store), before);
  });

  it("2. ERROR diagnostic is refused", async () => {
    const products = [product()];
    const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
    plan.status = STATUS.READY;
    plan.diagnostics = [
      { code: "MALFORMED_OPTIONS", severity: "ERROR", message: "bad options" },
    ];
    const store = seedStore(products);
    const before = snapshotStore(store);
    await assert.rejects(
      () => writePlan(plan, store),
      (err) => err.code === WRITE_CODE.ERROR_DIAGNOSTIC,
    );
    assert.equal(snapshotStore(store), before);
  });

  it("3b. zero or multiple planned defaults are refused before any catalog mutation", async () => {
    const products = [product()];
    const zero = planCatalogBackfill({ products, integrations: [] }).plans[0];
    zero.variants[0].is_default = false;
    const zeroStore = seedStore(products);
    const beforeZero = snapshotStore(zeroStore);
    await assert.rejects(
      () => writePlan(zero, zeroStore),
      (err) =>
        err.code === WRITE_CODE.CONFLICT &&
        /exactly one default variant/i.test(err.message),
    );
    assert.equal(snapshotStore(zeroStore), beforeZero);

    const many = planCatalogBackfill({ products, integrations: [] }).plans[0];
    many.variants.push({ ...many.variants[0], variant_key: "second", is_default: true });
    const manyStore = seedStore(products);
    const beforeMany = snapshotStore(manyStore);
    await assert.rejects(
      () => writePlan(many, manyStore),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(snapshotStore(manyStore), beforeMany);
  });

  it("3. unresolved CONFLICT operation is refused", async () => {
    const products = [product()];
    const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
    plan.variants[0].action = ACTION.CONFLICT;
    const store = seedStore(products);
    const before = snapshotStore(store);
    await assert.rejects(
      () => writePlan(plan, store),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(snapshotStore(store), before);
  });

  it("4. manual simple product writes one default variant and no mapping", async () => {
    const products = [product()];
    const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
    const store = seedStore(products);
    const { result } = await writePlan(plan, store);
    assert.equal(result.product_id, "prod-1");
    assert.equal(store.products.length, 1);
    assert.equal(store.products[0].id, "prod-1");
    assert.equal(store.products[0].product_type, "simple");
    assert.equal(store.product_variants.length, 1);
    assert.equal(store.product_variants[0].is_default, true);
    assert.equal(store.product_variants[0].internal_sku, "LOCAL-SKU");
    assert.equal(store.product_variants[0].price, 120);
    assert.match(store.product_variants[0].id, UUID_RE);
    assert.equal(store.catalog_source_mappings.length, 0);
    assert.equal(store.product_options.length, 0);
  });

  it("5. Shopify simple Default Title keeps the real variant id in the mapping", async () => {
    const products = [
      product({
        id: "p-shop-simple",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "100",
        sku: "SH-1",
        raw_data: {
          provider: "shopify",
          variants: [shopifyVariant("1231")],
          shopify: { product_id: "100", variants_complete: true },
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planCatalogBackfill({ products, integrations }).plans[0];
    const store = seedStore(products, integrations);
    await writePlan(plan, store);
    assert.equal(store.product_variants.length, 1);
    assert.equal(store.catalog_source_mappings.length, 1);
    assert.equal(store.catalog_source_mappings[0].external_variant_id, "1231");
    assert.equal(store.catalog_source_mappings[0].integration_id, SHOPIFY_A);
    assert.notEqual(store.product_variants[0].id, "1231");
    assert.equal(store.product_options.length, 0);
  });

  it("6. Shopify variable writes options, values, links, and mappings", async () => {
    const products = [
      product({
        id: "p-shop-var",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "200",
        sku: "TS-B-M",
        raw_data: {
          provider: "shopify",
          variants: [
            shopifyVariant("1", {
              title: "Black / M",
              sku: "TS-B-M",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
            }),
            shopifyVariant("2", {
              title: "Black / L",
              sku: "TS-B-L",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "L" },
              ],
            }),
          ],
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planCatalogBackfill({ products, integrations }).plans[0];
    const store = seedStore(products, integrations);
    const { result } = await writePlan(plan, store);
    assert.equal(store.products[0].product_type, "variable");
    assert.equal(store.product_variants.length, 2);
    assert.equal(store.product_options.length, 2);
    assert.equal(store.product_option_values.length, 3);
    assert.equal(store.variant_option_values.length, 4);
    assert.equal(store.catalog_source_mappings.length, 2);
    assert.equal(defaultsFor(store, "p-shop-var").length, 1);
    assert.equal(result.created.variants, 2);
  });

  it("7. Salla simple writes barcode and exact SKU id mapping", async () => {
    const products = [
      product({
        id: "p-salla-simple",
        source_integration_id: SALLA_A,
        easyorder_id: "632910392",
        sku: "SERUM-30",
        raw_data: {
          provider: "salla",
          variants: [
            {
              id: "99001",
              sku: "SERUM-30",
              price: "100",
              sale_price: "100",
              selected_options: [],
              salla: { sku_id: "99001", barcode: "1234567890123", is_default: true },
            },
          ],
        },
      }),
    ];
    const integrations = [integration(SALLA_A, "salla")];
    const plan = planCatalogBackfill({ products, integrations }).plans[0];
    const store = seedStore(products, integrations);
    await writePlan(plan, store);
    assert.equal(store.product_variants[0].barcode, "1234567890123");
    assert.equal(store.catalog_source_mappings[0].external_variant_id, "99001");
    assert.equal(store.catalog_source_mappings[0].integration_id, SALLA_A);
  });

  it("8. Salla variable writes Color/Size options from selected_options", async () => {
    const products = [
      product({
        id: "p-salla-var",
        source_integration_id: SALLA_A,
        easyorder_id: "77",
        sku: "SHIRT-BLK-M",
        raw_data: {
          provider: "salla",
          variants: [
            {
              id: "sku-1",
              sku: "SHIRT-BLK-M",
              price: "50",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
              salla: { sku_id: "sku-1", is_default: true },
            },
            {
              id: "sku-2",
              sku: "SHIRT-WHT-L",
              price: "50",
              selected_options: [
                { name: "Color", value: "White" },
                { name: "Size", value: "L" },
              ],
              salla: { sku_id: "sku-2", is_default: false },
            },
          ],
        },
      }),
    ];
    const integrations = [integration(SALLA_A, "salla")];
    const plan = planCatalogBackfill({ products, integrations }).plans[0];
    const store = seedStore(products, integrations);
    await writePlan(plan, store);
    assert.equal(store.products[0].product_type, "variable");
    assert.equal(store.product_variants.length, 2);
    assert.deepEqual(
      store.product_options.map((row) => row.name).sort(),
      ["Color", "Size"],
    );
    assert.equal(store.product_option_values.length, 4);
    assert.equal(store.variant_option_values.length, 4);
  });

  it("9. EasyOrders enriched simple writes the real variant id", async () => {
    const products = [
      product({
        id: "prod-eo-1",
        source_integration_id: EASY_A,
        easyorder_id: "eo-1",
        sku: "EO-1",
        raw_data: { id: "eo-1", name: "Cream", sku: "EO-1", price: 15 },
      }),
    ];
    const integrations = [integration(EASY_A, "easyorders")];
    const plan = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations,
      products,
      snapshots: [snapshotEntry(completeSimpleSnapshot())],
    }).plans[0];
    const store = seedStore(products, integrations);
    await writePlan(plan, store);
    assert.equal(store.catalog_source_mappings[0].external_variant_id, "eo-v-simple");
    assert.notEqual(store.catalog_source_mappings[0].external_variant_id, "");
    assert.equal(store.product_variants.length, 1);
  });

  it("10. EasyOrders enriched variable writes four variants and two option dimensions", async () => {
    const products = [
      product({
        id: "prod-shirt",
        source_integration_id: EASY_A,
        easyorder_id: "eo-shirt",
        sku: "TS-B-M",
        raw_data: { id: "eo-shirt", name: "T-Shirt" },
      }),
    ];
    const integrations = [integration(EASY_A, "easyorders")];
    const plan = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations,
      products,
      snapshots: [snapshotEntry(completeVariableSnapshot())],
    }).plans[0];
    const store = seedStore(products, integrations);
    await writePlan(plan, store);
    assert.equal(store.product_variants.length, 4);
    assert.equal(store.product_options.length, 2);
    assert.equal(store.product_option_values.length, 4);
    assert.equal(store.variant_option_values.length, 8);
    assert.equal(store.catalog_source_mappings.length, 4);
    assert.equal(defaultsFor(store, "prod-shirt").length, 1);
  });

  it("11. EasyOrders incomplete and list-only blank variant ids are refused", async () => {
    const products = [
      product({
        id: "prod-eo-1",
        source_integration_id: EASY_A,
        easyorder_id: "eo-1",
        sku: "EO-1",
        raw_data: { id: "eo-1", name: "Cream", sku: "EO-1", price: 15 },
      }),
    ];
    const integrations = [integration(EASY_A, "easyorders")];
    const incomplete = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations,
      products,
      snapshots: [
        snapshotEntry({
          externalProductId: "eo-1",
          title: "Cream",
          variantsComplete: false,
          incomplete: true,
          variants: [],
        }),
      ],
    }).plans[0];
    const listOnly = planCatalogBackfill({ products, integrations }).plans[0];
    assert.ok(
      listOnly.diagnostics.some((item) => item.code === "EASYORDERS_VARIANTS_NOT_STORED"),
    );
    const store = seedStore(products, integrations);
    const before = snapshotStore(store);
    await assert.rejects(
      () => writePlan(incomplete, store),
      (err) => err.code === WRITE_CODE.INCOMPLETE_EASYORDERS,
    );
    await assert.rejects(
      () => writePlan(listOnly, store),
      (err) => err.code === WRITE_CODE.INCOMPLETE_EASYORDERS,
    );
    assert.equal(snapshotStore(store), before);
  });

  it("12-13. preserves products.id and updates product_type in place", async () => {
    const products = [
      product({
        id: "p-shop-var",
        product_type: "simple",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "200",
        sku: "TS-B-M",
        raw_data: {
          provider: "shopify",
          variants: [
            shopifyVariant("1", {
              title: "Black / M",
              sku: "TS-B-M",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
            }),
            shopifyVariant("2", {
              title: "Black / L",
              sku: "TS-B-L",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "L" },
              ],
            }),
          ],
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plan = planCatalogBackfill({ products, integrations }).plans[0];
    const store = seedStore(products, integrations);
    store.products[0].easyorder_id = "200";
    store.products[0].source_integration_id = SHOPIFY_A;
    store.products[0].sku = "TS-B-M";
    const { result } = await writePlan(plan, store);
    assert.equal(result.product_id, "p-shop-var");
    assert.equal(store.products.length, 1);
    assert.equal(store.products[0].id, "p-shop-var");
    assert.equal(store.products[0].product_type, "variable");
    assert.equal(store.products[0].easyorder_id, "200");
    assert.equal(store.products[0].source_integration_id, SHOPIFY_A);
    assert.equal(store.products[0].sku, "TS-B-M");
    assert.equal(result.product_type_updated, true);
  });

  it("14-16. variant CREATE then REUSE/UPDATE without duplicating", async () => {
    const products = [
      product({
        id: "p-salla-simple",
        source_integration_id: SALLA_A,
        easyorder_id: "632910392",
        sku: "SERUM-30",
        raw_data: {
          provider: "salla",
          variants: [
            {
              id: "99001",
              sku: "SERUM-30",
              price: "100",
              salla: { sku_id: "99001", barcode: "1234567890123", is_default: true },
            },
          ],
        },
      }),
    ];
    const integrations = [integration(SALLA_A, "salla")];
    const firstPlan = planCatalogBackfill({ products, integrations }).plans[0];
    const store = seedStore(products, integrations);
    const first = await writePlan(firstPlan, store);
    assert.equal(first.result.created.variants, 1);
    const variantId = store.product_variants[0].id;
    const reusePlan = planCatalogBackfill({
      products,
      integrations,
      existing: existingFromStore(store),
    }).plans[0];
    assert.equal(reusePlan.variants[0].action, ACTION.REUSE);
    const reuse = await writePlan(reusePlan, store);
    assert.equal(reuse.result.reused.variants, 1);
    assert.equal(store.product_variants.length, 1);
    assert.equal(store.product_variants[0].id, variantId);

    products[0].raw_data.variants[0].price = "125";
    const updatePlan = planCatalogBackfill({
      products,
      integrations,
      existing: existingFromStore(store),
    }).plans[0];
    assert.equal(updatePlan.variants[0].action, ACTION.UPDATE);
    const updated = await writePlan(updatePlan, store);
    assert.equal(updated.result.updated.variants, 1);
    assert.equal(store.product_variants.length, 1);
    assert.equal(store.product_variants[0].id, variantId);
    assert.equal(store.product_variants[0].price, 125);
  });

  it("17. switching default clears the previous default in the same transaction", async () => {
    const products = [
      product({
        id: "p-salla-var",
        source_integration_id: SALLA_A,
        easyorder_id: "77",
        sku: "SHIRT-BLK-M",
        raw_data: {
          provider: "salla",
          variants: [
            {
              id: "sku-1",
              sku: "SHIRT-BLK-M",
              price: "50",
              selected_options: [{ name: "Color", value: "Black" }],
              salla: { sku_id: "sku-1", is_default: true },
            },
            {
              id: "sku-2",
              sku: "SHIRT-WHT",
              price: "50",
              selected_options: [{ name: "Color", value: "White" }],
              salla: { sku_id: "sku-2", is_default: false },
            },
          ],
        },
      }),
    ];
    const integrations = [integration(SALLA_A, "salla")];
    const store = seedStore(products, integrations);
    await writePlan(planCatalogBackfill({ products, integrations }).plans[0], store);
    const firstDefault = defaultsFor(store, "p-salla-var")[0];
    products[0].raw_data.variants[0].salla.is_default = false;
    products[0].raw_data.variants[1].salla.is_default = true;
    const switched = planCatalogBackfill({
      products,
      integrations,
      existing: existingFromStore(store),
    }).plans[0];
    await writePlan(switched, store);
    const defaults = defaultsFor(store, "p-salla-var");
    assert.equal(defaults.length, 1);
    assert.notEqual(defaults[0].id, firstDefault.id);
    assert.equal(store.product_variants.length, 2);
  });

  it("18-19. planner-null duplicate SKU and barcode are persisted as NULL", async () => {
    const products = [
      product({ id: "p1", sku: "DUP", easyorder_id: "DUP-1", raw_data: { price: 1 } }),
      product({ id: "p2", sku: "DUP", easyorder_id: "DUP-2", raw_data: { price: 2 } }),
    ];
    const report = planCatalogBackfill({ products, integrations: [] });
    const store = seedStore(products);
    const batch = await writeCatalogProductPlans(report.plans, {
      companyId: COMPANY_A,
      tx: createMemoryCatalogTransaction(store),
      integrations: [],
    });
    assert.equal(batch.every((row) => row.ok), true);
    assert.equal(store.product_variants.length, 2);
    assert.equal(store.product_variants[0].internal_sku, null);
    assert.equal(store.product_variants[1].internal_sku, null);

    const barcodeProducts = [
      product({
        id: "p-b1",
        source_integration_id: SALLA_A,
        easyorder_id: "b1",
        sku: "SKU-1",
        raw_data: {
          variants: [
            { id: "v1", sku: "SKU-1", price: "1", salla: { sku_id: "v1", barcode: "SAME-BC" } },
          ],
        },
      }),
      product({
        id: "p-b2",
        source_integration_id: SALLA_A,
        easyorder_id: "b2",
        sku: "SKU-2",
        raw_data: {
          variants: [
            { id: "v2", sku: "SKU-2", price: "2", salla: { sku_id: "v2", barcode: "SAME-BC" } },
          ],
        },
      }),
    ];
    const barcodeIntegrations = [integration(SALLA_A, "salla")];
    const barcodeReport = planCatalogBackfill({
      products: barcodeProducts,
      integrations: barcodeIntegrations,
    });
    const barcodeStore = seedStore(barcodeProducts, barcodeIntegrations);
    await writeCatalogProductPlans(barcodeReport.plans, {
      companyId: COMPANY_A,
      tx: createMemoryCatalogTransaction(barcodeStore),
      integrations: barcodeIntegrations,
    });
    assert.equal(barcodeStore.product_variants.every((row) => row.barcode == null), true);
  });

  it("20-22. option/value create then reuse, and variant-option links stay unique", async () => {
    const products = [
      product({
        id: "p-salla-var",
        source_integration_id: SALLA_A,
        easyorder_id: "77",
        sku: "SHIRT-BLK-M",
        raw_data: {
          provider: "salla",
          variants: [
            {
              id: "sku-1",
              sku: "SHIRT-BLK-M",
              price: "50",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
              salla: { sku_id: "sku-1", is_default: true },
            },
          ],
        },
      }),
    ];
    const integrations = [integration(SALLA_A, "salla")];
    const store = seedStore(products, integrations);
    const first = await writePlan(
      planCatalogBackfill({ products, integrations }).plans[0],
      store,
    );
    assert.equal(first.result.created.options, 2);
    assert.equal(first.result.created.option_values, 2);
    assert.equal(first.result.created.variant_option_values, 2);
    const second = await writePlan(
      planCatalogBackfill({
        products,
        integrations,
        existing: existingFromStore(store),
      }).plans[0],
      store,
    );
    assert.equal(second.result.reused.options, 2);
    assert.equal(second.result.reused.option_values, 2);
    assert.equal(store.product_options.length, 2);
    assert.equal(store.product_option_values.length, 2);
    assert.equal(store.variant_option_values.length, 2);
  });

  it("23-27. source mapping create/reuse/conflict and exact integration UUID", async () => {
    const products = [
      product({
        id: "p-shop-simple",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "100",
        sku: "SH-1",
        raw_data: {
          provider: "shopify",
          variants: [shopifyVariant("1231")],
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const store = seedStore(products, integrations);
    const created = await writePlan(
      planCatalogBackfill({ products, integrations }).plans[0],
      store,
    );
    assert.equal(created.result.created.source_mappings, 1);
    assert.equal(store.catalog_source_mappings[0].integration_id, SHOPIFY_A);
    const mappingId = store.catalog_source_mappings[0].id;
    const reused = await writePlan(
      planCatalogBackfill({
        products,
        integrations,
        existing: existingFromStore(store),
      }).plans[0],
      store,
    );
    assert.equal(reused.result.reused.source_mappings, 1);
    assert.equal(store.catalog_source_mappings.length, 1);
    assert.equal(store.catalog_source_mappings[0].id, mappingId);

    const reuseMissing = planCatalogBackfill({ products, integrations }).plans[0];
    reuseMissing.source_mappings[0].action = ACTION.REUSE;
    reuseMissing.source_mappings[0].existing_mapping_id = "missing-map";
    const missingStore = seedStore(products, integrations);
    const beforeMissing = snapshotStore(missingStore);
    await assert.rejects(
      () => writePlan(reuseMissing, missingStore),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(snapshotStore(missingStore), beforeMissing);

    const conflictStore = seedStore(products, integrations);
    conflictStore.product_variants.push({
      id: "existing-other-variant",
      company_id: COMPANY_A,
      product_id: "p-shop-simple",
      is_default: true,
      internal_sku: "OTHER",
    });
    conflictStore.catalog_source_mappings.push({
      id: "map-other",
      company_id: COMPANY_A,
      integration_id: SHOPIFY_A,
      external_product_id: "100",
      external_variant_id: "1231",
      internal_product_id: "p-shop-simple",
      internal_variant_id: "existing-other-variant",
    });
    const beforeConflict = snapshotStore(conflictStore);
    await assert.rejects(
      () => writePlan(planCatalogBackfill({ products, integrations }).plans[0], conflictStore),
      (err) => err.code === WRITE_CODE.CONFLICT,
    );
    assert.equal(snapshotStore(conflictStore), beforeConflict);

    const two = [
      product({
        id: "p-a",
        source_integration_id: EASY_A,
        easyorder_id: "shared-ext",
        sku: "EO-1",
      }),
      product({
        id: "p-b",
        source_integration_id: EASY_B,
        easyorder_id: "shared-ext",
        sku: "EO-B",
      }),
    ];
    const twoIntegrations = [
      integration(EASY_A, "easyorders"),
      integration(EASY_B, "easyorders"),
    ];
    const twoPlans = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: twoIntegrations,
      products: two,
      snapshots: [
        snapshotEntry(
          completeSimpleSnapshot({
            externalProductId: "shared-ext",
            sku: "EO-1",
            variantId: "same-v",
          }),
          { source_integration_id: EASY_A },
        ),
        snapshotEntry(
          completeSimpleSnapshot({
            externalProductId: "shared-ext",
            sku: "EO-B",
            variantId: "same-v",
          }),
          { source_integration_id: EASY_B },
        ),
      ],
    }).plans;
    const twoStore = seedStore(two, twoIntegrations);
    await writeCatalogProductPlans(twoPlans, {
      companyId: COMPANY_A,
      tx: createMemoryCatalogTransaction(twoStore),
      integrations: twoIntegrations,
    });
    assert.equal(twoStore.catalog_source_mappings.length, 2);
    assert.equal(
      new Set(twoStore.catalog_source_mappings.map((row) => row.integration_id)).size,
      2,
    );
    assert.equal(
      twoStore.catalog_source_mappings.every((row) => row.external_variant_id === "same-v"),
      true,
    );
  });

  it("28. tenant mismatch is refused before write", async () => {
    const products = [product()];
    const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
    const store = seedStore(products);
    const before = snapshotStore(store);
    await assert.rejects(
      () => writePlan(plan, store, { companyId: COMPANY_B }),
      (err) => err.code === WRITE_CODE.TENANT_MISMATCH,
    );
    store.products[0].company_id = COMPANY_B;
    const owned = planCatalogBackfill({
      products: [{ ...products[0], company_id: COMPANY_A }],
      integrations: [],
    }).plans[0];
    await assert.rejects(
      () => writePlan(owned, store),
      (err) => err.code === WRITE_CODE.TENANT_MISMATCH,
    );
    assert.equal(store.product_variants.length, 0);
    assert.equal(JSON.parse(before).product_variants.length, 0);
  });

  it("29. failure inside a product transaction rolls back that product only", async () => {
    const products = [
      product({ id: "p-ok", sku: "OK", easyorder_id: "OK", raw_data: { price: 9 } }),
      product({
        id: "p-shop-var",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "200",
        sku: "TS-B-M",
        raw_data: {
          provider: "shopify",
          variants: [
            shopifyVariant("1", {
              title: "Black / M",
              sku: "TS-B-M",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
            }),
          ],
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const plans = planCatalogBackfill({ products, integrations }).plans;
    const store = seedStore(products, integrations);
    const tx = createMemoryCatalogTransaction(store);
    const first = await writeCatalogProductPlan(plans[0], {
      companyId: COMPANY_A,
      tx,
      integrations,
    });
    assert.equal(first.created.variants, 1);
    tx.failOn({ table: "product_options", action: "insert" });
    await assert.rejects(
      () =>
        writeCatalogProductPlan(plans[1], {
          companyId: COMPANY_A,
          tx,
          integrations,
        }),
      (err) => err.code === WRITE_CODE.FAILED,
    );
    assert.equal(store.products.find((row) => row.id === "p-ok").product_type, "simple");
    assert.equal(store.product_variants.filter((row) => row.product_id === "p-ok").length, 1);
    assert.equal(store.product_variants.filter((row) => row.product_id === "p-shop-var").length, 0);
    assert.equal(store.product_options.length, 0);
    assert.equal(tx.stats.rollbacks >= 1, true);

    const cases = [
      { table: "product_variants", action: "insert" },
      { table: "product_option_values", action: "insert" },
      { table: "variant_option_values", action: "insert" },
      { table: "catalog_source_mappings", action: "insert" },
    ];
    for (const failOn of cases) {
      const isolated = seedStore([products[1]], integrations);
      const isolatedTx = createMemoryCatalogTransaction(isolated);
      isolatedTx.failOn(failOn);
      await assert.rejects(
        () =>
          writeCatalogProductPlan(plans[1], {
            companyId: COMPANY_A,
            tx: isolatedTx,
            integrations,
          }),
        (err) => err.code === WRITE_CODE.FAILED,
      );
      assert.equal(isolated.product_variants.length, 0);
      assert.equal(isolated.product_options.length, 0);
      assert.equal(isolated.product_option_values.length, 0);
      assert.equal(isolated.variant_option_values.length, 0);
      assert.equal(isolated.catalog_source_mappings.length, 0);
      assert.equal(isolated.products[0].product_type, "simple");
    }
  });

  it("30. second execution with the same reviewed plan is idempotent", async () => {
    const products = [
      product({
        id: "p-shop-var",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "200",
        sku: "TS-B-M",
        raw_data: {
          provider: "shopify",
          variants: [
            shopifyVariant("1", {
              title: "Black / M",
              sku: "TS-B-M",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "M" },
              ],
            }),
            shopifyVariant("2", {
              title: "Black / L",
              sku: "TS-B-L",
              selected_options: [
                { name: "Color", value: "Black" },
                { name: "Size", value: "L" },
              ],
            }),
          ],
        },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const store = seedStore(products, integrations);
    await writePlan(planCatalogBackfill({ products, integrations }).plans[0], store);
    const afterFirst = snapshotStore(store);
    await writePlan(
      planCatalogBackfill({
        products,
        integrations,
        existing: existingFromStore(store),
      }).plans[0],
      store,
    );
    assert.equal(store.product_variants.length, 2);
    assert.equal(store.product_options.length, 2);
    assert.equal(store.product_option_values.length, 3);
    assert.equal(store.catalog_source_mappings.length, 1 * 2);
    assert.equal(defaultsFor(store, "p-shop-var").length, 1);
    assert.equal(JSON.parse(afterFirst).product_variants.length, store.product_variants.length);
  });

  it("31-35. no provider/raw_data reinterpretation, no deletes, no live REST tx, CLI commit still disabled", async () => {
    const originalGet = axios.get;
    const originalPost = axios.post;
    let httpCalls = 0;
    axios.get = async (...args) => {
      httpCalls += 1;
      return originalGet(...args);
    };
    axios.post = async (...args) => {
      httpCalls += 1;
      return originalPost(...args);
    };
    try {
      const products = [product()];
      const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
      plan.variants[0].raw_data = {
        leftover_only: true,
        nested_variants: [{ id: "should-not-become-a-row" }],
      };
      const store = seedStore(products);
      store.product_variants.push({
        id: "stale-extra",
        company_id: COMPANY_A,
        product_id: "prod-1",
        is_default: false,
        internal_sku: "STALE",
      });
      const { tx } = await writePlan(plan, store);
      assert.equal(httpCalls, 0);
      assert.equal(store.product_variants.length, 2);
      assert.ok(store.product_variants.some((row) => row.id === "stale-extra"));
      assert.equal(
        store.product_variants.find((row) => row.id !== "stale-extra").raw_data.leftover_only,
        true,
      );
      assert.equal(tx.stats.deletes, 0);
    } finally {
      axios.get = originalGet;
      axios.post = originalPost;
    }

    assert.throws(
      () => createSupabaseRestCatalogTransaction(),
      (err) => err.code === WRITE_CODE.TRANSACTION_UNAVAILABLE,
    );
    const products = [product()];
    const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
    await assert.rejects(
      () => writeCatalogProductPlan(plan, { companyId: COMPANY_A, tx: null }),
      (err) => err.code === WRITE_CODE.TRANSACTION_UNAVAILABLE,
    );

    const writerSrc = fs.readFileSync(
      path.join(BACKEND_ROOT, "src/services/catalogWriter.service.js"),
      "utf8",
    );
    assert.doesNotMatch(writerSrc, /require\(["'][^"']*supabase/);
    assert.doesNotMatch(writerSrc, /require\(["'][^"']*easyorder/);
    assert.doesNotMatch(writerSrc, /require\(["'][^"']*shopify/);
    assert.doesNotMatch(writerSrc, /require\(["'][^"']*salla/);
    assert.doesNotMatch(writerSrc, /require\(["']axios["']\)/);
    assert.doesNotMatch(writerSrc, /parseRawData/);

    const cliSrc = fs.readFileSync(path.join(BACKEND_ROOT, "scripts/catalog-backfill.js"), "utf8");
    assert.doesNotMatch(cliSrc, /catalogWriter/);
    const commit = parseCatalogBackfillCliArgs(["--commit"]);
    assert.equal(commit.commit, true);
    assert.match(COMMIT_DISABLED_MESSAGE, /disabled/i);
    assert.match(cliSrc, /COMMIT_DISABLED_MESSAGE/);

    const dualWriteFiles = [
      "src/services/products.service.js",
      "src/services/sallaProducts.service.js",
      "src/services/easyorder.service.js",
    ];
    for (const relative of dualWriteFiles) {
      const src = fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
      assert.doesNotMatch(src, /catalogWriter/);
      assert.doesNotMatch(src, /writeCatalogProductPlan\(/);
      assert.doesNotMatch(src, /writeShopifyCatalogDualWrite\(/);
    }
    const shopifySrc = fs.readFileSync(
      path.join(BACKEND_ROOT, "src/services/shopifyProducts.service.js"),
      "utf8",
    );
    assert.match(shopifySrc, /writeShopifyCatalogDualWrite\(/);
    assert.doesNotMatch(shopifySrc, /apply_catalog_product_plan/);

    const migration = fs.readFileSync(
      path.join(BACKEND_ROOT, "supabase/migrations/013_catalog_foundation.sql"),
      "utf8",
    );
    assert.match(migration, /013_catalog_foundation/);
    assert.equal(fs.existsSync(path.join(BACKEND_ROOT, "supabase/migrations/014_catalog_writer.sql")), false);
  });

  it("does not coerce invalid planner prices to 0", async () => {
    const products = [product({ raw_data: { sku: "LOCAL-SKU", price: "nope" } })];
    const plan = planCatalogBackfill({ products, integrations: [] }).plans[0];
    assert.equal(plan.variants[0].price, null);
    const store = seedStore(products);
    await writePlan(plan, store);
    assert.equal(store.product_variants[0].price, null);
  });
});

describe("C1G INTEGRATION_IN_USE catalog mapping precheck", () => {
  let fake;

  beforeEach(() => {
    fake = createFakeSupabase({
      companies: [{ id: COMPANY_A, name: "A", slug: "a", is_active: true }],
      company_integrations: [
        {
          id: SHOPIFY_A,
          company_id: COMPANY_A,
          provider: "shopify",
          category: "commerce",
          name: "Shopify",
          is_enabled: true,
        },
      ],
    });
    supabase.__setClientForTests(fake);
  });

  afterEach(() => {
    supabase.__setClientForTests(null);
  });

  it("blocks delete when catalog_source_mappings, fulfillment mappings, or order_items reference the integration", async () => {
    fake.__db.catalog_source_mappings.push({
      id: "csm-1",
      company_id: COMPANY_A,
      integration_id: SHOPIFY_A,
      external_product_id: "100",
      external_variant_id: "1",
    });
    await assert.rejects(
      () => deleteConnection(COMPANY_A, SHOPIFY_A),
      (err) => err.code === "INTEGRATION_IN_USE",
    );

    fake.__db.catalog_source_mappings.length = 0;
    fake.__db.fulfillment_item_mappings.push({
      id: "fim-1",
      company_id: COMPANY_A,
      shipping_integration_id: SHOPIFY_A,
    });
    await assert.rejects(
      () => deleteConnection(COMPANY_A, SHOPIFY_A),
      (err) => err.code === "INTEGRATION_IN_USE",
    );

    fake.__db.fulfillment_item_mappings.length = 0;
    fake.__db.order_items.push({
      id: "oi-1",
      company_id: COMPANY_A,
      source_integration_id: SHOPIFY_A,
    });
    await assert.rejects(
      () => deleteConnection(COMPANY_A, SHOPIFY_A),
      (err) => err.code === "INTEGRATION_IN_USE",
    );
  });
});

describe("C1G eligibility helper", () => {
  it("refuses missing transaction adapter and never infers bundle", () => {
    const plan = {
      company_id: COMPANY_A,
      product_id: "p1",
      provider: "manual",
      status: STATUS.READY,
      planned_product_type: "bundle",
      diagnostics: [],
      variants: [{ action: ACTION.CREATE, company_id: COMPANY_A, product_id: "p1", variant_key: "k" }],
      options: [],
      option_values: [],
      source_mappings: [],
    };
    assert.throws(
      () => assertWriteEligible(plan, { companyId: COMPANY_A }),
      (err) => err.code === WRITE_CODE.INVALID_PLAN,
    );
  });
});
