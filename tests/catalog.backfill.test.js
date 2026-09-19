process.env.NODE_ENV = "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  ALLOWED_SAAS_DEV_REF,
  COMMIT_DISABLED_MESSAGE,
  STATUS,
  ACTION,
  planCatalogBackfill,
  formatCatalogBackfillSummary,
  assertSaasDevelopmentTarget,
  parseCatalogBackfillCliArgs,
  parseCatalogPrice,
} = require("../src/services/catalogBackfill.service");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SHOPIFY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHOPIFY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SALLA_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EASY_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORPHAN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function integration(id, provider, companyId = COMPANY_A) {
  return { id, company_id: companyId, provider, category: "commerce", is_enabled: true };
}

function product(overrides = {}) {
  return {
    id: "prod-1",
    company_id: COMPANY_A,
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
    variation_props: extra.variation_props,
    gid: `gid://shopify/ProductVariant/${id}`,
    shopify: { variant_id: String(id) },
    ...extra,
  };
}

function codes(plan) {
  return (plan.diagnostics || []).map((item) => item.code);
}

function planFor(input) {
  return planCatalogBackfill(input);
}

function firstProduct(report) {
  return report.plans[0];
}

describe("catalog backfill planner", () => {
  it("1. plans a manual simple product with default variant and no mapping", () => {
    const report = planFor({
      products: [product()],
      integrations: [],
    });
    const plan = firstProduct(report);
    assert.equal(plan.provider, "manual");
    assert.equal(plan.status, STATUS.READY);
    assert.equal(plan.planned_product_type, "simple");
    assert.equal(plan.variants.length, 1);
    assert.equal(plan.variants[0].is_default, true);
    assert.equal(plan.variants[0].title, null);
    assert.equal(plan.variants[0].position, 0);
    assert.equal(plan.variants[0].internal_sku, "LOCAL-SKU");
    assert.equal(plan.variants[0].price, 120);
    assert.equal(plan.source_mappings.length, 0);
    assert.equal(report.counts.variants_create, 1);
    assert.equal(report.counts.source_mappings_create, 0);
  });

  it("2. simple Shopify Default Title keeps the real numeric variant id", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
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
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.provider, "shopify");
    assert.equal(plan.planned_product_type, "simple");
    assert.equal(plan.variants[0].external_variant_id, "1231");
    assert.equal(plan.variants[0].title, null);
    assert.equal(plan.options.length, 0);
    assert.equal(plan.source_mappings.length, 1);
    assert.equal(plan.source_mappings[0].external_variant_id, "1231");
    assert.notEqual(plan.source_mappings[0].external_variant_id, "");
    assert.ok(codes(plan).includes("BARCODE_UNAVAILABLE"));
  });

  it("3. plans variable Shopify color/size variants and options", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
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
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.planned_product_type, "variable");
    assert.equal(plan.variants.length, 2);
    assert.equal(plan.options.length, 2);
    assert.deepEqual(
      plan.options.map((row) => row.name).sort(),
      ["Color", "Size"],
    );
    assert.equal(plan.option_values.length, 3);
    assert.equal(plan.source_mappings[0].external_variant_id, "1");
    assert.equal(plan.source_mappings[1].external_variant_id, "2");
    assert.equal(plan.variants[0].internal_sku, "TS-B-M");
    assert.equal(plan.variants[1].internal_sku, "TS-B-L");
  });

  it("4. truncated Shopify variants block full backfill", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-trunc",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "300",
          sku: "X",
          raw_data: {
            provider: "shopify",
            shopify: { variants_truncated: true },
            variants: [shopifyVariant("10", { sku: "X", title: "X" })],
          },
        }),
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.status, STATUS.BLOCKED);
    assert.ok(codes(plan).includes("TRUNCATED_PROVIDER_VARIANTS"));
    assert.equal(report.counts.truncated_provider_products, 1);
    assert.equal(report.counts.products_blocked, 1);
  });

  it("5. simple Salla keeps the real SKU/variant id", () => {
    const report = planFor({
      integrations: [integration(SALLA_A, "salla")],
      products: [
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
                title: "SERUM-30",
                price: "100",
                sale_price: "100",
                selected_options: [],
                salla: { sku_id: "99001", barcode: "1234567890123", is_default: true },
              },
            ],
          },
        }),
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.planned_product_type, "simple");
    assert.equal(plan.variants[0].external_variant_id, "99001");
    assert.equal(plan.source_mappings[0].external_variant_id, "99001");
    assert.notEqual(plan.source_mappings[0].external_variant_id, "");
    assert.equal(plan.variants[0].barcode, "1234567890123");
    assert.equal(plan.variants[0].is_default, true);
  });

  it("6. variable Salla builds options from selected_options", () => {
    const report = planFor({
      integrations: [integration(SALLA_A, "salla")],
      products: [
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
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.planned_product_type, "variable");
    assert.equal(plan.variants.length, 2);
    assert.equal(plan.variants[0].is_default, true);
    assert.ok(plan.options.some((row) => row.name === "Color"));
    assert.ok(plan.options.some((row) => row.name === "Size"));
    assert.equal(plan.option_values.length, 4);
  });

  it("7. preserves Arabic option names and values exactly", () => {
    const report = planFor({
      integrations: [integration(SALLA_A, "salla")],
      products: [
        product({
          id: "p-ar",
          source_integration_id: SALLA_A,
          easyorder_id: "ar-1",
          sku: "AR-1",
          raw_data: {
            provider: "salla",
            variants: [
              {
                id: "v-ar",
                sku: "AR-1",
                price: "20",
                selected_options: [{ name: "لون", value: "أسود" }],
                salla: { sku_id: "v-ar" },
              },
            ],
          },
        }),
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.options[0].name, "لون");
    assert.equal(plan.option_values[0].value, "أسود");
  });

  it("8. EasyOrders with no stored variants warns and stays READY_WITH_WARNINGS", () => {
    const report = planFor({
      integrations: [integration(EASY_A, "easyorders")],
      products: [
        product({
          id: "p-eo-simple",
          source_integration_id: EASY_A,
          easyorder_id: "eo-9",
          sku: "EO-9",
          raw_data: { id: "eo-9", sku: "EO-9", price: 15, name: "Cream" },
        }),
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.status, STATUS.READY_WITH_WARNINGS);
    assert.ok(codes(plan).includes("EASYORDERS_VARIANTS_NOT_STORED"));
    assert.equal(plan.variants.length, 1);
    assert.equal(plan.variants[0].is_default, true);
    assert.equal(plan.source_mappings[0].external_variant_id, "");
    assert.equal(report.counts.easyorders_variants_not_stored, 1);
  });

  it("9. EasyOrders stored variants are planned from raw_data only", () => {
    const report = planFor({
      integrations: [integration(EASY_A, "easyorders")],
      products: [
        product({
          id: "p-eo-var",
          source_integration_id: EASY_A,
          easyorder_id: "eo-10",
          sku: "EO-S",
          raw_data: {
            variants: [
              {
                id: "eo-v1",
                sku: "EO-S",
                price: 10,
                variation_props: [{ variation: "مقاس", variation_prop: "S" }],
              },
              {
                id: "eo-v2",
                sku: "EO-L",
                price: 12,
                variation_props: [{ variation: "مقاس", variation_prop: "L" }],
              },
            ],
          },
        }),
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.planned_product_type, "variable");
    assert.equal(plan.variants.length, 2);
    assert.ok(!codes(plan).includes("EASYORDERS_VARIANTS_NOT_STORED"));
    assert.equal(plan.options[0].name, "مقاس");
    assert.equal(plan.source_mappings[0].external_variant_id, "eo-v1");
  });

  it("10. missing SKU leaves internal_sku null", () => {
    const report = planFor({
      products: [
        product({
          id: "p-nosku",
          sku: "",
          easyorder_id: "hash-1",
          raw_data: { price: 5 },
        }),
      ],
    });
    assert.equal(firstProduct(report).variants[0].internal_sku, null);
  });

  it("11. duplicate SKU within a company does not assign internal_sku", () => {
    const report = planFor({
      products: [
        product({ id: "p1", sku: "DUP", easyorder_id: "DUP-1", raw_data: { price: 1 } }),
        product({ id: "p2", sku: "DUP", easyorder_id: "DUP-2", raw_data: { price: 2 } }),
      ],
    });
    assert.equal(report.plans[0].variants[0].internal_sku, null);
    assert.equal(report.plans[1].variants[0].internal_sku, null);
    assert.ok(codes(report.plans[0]).includes("DUPLICATE_INTERNAL_SKU"));
    assert.equal(report.counts.duplicate_skus, 2);
    assert.equal(report.plans[0].product_id, "p1");
    assert.equal(report.plans[1].product_id, "p2");
  });

  it("12. same SKU on Shopify and Salla does not merge products", () => {
    const report = planFor({
      integrations: [
        integration(SHOPIFY_A, "shopify"),
        integration(SALLA_A, "salla"),
      ],
      products: [
        product({
          id: "p-shop",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "100",
          sku: "TS-B-L",
          raw_data: {
            provider: "shopify",
            variants: [
              shopifyVariant("11", {
                sku: "TS-B-L",
                title: "L",
                selected_options: [{ name: "Size", value: "L" }],
              }),
            ],
          },
        }),
        product({
          id: "p-salla",
          source_integration_id: SALLA_A,
          easyorder_id: "900",
          sku: "TS-B-L",
          raw_data: {
            provider: "salla",
            variants: [
              {
                id: "salla-sku-1",
                sku: "TS-B-L",
                price: "40",
                selected_options: [{ name: "المقاس", value: "L" }],
                salla: { sku_id: "salla-sku-1" },
              },
            ],
          },
        }),
      ],
    });
    assert.equal(report.plans.length, 2);
    assert.equal(report.plans[0].product_id, "p-shop");
    assert.equal(report.plans[1].product_id, "p-salla");
    assert.equal(report.plans[0].variants[0].internal_sku, null);
    assert.equal(report.plans[1].variants[0].internal_sku, null);
    assert.equal(report.operations.source_mappings.length, 2);
    assert.equal(
      new Set(report.operations.source_mappings.map((row) => row.integration_id)).size,
      2,
    );
  });

  it("13. duplicate barcode is not copied to catalog", () => {
    const report = planFor({
      integrations: [integration(SALLA_A, "salla")],
      products: [
        product({
          id: "p-b1",
          source_integration_id: SALLA_A,
          easyorder_id: "b1",
          sku: "SKU-1",
          raw_data: {
            variants: [
              {
                id: "v1",
                sku: "SKU-1",
                price: "1",
                salla: { sku_id: "v1", barcode: "SAME-BC" },
              },
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
              {
                id: "v2",
                sku: "SKU-2",
                price: "2",
                salla: { sku_id: "v2", barcode: "SAME-BC" },
              },
            ],
          },
        }),
      ],
    });
    assert.equal(report.plans[0].variants[0].barcode, null);
    assert.equal(report.plans[1].variants[0].barcode, null);
    assert.ok(codes(report.plans[0]).includes("DUPLICATE_BARCODE"));
    assert.equal(report.counts.duplicate_barcodes, 2);
  });

  it("14. same external ids on two integrations are legal", () => {
    const report = planFor({
      integrations: [
        integration(SHOPIFY_A, "shopify"),
        integration(SHOPIFY_B, "shopify"),
      ],
      products: [
        product({
          id: "p-a",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "555",
          sku: "A-1",
          raw_data: { variants: [shopifyVariant("9", { sku: "A-1" })] },
        }),
        product({
          id: "p-b",
          source_integration_id: SHOPIFY_B,
          easyorder_id: "555",
          sku: "B-1",
          raw_data: { variants: [shopifyVariant("9", { sku: "B-1" })] },
        }),
      ],
    });
    assert.equal(report.plans.every((plan) => plan.status !== STATUS.BLOCKED), true);
    assert.equal(report.operations.source_mappings.length, 2);
    assert.deepEqual(
      report.operations.source_mappings.map((row) => row.integration_id).sort(),
      [SHOPIFY_A, SHOPIFY_B].sort(),
    );
    assert.ok(
      report.operations.source_mappings.every((row) => row.external_variant_id === "9"),
    );
    assert.equal(report.plans[0].product_id, "p-a");
    assert.equal(report.plans[1].product_id, "p-b");
  });

  it("15. duplicate external identity on the same product is blocked", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-dup-ext",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "1",
          sku: "A",
          raw_data: {
            variants: [
              shopifyVariant("99", { sku: "A" }),
              shopifyVariant("99", { sku: "B" }),
            ],
          },
        }),
      ],
    });
    const plan = firstProduct(report);
    assert.equal(plan.status, STATUS.BLOCKED);
    assert.ok(codes(plan).includes("DUPLICATE_EXTERNAL_IDENTITY"));
    assert.equal(plan.variants.length, 1);
  });

  it("16. missing Shopify external variant id is blocked", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-missing-vid",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "1",
          sku: "A",
          raw_data: {
            variants: [{ title: "M", sku: "A", price: "3", selected_options: [] }],
          },
        }),
      ],
    });
    assert.equal(firstProduct(report).status, STATUS.BLOCKED);
    assert.ok(codes(firstProduct(report)).includes("MISSING_EXTERNAL_VARIANT_ID"));
  });

  it("17. orphan source integration is blocked", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-orphan",
          source_integration_id: ORPHAN,
          easyorder_id: "1",
          sku: "A",
          raw_data: { price: 1 },
        }),
      ],
    });
    assert.equal(firstProduct(report).status, STATUS.BLOCKED);
    assert.ok(codes(firstProduct(report)).includes("ORPHAN_SOURCE_INTEGRATION"));
    assert.equal(firstProduct(report).source_mappings.length, 0);
  });

  it("18. malformed variants array blocks the product", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-malformed",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "1",
          sku: "A",
          raw_data: { variants: { id: "nope" } },
        }),
      ],
    });
    assert.equal(firstProduct(report).status, STATUS.BLOCKED);
    assert.ok(codes(firstProduct(report)).includes("MALFORMED_VARIANTS"));
    assert.equal(firstProduct(report).variants.length, 0);
  });

  it("19. malformed options block the product", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-bad-opt",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "1",
          sku: "A",
          raw_data: {
            variants: [
              shopifyVariant("8", {
                sku: "A",
                selected_options: ["not-an-object"],
              }),
            ],
          },
        }),
      ],
    });
    assert.equal(firstProduct(report).status, STATUS.BLOCKED);
    assert.ok(codes(firstProduct(report)).includes("MALFORMED_OPTIONS"));
  });

  it("20. manual NULL source never invents a catalog_source_mapping", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [product({ source_integration_id: null, sku: "MAN-1", easyorder_id: "MAN-1" })],
    });
    assert.equal(firstProduct(report).source_mappings.length, 0);
    assert.equal(firstProduct(report).provider, "manual");
  });

  it("21. second pass against existing rows proposes REUSE not CREATE", () => {
    const products = [
      product({
        id: "p-reuse",
        source_integration_id: SHOPIFY_A,
        easyorder_id: "100",
        sku: "SH-1",
        raw_data: { variants: [shopifyVariant("1231", { sku: "SH-1", price: "10" })] },
      }),
    ];
    const integrations = [integration(SHOPIFY_A, "shopify")];
    const first = planFor({ products, integrations });
    const planned = first.plans[0].variants[0];
    const second = planFor({
      products,
      integrations,
      existing: {
        variants: [
          {
            id: "var-existing",
            company_id: COMPANY_A,
            product_id: "p-reuse",
            title: planned.title,
            internal_sku: planned.internal_sku,
            barcode: planned.barcode,
            price: planned.price,
            compare_at_price: planned.compare_at_price,
            is_default: planned.is_default,
            position: planned.position,
          },
        ],
        sourceMappings: [
          {
            id: "map-existing",
            company_id: COMPANY_A,
            integration_id: SHOPIFY_A,
            external_product_id: "100",
            external_variant_id: "1231",
            internal_product_id: "p-reuse",
            internal_variant_id: "var-existing",
            external_sku: "SH-1",
          },
        ],
      },
    });
    assert.equal(second.counts.variants_create, 0);
    assert.equal(second.counts.variants_reuse, 1);
    assert.equal(second.counts.source_mappings_create, 0);
    assert.equal(second.plans[0].variants[0].action, ACTION.REUSE);
    assert.equal(second.plans[0].variants[0].existing_variant_id, "var-existing");
  });

  it("22. SKU uniqueness is tenant-scoped", () => {
    const report = planFor({
      products: [
        product({
          id: "a1",
          company_id: COMPANY_A,
          sku: "SHARED",
          easyorder_id: "SHARED",
          raw_data: { price: 1 },
        }),
        product({
          id: "b1",
          company_id: COMPANY_B,
          sku: "SHARED",
          easyorder_id: "SHARED",
          raw_data: { price: 1 },
        }),
      ],
    });
    assert.equal(report.plans[0].variants[0].internal_sku, "SHARED");
    assert.equal(report.plans[1].variants[0].internal_sku, "SHARED");
    assert.ok(!codes(report.plans[0]).includes("DUPLICATE_INTERNAL_SKU"));
    assert.equal(report.counts.companies_scanned, 2);
  });

  it("23. Bosta variant entity_id is matchable to the planned external id", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-bosta",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "100",
          sku: "SH-1",
          raw_data: { variants: [shopifyVariant("777", { sku: "SH-1" })] },
        }),
      ],
      bostaMappings: [
        {
          id: "bm-1",
          company_id: COMPANY_A,
          mapping_type: "variant",
          entity_id: "777",
          catalog_product_id: "p-bosta",
        },
      ],
    });
    assert.ok(codes(firstProduct(report)).includes("BOSTA_VARIANT_MATCHABLE"));
    assert.equal(report.counts.bosta_followup_required, 0);
  });

  it("24. Bosta size mapping is ambiguous when it does not uniquely match options", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-size",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "100",
          sku: "P-120",
          raw_data: {
            variants: [
              shopifyVariant("1", {
                sku: "P-120",
                selected_options: [{ name: "Height", value: "120" }],
              }),
              shopifyVariant("2", {
                sku: "P-120B",
                selected_options: [{ name: "Height", value: "120cm" }],
              }),
            ],
          },
        }),
      ],
      bostaMappings: [
        {
          id: "bm-size",
          mapping_type: "size",
          catalog_product_id: "p-size",
          sizes: { "120": ["BOSTA-A"] },
        },
      ],
    });
    assert.ok(codes(firstProduct(report)).includes("BOSTA_SIZE_AMBIGUOUS"));
    assert.equal(report.counts.bosta_followup_required, 1);
  });

  it("does not infer bundle product_type from names", () => {
    const report = planFor({
      products: [
        product({
          id: "p-bundle-name",
          sku: "BEDROOM-OFFER",
          easyorder_id: "BEDROOM-OFFER",
          raw_data: { name: "Bedroom Offer Bundle", price: 99 },
        }),
      ],
    });
    assert.equal(firstProduct(report).planned_product_type, "simple");
  });

  it("preserves Black vs black as distinct option values", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-case",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "1",
          sku: "C1",
          raw_data: {
            variants: [
              shopifyVariant("1", {
                sku: "C1",
                selected_options: [{ name: "Color", value: "Black" }],
              }),
              shopifyVariant("2", {
                sku: "C2",
                selected_options: [{ name: "Color", value: "black" }],
              }),
            ],
          },
        }),
      ],
    });
    const values = firstProduct(report).option_values.map((row) => row.value).sort();
    assert.deepEqual(values, ["Black", "black"]);
  });

  it("refuses unknown Supabase hosts", () => {
    assert.throws(
      () => assertSaasDevelopmentTarget(""),
      (err) => err.code === "TARGET_UNVERIFIED",
    );
    assert.throws(
      () => assertSaasDevelopmentTarget(`https://${ALLOWED_SAAS_DEV_REF}.evil.example`),
      (err) => err.code === "TARGET_UNVERIFIED",
    );
    const ok = assertSaasDevelopmentTarget(
      `https://${ALLOWED_SAAS_DEV_REF}.supabase.co`,
    );
    assert.equal(ok.project_ref, ALLOWED_SAAS_DEV_REF);
  });

  it("CLI defaults to dry-run and treats --commit as a flag only", () => {
    const dry = parseCatalogBackfillCliArgs([]);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.commit, false);
    const flagged = parseCatalogBackfillCliArgs(["--dry-run", "--json"]);
    assert.equal(flagged.dryRun, true);
    const commit = parseCatalogBackfillCliArgs(["--commit"]);
    assert.equal(commit.commit, true);
    assert.match(COMMIT_DISABLED_MESSAGE, /C1C/);
  });

  it("does not coerce invalid prices to 0", () => {
    assert.equal(parseCatalogPrice("nope").value, null);
    assert.equal(parseCatalogPrice("nope").ok, false);
    assert.equal(parseCatalogPrice(12.345).value, 12.35);
    const report = planFor({
      products: [product({ sku: "P", easyorder_id: "P", raw_data: { price: "abc" } })],
    });
    assert.equal(firstProduct(report).variants[0].price, null);
    assert.ok(codes(firstProduct(report)).includes("INVALID_PRICE"));
  });

  it("summary formatter includes counts without PII", () => {
    const report = planFor({ products: [product()], integrations: [] });
    const text = formatCatalogBackfillSummary(report);
    assert.match(text, /dry-run/);
    assert.doesNotMatch(text, /Pillow/);
  });

  it("Bosta unmatched variant is a warning follow-up, not a silent success", () => {
    const report = planFor({
      integrations: [integration(SHOPIFY_A, "shopify")],
      products: [
        product({
          id: "p-unmatched",
          source_integration_id: SHOPIFY_A,
          easyorder_id: "100",
          sku: "SH-1",
          raw_data: { variants: [shopifyVariant("1", { sku: "SH-1" })] },
        }),
      ],
      bostaMappings: [
        {
          mapping_type: "variant",
          entity_id: "does-not-exist",
          catalog_product_id: "p-unmatched",
        },
      ],
    });
    assert.ok(codes(firstProduct(report)).includes("BOSTA_VARIANT_UNMATCHED"));
    assert.equal(report.counts.bosta_followup_required, 1);
  });

  it("manual default variant is reused from existing is_default row", () => {
    const products = [product({ id: "p-man", sku: "MAN", easyorder_id: "MAN", raw_data: { price: 9 } })];
    const report = planFor({
      products,
      existing: {
        variants: [
          {
            id: "existing-default",
            company_id: COMPANY_A,
            product_id: "p-man",
            title: null,
            internal_sku: "MAN",
            barcode: null,
            price: 9,
            compare_at_price: null,
            is_default: true,
            position: 0,
          },
        ],
      },
    });
    assert.equal(report.plans[0].variants[0].action, ACTION.REUSE);
    assert.equal(report.counts.variants_create, 0);
  });
});
