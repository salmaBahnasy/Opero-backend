process.env.NODE_ENV = "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const {
  STATUS,
  ACTION,
  planCatalogBackfill,
} = require("../src/services/catalogBackfill.service");
const {
  toCatalogPlanningProduct,
  planCatalogBackfillFromEasyOrdersSnapshots,
} = require("../src/services/catalogPlanning.adapter");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SHOPIFY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SALLA_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EASY_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EASY_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function integration(id, provider, companyId = COMPANY_A) {
  return { id, company_id: companyId, provider, category: "commerce", is_enabled: true };
}

function legacyEasy(overrides = {}) {
  return {
    id: "prod-eo-1",
    company_id: COMPANY_A,
    source_integration_id: EASY_A,
    easyorder_id: "eo-1",
    sku: "EO-1",
    raw_data: { id: "eo-1", name: "Cream", sku: "EO-1", price: 15 },
    ...overrides,
  };
}

function snapshotEntry(snapshot, extra = {}) {
  return {
    company_id: extra.company_id || COMPANY_A,
    source_integration_id: extra.source_integration_id || EASY_A,
    snapshot,
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
        quantity: 3,
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

function codes(plan) {
  return (plan.diagnostics || []).map((item) => item.code);
}

function shopifyVariant(id, extra = {}) {
  return {
    id: String(id),
    sku: extra.sku ?? "SH-1",
    price: extra.price ?? "10.00",
    selected_options: extra.selected_options ?? [
      { name: "Title", value: "Default Title" },
    ],
  };
}

describe("C1F EasyOrders enriched snapshot → catalog planner", () => {
  it("1-3. complete enriched simple keeps real variant id and never blanks it", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy()],
      snapshots: [snapshotEntry(completeSimpleSnapshot())],
    });
    const plan = report.plans[0];
    assert.equal(plan.product_id, "prod-eo-1");
    assert.equal(plan.status, STATUS.READY);
    assert.equal(plan.planned_product_type, "simple");
    assert.equal(plan.variants.length, 1);
    assert.equal(plan.variants[0].external_variant_id, "eo-v-simple");
    assert.equal(plan.source_mappings[0].external_variant_id, "eo-v-simple");
    assert.notEqual(plan.source_mappings[0].external_variant_id, "");
    assert.ok(!codes(plan).includes("EASYORDERS_VARIANTS_NOT_STORED"));
    assert.ok(!codes(plan).includes("EASYORDERS_VARIANTS_INCOMPLETE"));
  });

  it("4-5. complete variable EasyOrders plans 4 variants and 2 option dimensions", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [
        legacyEasy({
          id: "prod-shirt",
          easyorder_id: "eo-shirt",
          sku: "TS-B-M",
          raw_data: { id: "eo-shirt", name: "T-Shirt" },
        }),
      ],
      snapshots: [snapshotEntry(completeVariableSnapshot())],
    });
    const plan = report.plans[0];
    assert.equal(plan.planned_product_type, "variable");
    assert.equal(plan.variants.length, 4);
    assert.equal(plan.options.length, 2);
    assert.equal(plan.option_values.length, 4);
    assert.equal(plan.source_mappings.length, 4);
    assert.deepEqual(
      plan.variants.map((row) => row.external_variant_id),
      ["v1", "v2", "v3", "v4"],
    );
    assert.deepEqual(
      plan.options.map((row) => row.name).sort(),
      ["Color", "Size"],
    );
  });

  it("6. Arabic option name/value preservation", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy({ easyorder_id: "eo-ar", sku: "AR-1" })],
      snapshots: [
        snapshotEntry(
          completeSimpleSnapshot({
            externalProductId: "eo-ar",
            sku: "AR-1",
            variantId: "ar-v1",
            options: [{ name: "لون", value: "أسود" }],
          }),
        ),
      ],
    });
    const plan = report.plans[0];
    assert.equal(plan.options[0].name, "لون");
    assert.equal(plan.option_values[0].value, "أسود");
    assert.equal(plan.planned_product_type, "variable");
  });

  it("7-8. incomplete/failed enrichment is BLOCKED and creates no fake default", () => {
    const incomplete = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy()],
      snapshots: [
        snapshotEntry({
          externalProductId: "eo-1",
          title: "Cream",
          variantsComplete: false,
          incomplete: true,
          variants: [],
        }),
      ],
    });
    const plan = incomplete.plans[0];
    assert.equal(plan.status, STATUS.BLOCKED);
    assert.equal(plan.planned_product_type, null);
    assert.equal(plan.variants.length, 0);
    assert.equal(plan.source_mappings.length, 0);
    assert.ok(codes(plan).includes("EASYORDERS_VARIANTS_INCOMPLETE"));
    assert.ok(!codes(plan).includes("EASYORDERS_VARIANTS_NOT_STORED"));
    assert.ok(!plan.variants.some((row) => row.external_variant_id === ""));
  });

  it("9. missing variant id → BLOCKED", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy()],
      snapshots: [
        snapshotEntry({
          externalProductId: "eo-1",
          variantsComplete: true,
          incomplete: false,
          variants: [{ externalVariantId: "", sku: "EO-1", price: 10, options: [] }],
        }),
      ],
    });
    assert.equal(report.plans[0].status, STATUS.BLOCKED);
    assert.equal(report.plans[0].variants.length, 0);
    assert.ok(codes(report.plans[0]).includes("EASYORDERS_VARIANTS_INCOMPLETE"));
  });

  it("10-11. duplicate SKU nulls internal_sku and does not merge products", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [
        legacyEasy({ id: "p1", easyorder_id: "eo-a", sku: "DUP" }),
        legacyEasy({ id: "p2", easyorder_id: "eo-b", sku: "DUP" }),
      ],
      snapshots: [
        snapshotEntry(
          completeSimpleSnapshot({
            externalProductId: "eo-a",
            sku: "DUP",
            variantId: "va",
          }),
        ),
        snapshotEntry(
          completeSimpleSnapshot({
            externalProductId: "eo-b",
            sku: "DUP",
            variantId: "vb",
          }),
        ),
      ],
    });
    assert.equal(report.plans.length, 2);
    assert.equal(report.plans[0].product_id, "p1");
    assert.equal(report.plans[1].product_id, "p2");
    assert.equal(report.plans[0].variants[0].internal_sku, null);
    assert.equal(report.plans[1].variants[0].internal_sku, null);
    assert.equal(report.plans[0].source_mappings[0].external_sku, "DUP");
    assert.equal(report.plans[1].source_mappings[0].external_sku, "DUP");
    assert.ok(codes(report.plans[0]).includes("DUPLICATE_INTERNAL_SKU"));
  });

  it("12. same SKU across two provider products remains separate", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [
        integration(EASY_A, "easyorders"),
        integration(SHOPIFY_A, "shopify"),
      ],
      products: [
        legacyEasy({ id: "p-eo", sku: "SHARED" }),
        {
          id: "p-sh",
          company_id: COMPANY_A,
          source_integration_id: SHOPIFY_A,
          easyorder_id: "100",
          sku: "SHARED",
          raw_data: {
            variants: [shopifyVariant("1001", { sku: "SHARED" })],
            shopify: { product_id: "100", variants_complete: true },
          },
        },
      ],
      snapshots: [
        snapshotEntry(
          completeSimpleSnapshot({ sku: "SHARED", variantId: "eo-shared" }),
        ),
      ],
    });
    assert.equal(report.plans[0].product_id, "p-eo");
    assert.equal(report.plans[1].product_id, "p-sh");
    assert.equal(report.plans[0].variants[0].internal_sku, null);
    assert.equal(report.plans[1].variants[0].internal_sku, null);
    assert.equal(report.plans[0].source_mappings[0].external_variant_id, "eo-shared");
    assert.equal(report.plans[1].source_mappings[0].external_variant_id, "1001");
  });

  it("13. exact source integration mapping", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy()],
      snapshots: [snapshotEntry(completeSimpleSnapshot())],
    });
    const mapping = report.plans[0].source_mappings[0];
    assert.equal(mapping.integration_id, EASY_A);
    assert.equal(mapping.external_product_id, "eo-1");
    assert.equal(mapping.external_variant_id, "eo-v-simple");
    assert.equal(mapping.internal_product_id, "prod-eo-1");
    assert.equal(mapping.company_id, COMPANY_A);
  });

  it("14. same external IDs on two integrations remain legal", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [
        integration(EASY_A, "easyorders"),
        integration(EASY_B, "easyorders"),
      ],
      products: [
        legacyEasy({ id: "p-a", source_integration_id: EASY_A, easyorder_id: "shared-ext" }),
        legacyEasy({
          id: "p-b",
          source_integration_id: EASY_B,
          easyorder_id: "shared-ext",
          sku: "EO-B",
        }),
      ],
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
    });
    assert.equal(report.plans[0].status, STATUS.READY);
    assert.equal(report.plans[1].status, STATUS.READY);
    assert.equal(report.plans[0].source_mappings[0].integration_id, EASY_A);
    assert.equal(report.plans[1].source_mappings[0].integration_id, EASY_B);
    assert.equal(report.plans[0].product_id, "p-a");
    assert.equal(report.plans[1].product_id, "p-b");
  });

  it("15. wrong-company integration → blocked", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders", COMPANY_B)],
      products: [legacyEasy()],
      snapshots: [snapshotEntry(completeSimpleSnapshot())],
    });
    assert.equal(report.plans[0].status, STATUS.BLOCKED);
    assert.ok(codes(report.plans[0]).includes("ORPHAN_SOURCE_INTEGRATION"));
  });

  it("16. stable deterministic second planning pass", () => {
    const input = {
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy()],
      snapshots: [snapshotEntry(completeSimpleSnapshot())],
      existing: {
        variants: [
          {
            id: "var-existing",
            company_id: COMPANY_A,
            product_id: "prod-eo-1",
            title: null,
            internal_sku: "EO-1",
            barcode: null,
            price: 15,
            compare_at_price: null,
            is_default: true,
            is_active: true,
            position: 0,
          },
        ],
        sourceMappings: [
          {
            id: "map-1",
            company_id: COMPANY_A,
            integration_id: EASY_A,
            external_product_id: "eo-1",
            external_variant_id: "eo-v-simple",
            internal_product_id: "prod-eo-1",
            internal_variant_id: "var-existing",
            external_sku: "EO-1",
          },
        ],
      },
    };
    const first = planCatalogBackfillFromEasyOrdersSnapshots(input);
    const second = planCatalogBackfillFromEasyOrdersSnapshots(input);
    assert.equal(first.plans[0].variants[0].variant_key, second.plans[0].variants[0].variant_key);
    assert.equal(first.plans[0].variants[0].action, ACTION.REUSE);
    assert.equal(second.plans[0].variants[0].action, ACTION.REUSE);
    assert.equal(first.plans[0].variants[0].existing_variant_id, "var-existing");
  });

  it("17-18. planner makes zero HTTP calls and zero DB writes", () => {
    let httpCalls = 0;
    const originalGet = axios.get;
    axios.get = async () => {
      httpCalls += 1;
      throw new Error("HTTP must not run");
    };
    try {
      const adapterSrc = fs.readFileSync(
        path.resolve(__dirname, "../src/services/catalogPlanning.adapter.js"),
        "utf8",
      );
      const plannerSrc = fs.readFileSync(
        path.resolve(__dirname, "../src/services/catalogBackfill.service.js"),
        "utf8",
      );
      assert.doesNotMatch(adapterSrc, /supabase|axios/);
      assert.doesNotMatch(plannerSrc, /\.from\(["']product_variants["']\)/);
      const report = planCatalogBackfillFromEasyOrdersSnapshots({
        integrations: [integration(EASY_A, "easyorders")],
        products: [legacyEasy()],
        snapshots: [snapshotEntry(completeSimpleSnapshot())],
      });
      assert.equal(httpCalls, 0);
      assert.equal(report.commit_enabled, false);
    } finally {
      axios.get = originalGet;
    }
  });

  it("19. legacy DB-only EasyOrders behavior still works", () => {
    const report = planCatalogBackfill({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy()],
    });
    assert.equal(report.plans[0].status, STATUS.READY_WITH_WARNINGS);
    assert.ok(codes(report.plans[0]).includes("EASYORDERS_VARIANTS_NOT_STORED"));
    assert.equal(report.plans[0].source_mappings[0].external_variant_id, "");
  });

  it("20. Shopify behavior unchanged", () => {
    const row = {
      id: "p-sh",
      company_id: COMPANY_A,
      source_integration_id: SHOPIFY_A,
      easyorder_id: "100",
      sku: "SH-1",
      raw_data: {
        variants: [shopifyVariant("1231")],
        shopify: { product_id: "100", variants_complete: true },
      },
    };
    const direct = planCatalogBackfill({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [row],
    });
    const adapted = planCatalogBackfill({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [toCatalogPlanningProduct(row)],
    });
    assert.equal(direct.plans[0].variants[0].external_variant_id, "1231");
    assert.equal(adapted.plans[0].variants[0].external_variant_id, "1231");
    assert.equal(direct.plans[0].planned_product_type, "simple");
    assert.equal(adapted.plans[0].planned_product_type, "simple");
  });

  it("21. Salla behavior unchanged", () => {
    const row = {
      id: "p-sa",
      company_id: COMPANY_A,
      source_integration_id: SALLA_A,
      easyorder_id: "55",
      sku: "SA-1",
      raw_data: {
        variants: [
          {
            id: "99001",
            sku: "SA-1",
            price: 20,
            salla: { sku_id: "99001", is_default: true, barcode: "123" },
            selected_options: [],
          },
        ],
      },
    };
    const direct = planCatalogBackfill({
      integrations: [integration(SALLA_A, "salla")],
      products: [row],
    });
    assert.equal(direct.plans[0].variants[0].external_variant_id, "99001");
    assert.equal(direct.plans[0].planned_product_type, "simple");
  });

  it("22. manual product behavior unchanged", () => {
    const row = {
      id: "prod-1",
      company_id: COMPANY_A,
      source_integration_id: null,
      easyorder_id: "LOCAL-SKU",
      sku: "LOCAL-SKU",
      raw_data: { name: "Pillow", sku: "LOCAL-SKU", price: 120 },
    };
    const report = planCatalogBackfill({ products: [row], integrations: [] });
    assert.equal(report.plans[0].provider, "manual");
    assert.equal(report.plans[0].source_mappings.length, 0);
    assert.equal(report.plans[0].variants[0].external_variant_id, null);
  });

  it("does not match enrichment snapshots by SKU", () => {
    const report = planCatalogBackfillFromEasyOrdersSnapshots({
      integrations: [integration(EASY_A, "easyorders")],
      products: [legacyEasy({ easyorder_id: "eo-other", sku: "EO-1" })],
      snapshots: [snapshotEntry(completeSimpleSnapshot({ sku: "EO-1" }))],
    });
    assert.ok(codes(report.plans[0]).includes("EASYORDERS_VARIANTS_NOT_STORED"));
    assert.equal(report.plans[0].source_mappings[0].external_variant_id, "");
  });
});
