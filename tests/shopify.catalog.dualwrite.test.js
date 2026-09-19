process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { runWithCompanyId } = require("../src/utils/tenantScope");
const {
  isShopifyCatalogDualWriteEnabled,
} = require("../src/services/catalogDualWrite.gate");
const { occupancyFromVariants } = require("../src/services/catalogCanonicalState.service");
const {
  writeShopifyCatalogDualWrite,
  CANONICAL_STATUS,
  sanitizeCanonicalError,
} = require("../src/services/catalogShopifyDualWrite.service");
const { writeCatalogProductPlan } = require("../src/services/catalogWriter.service");
const {
  parseCatalogBackfillCliArgs,
  COMMIT_DISABLED_MESSAGE,
  ACTION,
} = require("../src/services/catalogBackfill.service");
const {
  syncShopifyProducts,
  MAX_VARIANT_PAGES,
} = require("../src/services/shopifyProducts.service");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const SHOPIFY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHOPIFY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VARIANT_SIMPLE = "1231";

const GATE_ON = {
  CATALOG_DUAL_WRITE_SHOPIFY: "true",
  CATALOG_DUAL_WRITE_COMPANY_IDS: COMPANY_A,
};

const originalAxiosPost = axios.post;
let fake;
let graphqlCalls = [];

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

function integration(id = SHOPIFY_A, companyId = COMPANY_A) {
  return {
    id,
    company_id: companyId,
    provider: "shopify",
    category: "commerce",
    is_enabled: true,
    settings: { shopDomain: "enaya-eg.myshopify.com" },
  };
}

function secrets() {
  return { accessToken: "shpat-dualwrite-test-token", shopDomain: "enaya-eg.myshopify.com" };
}

function variantNode({
  id,
  title = "Default Title",
  sku = "SH-1",
  price = "10.00",
  selectedOptions,
} = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    legacyResourceId: String(id),
    title,
    sku,
    price,
    inventoryQuantity: 3,
    selectedOptions:
      selectedOptions || [{ name: "Title", value: "Default Title" }],
    image: { url: "https://cdn.test/v.jpg" },
  };
}

function productNode({
  id = 100,
  title = "Serum",
  variants,
  hasMoreVariants = false,
} = {}) {
  return {
    id: `gid://shopify/Product/${id}`,
    legacyResourceId: String(id),
    title,
    handle: "serum",
    status: "ACTIVE",
    vendor: "Enaya",
    productType: "Care",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    featuredMedia: { preview: { image: { url: "https://cdn.test/p.jpg" } } },
    variants: {
      pageInfo: {
        hasNextPage: Boolean(hasMoreVariants),
        endCursor: hasMoreVariants ? "variant-cursor-1" : null,
      },
      nodes:
        variants ||
        [variantNode({ id: VARIANT_SIMPLE, sku: "SH-1", title: "Default Title" })],
    },
  };
}

function shirtVariants() {
  const cells = [
    ["11", "Black", "M", "TS-B-M"],
    ["12", "Black", "L", "TS-B-L"],
    ["13", "White", "M", "TS-W-M"],
    ["14", "White", "L", "TS-W-L"],
  ];
  return cells.map(([id, color, size, sku]) =>
    variantNode({
      id,
      title: `${color} / ${size}`,
      sku,
      price: "20.00",
      selectedOptions: [
        { name: "Color", value: color },
        { name: "Size", value: size },
      ],
    }),
  );
}

function productsConnection(nodes, pageInfo = {}) {
  return {
    status: 200,
    headers: {},
    data: {
      data: {
        products: {
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
            ...pageInfo,
          },
          nodes,
        },
      },
    },
  };
}

function queryName(body) {
  const text = String(body?.query || "");
  if (text.includes("ShopifyProductVariants")) return "variants";
  if (text.includes("ShopifyProducts")) return "products";
  return "other";
}

function mockWriter() {
  const calls = [];
  const writer = async (plan, context) => {
    calls.push({ plan, context });
    return {
      productId: plan.product_id,
      productType: plan.planned_product_type,
      variantIds: (plan.variants || []).map(
        (row) => row.existing_variant_id || `new-${row.variant_key}`,
      ),
      optionIds: {},
      optionValueIds: {},
      sourceMappings: [],
    };
  };
  return { writer, calls };
}

function seedFake(extra = {}) {
  return createFakeSupabase({
    companies: [
      { id: COMPANY_A, name: "A", slug: "a", is_active: true, deleted_at: null },
      { id: COMPANY_B, name: "B", slug: "b", is_active: true, deleted_at: null },
    ],
    company_integrations: [
      integration(SHOPIFY_A, COMPANY_A),
      integration(SHOPIFY_B, COMPANY_A),
    ],
    ...extra,
  });
}

async function sync(opts = {}) {
  return runWithCompanyId(opts.companyId || COMPANY_A, () =>
    syncShopifyProducts({
      integration: opts.integration || integration(),
      secrets: secrets(),
      catalogWriter: opts.catalogWriter,
      canonicalStateLoader: opts.canonicalStateLoader,
      dualWriteEnv: opts.dualWriteEnv,
      persistProduct: opts.persistProduct,
      cursor: opts.cursor,
    }),
  );
}

beforeEach(() => {
  fake = seedFake();
  supabase.__setClientForTests(fake);
  graphqlCalls = [];
  axios.post = async (url, body, config = {}) => {
    graphqlCalls.push({
      url,
      query: queryName(body),
      headers: config.headers || {},
    });
    const handler = axios.post.__impl;
    if (typeof handler === "function") return handler(url, body, config);
    return productsConnection([productNode()]);
  };
});

afterEach(() => {
  axios.post = originalAxiosPost;
  delete axios.post.__impl;
});

describe("C1K Shopify catalog dual-write gate", () => {
  it("1-4. unset/false/no allowlist/wrong company disable canonical writes", () => {
    assert.equal(isShopifyCatalogDualWriteEnabled(COMPANY_A, {}), false);
    assert.equal(
      isShopifyCatalogDualWriteEnabled(COMPANY_A, { CATALOG_DUAL_WRITE_SHOPIFY: "false" }),
      false,
    );
    assert.equal(
      isShopifyCatalogDualWriteEnabled(COMPANY_A, {
        CATALOG_DUAL_WRITE_SHOPIFY: "true",
      }),
      false,
    );
    assert.equal(
      isShopifyCatalogDualWriteEnabled(COMPANY_A, {
        CATALOG_DUAL_WRITE_SHOPIFY: "true",
        CATALOG_DUAL_WRITE_COMPANY_IDS: COMPANY_B,
      }),
      false,
    );
  });

  it("5. gate true + allowlist company enables, and duplicates/whitespace are normalized", () => {
    assert.equal(isShopifyCatalogDualWriteEnabled(COMPANY_A, GATE_ON), true);
    assert.equal(
      isShopifyCatalogDualWriteEnabled(COMPANY_A, {
        CATALOG_DUAL_WRITE_SHOPIFY: "YES",
        CATALOG_DUAL_WRITE_COMPANY_IDS: ` ${COMPANY_A}, ${COMPANY_A} `,
      }),
      true,
    );
  });
});

describe("C1K Shopify catalog dual-write sync", () => {
  it("1-2, 37. gate unset/false keeps legacy-only Shopify sync", async () => {
    const { writer, calls } = mockWriter();
    const unset = await sync({ catalogWriter: writer, dualWriteEnv: {} });
    assert.equal(unset.created, 1);
    assert.equal(unset.canonicalSkipped, 1);
    assert.equal(unset.canonicalSuccess, 0);
    assert.equal(calls.length, 0);
    assert.equal(fake.__db.products.length, 1);

    const off = await sync({
      catalogWriter: writer,
      dualWriteEnv: { CATALOG_DUAL_WRITE_SHOPIFY: "false", CATALOG_DUAL_WRITE_COMPANY_IDS: COMPANY_A },
    });
    assert.equal(off.canonicalSkipped, 1);
    assert.equal(calls.length, 0);
  });

  it("3-4. gate true without allowlist or with another company is legacy only", async () => {
    const { writer, calls } = mockWriter();
    const missing = await sync({
      catalogWriter: writer,
      dualWriteEnv: { CATALOG_DUAL_WRITE_SHOPIFY: "true" },
    });
    const other = await sync({
      catalogWriter: writer,
      dualWriteEnv: {
        CATALOG_DUAL_WRITE_SHOPIFY: "true",
        CATALOG_DUAL_WRITE_COMPANY_IDS: COMPANY_B,
      },
    });
    assert.equal(missing.canonicalSkipped, 1);
    assert.equal(other.canonicalSkipped, 1);
    assert.equal(calls.length, 0);
  });

  it("5-9, 16, 31-32, 35-36. allowed company writes simple Default Title with real variant id", async () => {
    const { writer, calls } = mockWriter();
    const result = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(result.canonicalSuccess, 1);
    assert.equal(result.canonicalSkipped, 0);
    assert.equal(calls.length, 1);
    const { plan, context } = calls[0];
    assert.equal(plan.product_id, fake.__db.products[0].id);
    assert.equal(context.companyId, COMPANY_A);
    assert.equal(plan.planned_product_type, "simple");
    assert.equal(plan.variants.length, 1);
    assert.equal(plan.variants[0].action, ACTION.CREATE);
    assert.equal(plan.variants[0].external_variant_id, VARIANT_SIMPLE);
    assert.notEqual(plan.variants[0].external_variant_id, "");
    assert.equal(plan.options.length, 0);
    assert.equal(plan.source_mappings.length, 1);
    assert.equal(plan.source_mappings[0].integration_id, SHOPIFY_A);
    assert.equal(plan.source_mappings[0].external_product_id, "100");
    assert.equal(plan.source_mappings[0].external_variant_id, VARIANT_SIMPLE);
    assert.equal(plan.variants[0].barcode, null);
    assert.equal(plan.variants[0].compare_at_price, null);
    assert.equal(result.canonicalProducts[0].legacyProductId, plan.product_id);
    assert.equal(result.canonicalProducts[0].canonicalStatus, "written");
    assert.equal(JSON.stringify(result).includes("shpat-dualwrite-test-token"), false);
    assert.equal(JSON.stringify(result).includes("service_role"), false);
  });

  it("10-12. variable 4-variant Color/Size plans generic options and exact mappings", async () => {
    axios.post.__impl = async () =>
      productsConnection([
        productNode({
          id: 200,
          title: "T-Shirt",
          variants: shirtVariants(),
        }),
      ]);
    const { writer, calls } = mockWriter();
    const result = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const plan = calls[0].plan;
    assert.equal(result.canonicalSuccess, 1);
    assert.equal(plan.planned_product_type, "variable");
    assert.equal(plan.variants.length, 4);
    assert.equal(plan.options.length, 2);
    assert.deepEqual(plan.options.map((row) => row.name).sort(), ["Color", "Size"]);
    assert.equal(plan.option_values.length, 4);
    assert.equal(plan.source_mappings.length, 4);
    assert.deepEqual(
      plan.variants.map((row) => row.external_variant_id),
      ["11", "12", "13", "14"],
    );
    assert.equal(
      plan.variants.reduce((sum, row) => sum + (row.option_pairs || []).length, 0),
      8,
    );
    assert.equal(
      plan.source_mappings.every((row) => row.integration_id === SHOPIFY_A),
      true,
    );
  });

  it("13. missing SKU leaves internal_sku null and keeps the real variant id", async () => {
    axios.post.__impl = async () =>
      productsConnection([
        productNode({
          variants: [variantNode({ id: "55", sku: "", title: "Default Title" })],
        }),
      ]);
    const { writer, calls } = mockWriter();
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(calls[0].plan.variants[0].internal_sku, null);
    assert.equal(calls[0].plan.variants[0].external_variant_id, "55");
  });

  it("14. duplicate company SKU nulls internal_sku and does not merge", async () => {
    fake.__db.product_variants.push({
      id: "other-var",
      company_id: COMPANY_A,
      product_id: "other-product",
      internal_sku: "SH-1",
      barcode: null,
    });
    const { writer, calls } = mockWriter();
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const plan = calls[0].plan;
    assert.equal(plan.variants[0].internal_sku, null);
    assert.equal(
      plan.diagnostics.some((item) => item.code === "DUPLICATE_INTERNAL_SKU"),
      true,
    );
    assert.equal(plan.source_mappings[0].external_sku, "SH-1");
    assert.equal(plan.variants[0].external_variant_id, VARIANT_SIMPLE);
  });

  it("15, 26. same numeric ids on two Shopify integrations stay separate", async () => {
    const { writer, calls } = mockWriter();
    await sync({
      integration: integration(SHOPIFY_A),
      catalogWriter: writer,
      dualWriteEnv: GATE_ON,
    });
    await sync({
      integration: integration(SHOPIFY_B),
      catalogWriter: writer,
      dualWriteEnv: GATE_ON,
    });
    assert.equal(fake.__db.products.length, 2);
    assert.notEqual(fake.__db.products[0].id, fake.__db.products[1].id);
    assert.equal(calls[0].plan.source_mappings[0].integration_id, SHOPIFY_A);
    assert.equal(calls[1].plan.source_mappings[0].integration_id, SHOPIFY_B);
    assert.equal(calls[0].plan.source_mappings[0].external_product_id, "100");
    assert.equal(calls[1].plan.source_mappings[0].external_product_id, "100");
    assert.notEqual(calls[0].plan.product_id, calls[1].plan.product_id);
  });

  it("17-20. second sync REUSE, price UPDATE, SKU UPDATE, no duplicate parent", async () => {
    const { writer, calls } = mockWriter();
    const first = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const parentId = first.canonicalProducts[0].legacyProductId;
    const variantId = "canon-var-1";
    fake.__db.product_variants.push({
      id: variantId,
      company_id: COMPANY_A,
      product_id: parentId,
      title: null,
      internal_sku: "SH-1",
      barcode: null,
      price: 10,
      compare_at_price: null,
      is_default: true,
      is_active: true,
      position: 0,
    });
    fake.__db.catalog_source_mappings.push({
      id: "map-1",
      company_id: COMPANY_A,
      integration_id: SHOPIFY_A,
      external_product_id: "100",
      external_variant_id: VARIANT_SIMPLE,
      internal_product_id: parentId,
      internal_variant_id: variantId,
      external_sku: "SH-1",
    });

    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const reuse = calls[1].plan;
    assert.equal(reuse.product_id, parentId);
    assert.equal(reuse.variants[0].action, ACTION.REUSE);
    assert.equal(reuse.variants[0].existing_variant_id, variantId);
    assert.equal(reuse.source_mappings[0].action, ACTION.REUSE);
    assert.equal(fake.__db.products.length, 1);

    axios.post.__impl = async () =>
      productsConnection([
        productNode({
          variants: [variantNode({ id: VARIANT_SIMPLE, sku: "SH-1", price: "15.50" })],
        }),
      ]);
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(calls[2].plan.variants[0].action, ACTION.UPDATE);
    assert.equal(calls[2].plan.variants[0].existing_variant_id, variantId);
    assert.equal(calls[2].plan.variants[0].price, 15.5);

    axios.post.__impl = async () =>
      productsConnection([
        productNode({
          variants: [variantNode({ id: VARIANT_SIMPLE, sku: "SH-2", price: "15.50" })],
        }),
      ]);
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(calls[3].plan.variants[0].action, ACTION.UPDATE);
    assert.equal(calls[3].plan.variants[0].internal_sku, "SH-2");
    assert.equal(calls[3].plan.variants[0].existing_variant_id, variantId);
  });

  it("occupancy does not collide a variant with its own existing SKU", () => {
    const occupancy = occupancyFromVariants({
      companyId: COMPANY_A,
      productId: "p1",
      integrationId: SHOPIFY_A,
      incomingExternalVariantIds: [VARIANT_SIMPLE],
      mappings: [
        {
          company_id: COMPANY_A,
          integration_id: SHOPIFY_A,
          internal_product_id: "p1",
          internal_variant_id: "self",
          external_variant_id: VARIANT_SIMPLE,
        },
      ],
      variants: [
        { id: "self", company_id: COMPANY_A, product_id: "p1", internal_sku: "SH-1" },
        { id: "other", company_id: COMPANY_A, product_id: "p2", internal_sku: "OTHER" },
      ],
    });
    assert.equal(occupancy.skuCounts.get(`${COMPANY_A}::SH-1`) || 0, 0);
    assert.equal(occupancy.skuCounts.get(`${COMPANY_A}::OTHER`), 1);
  });

  it("21. new Shopify variant is CREATE beside REUSE of the mapped variant", async () => {
    const { writer, calls } = mockWriter();
    const first = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const parentId = first.canonicalProducts[0].legacyProductId;
    fake.__db.product_variants.push({
      id: "canon-var-1",
      company_id: COMPANY_A,
      product_id: parentId,
      internal_sku: "SH-1",
      price: 10,
      is_default: true,
      position: 0,
    });
    fake.__db.catalog_source_mappings.push({
      id: "map-1",
      company_id: COMPANY_A,
      integration_id: SHOPIFY_A,
      external_product_id: "100",
      external_variant_id: VARIANT_SIMPLE,
      internal_product_id: parentId,
      internal_variant_id: "canon-var-1",
      external_sku: "SH-1",
    });
    axios.post.__impl = async () =>
      productsConnection([
        productNode({
          variants: [
            variantNode({ id: VARIANT_SIMPLE, sku: "SH-1" }),
            variantNode({
              id: "1232",
              sku: "SH-2",
              title: "Large",
              selectedOptions: [{ name: "Size", value: "L" }],
            }),
          ],
        }),
      ]);
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const plan = calls[1].plan;
    const byExt = Object.fromEntries(
      plan.variants.map((row) => [row.external_variant_id, row]),
    );
    assert.ok(["REUSE", "UPDATE"].includes(byExt[VARIANT_SIMPLE].action));
    assert.equal(byExt[VARIANT_SIMPLE].existing_variant_id, "canon-var-1");
    assert.equal(byExt["1232"].action, ACTION.CREATE);
    assert.equal(byExt["1232"].existing_variant_id, null);
    assert.equal(plan.variants.length, 2);
  });

  it("22. removed variant emits STALE_PROVIDER_VARIANT and does not DELETE", async () => {
    const { writer, calls } = mockWriter();
    const first = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const parentId = first.canonicalProducts[0].legacyProductId;
    fake.__db.product_variants.push(
      {
        id: "keep",
        company_id: COMPANY_A,
        product_id: parentId,
        internal_sku: "SH-1",
        price: 10,
        is_default: true,
        position: 0,
      },
      {
        id: "stale",
        company_id: COMPANY_A,
        product_id: parentId,
        internal_sku: "OLD",
        price: 9,
        is_default: false,
        position: 1,
      },
    );
    fake.__db.catalog_source_mappings.push(
      {
        id: "map-keep",
        company_id: COMPANY_A,
        integration_id: SHOPIFY_A,
        external_product_id: "100",
        external_variant_id: VARIANT_SIMPLE,
        internal_product_id: parentId,
        internal_variant_id: "keep",
        external_sku: "SH-1",
      },
      {
        id: "map-stale",
        company_id: COMPANY_A,
        integration_id: SHOPIFY_A,
        external_product_id: "100",
        external_variant_id: "9999",
        internal_product_id: parentId,
        internal_variant_id: "stale",
        external_sku: "OLD",
      },
    );
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    const plan = calls[1].plan;
    assert.equal(
      plan.diagnostics.some((item) => item.code === "STALE_PROVIDER_VARIANT"),
      true,
    );
    assert.equal(
      plan.diagnostics.find((item) => item.code === "STALE_PROVIDER_VARIANT")
        .external_variant_id,
      "9999",
    );
    assert.equal(plan.variants.every((row) => row.action !== "DELETE"), true);
    assert.equal(fake.__db.product_variants.some((row) => row.id === "stale"), true);
    assert.equal(
      fake.__db.catalog_source_mappings.some((row) => row.id === "map-stale"),
      true,
    );
  });

  it("23-24. truncated snapshot is blocked with zero writer calls and no stale diagnostic", async () => {
    let variantPages = 0;
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "products") {
        return productsConnection([
          productNode({
            variants: [variantNode({ id: "1", sku: "X1" })],
            hasMoreVariants: true,
          }),
        ]);
      }
      variantPages += 1;
      return {
        status: 200,
        headers: {},
        data: {
          data: {
            product: {
              variants: {
                pageInfo: { hasNextPage: true, endCursor: `v-${variantPages}` },
                nodes: [variantNode({ id: 10 + variantPages, sku: `X${variantPages}` })],
              },
            },
          },
        },
      };
    };
    fake.__db.catalog_source_mappings.push({
      id: "stale-should-not-count",
      company_id: COMPANY_A,
      integration_id: SHOPIFY_A,
      external_product_id: "100",
      external_variant_id: "gone",
      internal_product_id: "will-be-replaced",
      internal_variant_id: "stale",
    });
    const { writer, calls } = mockWriter();
    const result = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(variantPages, MAX_VARIANT_PAGES);
    assert.equal(result.created, 1);
    assert.equal(result.canonicalBlocked, 1);
    assert.equal(calls.length, 0);
    assert.equal(result.canonicalProducts[0].canonicalStatus, "blocked");
    assert.equal(
      result.canonicalProducts[0].diagnostics.some(
        (item) => item.code === "TRUNCATED_PROVIDER_VARIANTS",
      ),
      true,
    );
    assert.equal(
      result.canonicalProducts[0].diagnostics.some(
        (item) => item.code === "STALE_PROVIDER_VARIANT",
      ),
      false,
    );
  });

  it("25-26. canonical failure keeps the legacy row and does not stop the next product", async () => {
    axios.post.__impl = async () =>
      productsConnection([
        productNode({ id: 1, title: "A" }),
        productNode({
          id: 2,
          title: "B",
          variants: [variantNode({ id: "21", sku: "B-1" })],
        }),
      ]);
    const calls = [];
    const writer = async (plan, context) => {
      calls.push({ plan, context });
      if (plan.external_product_id === "1") {
        const error = new Error("duplicate key value violates unique constraint");
        error.code = "23505";
        throw error;
      }
      return { productId: plan.product_id, productType: plan.planned_product_type, variantIds: [] };
    };
    const result = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(result.created, 2);
    assert.equal(result.canonicalFailed, 1);
    assert.equal(result.canonicalSuccess, 1);
    assert.equal(calls.length, 2);
    assert.equal(fake.__db.products.length, 2);
    assert.equal(result.canonicalProducts[0].canonicalStatus, "failed");
    assert.equal(result.canonicalProducts[0].legacyStatus, "created");
    assert.equal(result.canonicalProducts[1].canonicalStatus, "written");
  });

  it("27. legacy persist failure does not attempt canonical write", async () => {
    axios.post.__impl = async () =>
      productsConnection([
        productNode({ id: 1, title: "OK" }),
        productNode({ id: 2, title: "FAIL" }),
      ]);
    const { writer, calls } = mockWriter();
    let persistCount = 0;
    const persistProduct = async ({ normalized }) => {
      persistCount += 1;
      if (normalized.easyorder_id === "2") {
        const error = new Error("insert failed");
        error.code = "SHOPIFY_PRODUCT_PERSIST_FAILED";
        throw error;
      }
      return {
        id: `legacy-${normalized.easyorder_id}`,
        created: true,
        updated: false,
      };
    };
    const result = await sync({
      catalogWriter: writer,
      persistProduct,
      dualWriteEnv: GATE_ON,
    });
    assert.equal(persistCount, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].plan.external_product_id, "1");
    assert.equal(result.canonicalProducts[1].legacyStatus, "failed");
    assert.equal(result.canonicalProducts[1].canonicalStatus, "not_attempted");
    assert.equal(result.canonicalSuccess, 1);
  });

  it("28. wrong tenant is rejected before the catalog writer", async () => {
    const { writer, calls } = mockWriter();
    const dual = await writeShopifyCatalogDualWrite({
      companyId: COMPANY_B,
      integration: integration(SHOPIFY_A, COMPANY_A),
      productId: "prod-1",
      externalProductId: "100",
      normalized: {
        easyorder_id: "100",
        sku: "SH-1",
        raw_data: {
          provider: "shopify",
          variants: [{ id: VARIANT_SIMPLE, sku: "SH-1", price: "10.00" }],
          shopify: { variants_complete: true, variants_truncated: false },
        },
      },
      variantsComplete: true,
      catalogWriter: writer,
      env: {
        CATALOG_DUAL_WRITE_SHOPIFY: "true",
        CATALOG_DUAL_WRITE_COMPANY_IDS: COMPANY_B,
      },
    });
    assert.equal(dual.canonicalStatus, CANONICAL_STATUS.FAILED);
    assert.equal(dual.canonicalError.code, "CATALOG_WRITE_TENANT_MISMATCH");
    assert.equal(calls.length, 0);
  });

  it("29. wrong integration is rejected before RPC", async () => {
    const rpcCalls = [];
    const plan = {
      company_id: COMPANY_A,
      product_id: "prod-1",
      provider: "shopify",
      status: "READY",
      planned_product_type: "simple",
      diagnostics: [],
      integration_id: SHOPIFY_A,
      variants: [
        {
          action: "CREATE",
          company_id: COMPANY_A,
          product_id: "prod-1",
          variant_key: "source:a:100:1231",
          title: "Default",
          is_default: true,
          is_active: true,
          position: 0,
          internal_sku: "SH-1",
          price: 10,
          option_pairs: [],
        },
      ],
      options: [],
      option_values: [],
      source_mappings: [
        {
          action: "CREATE",
          company_id: COMPANY_A,
          integration_id: SHOPIFY_A,
          external_product_id: "100",
          external_variant_id: VARIANT_SIMPLE,
          variant_key: "source:a:100:1231",
        },
      ],
    };
    await assert.rejects(
      () =>
        writeCatalogProductPlan(plan, {
          companyId: COMPANY_A,
          integrations: [integration(SHOPIFY_B, COMPANY_A)],
          rpc: async (name, args) => {
            rpcCalls.push({ name, args });
            return { data: {}, error: null };
          },
        }),
      (error) => error.code === "CATALOG_WRITE_INVALID_PLAN",
    );
    assert.equal(rpcCalls.length, 0);
  });

  it("30. aggregate counts match per-product statuses", async () => {
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "variants") {
        return {
          status: 200,
          headers: {},
          data: {
            data: {
              product: {
                variants: {
                  pageInfo: { hasNextPage: true, endCursor: "x" },
                  nodes: [variantNode({ id: "99", sku: "Z" })],
                },
              },
            },
          },
        };
      }
      return productsConnection([
        productNode({ id: 1 }),
        productNode({
          id: 2,
          variants: [variantNode({ id: "21", sku: "B" })],
          hasMoreVariants: true,
        }),
      ]);
    };
    const { writer } = mockWriter();
    const result = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(result.canonicalSuccess + result.canonicalBlocked, 2);
    assert.equal(result.canonicalProducts.length, 2);
  });

  it("31. canonical errors are sanitized", () => {
    const sanitized = sanitizeCanonicalError({
      code: "23505",
      message: "service_role eyJhbGciOi fail with token=secret",
    });
    assert.equal(sanitized.code, "23505");
    assert.equal(sanitized.message, "Canonical catalog write failed");
  });

  it("33. catalog writer/RPC is not retried automatically", async () => {
    const { calls } = mockWriter();
    let invoked = 0;
    const writer = async (plan, context) => {
      invoked += 1;
      calls.push({ plan, context });
      throw Object.assign(new Error("network"), { code: "CATALOG_WRITE_FAILED" });
    };
    const result = await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(invoked, 1);
    assert.equal(result.canonicalFailed, 1);
  });

  it("34. dual-write does not add Shopify provider calls beyond existing sync", async () => {
    const { writer } = mockWriter();
    graphqlCalls = [];
    await sync({ catalogWriter: writer, dualWriteEnv: {} });
    const offCount = graphqlCalls.length;
    graphqlCalls = [];
    await sync({ catalogWriter: writer, dualWriteEnv: GATE_ON });
    assert.equal(graphqlCalls.length, offCount);
    assert.equal(graphqlCalls.every((row) => row.query === "products" || row.query === "variants"), true);
  });
});

describe("C1K static call-site and migration safety", () => {
  it("38-45. CLI commit stays disabled; Salla/EasyOrders/manual/imports/frontend/migrations untouched", () => {
    const commit = parseCatalogBackfillCliArgs(["--commit"]);
    assert.equal(commit.commit, true);
    assert.match(COMMIT_DISABLED_MESSAGE, /disabled/i);
    assert.doesNotMatch(read("scripts/catalog-backfill.js"), /writeCatalogProductPlan|writeShopifyCatalogDualWrite/);

    for (const relative of [
      "src/services/sallaProducts.service.js",
      "src/services/products.service.js",
      "src/services/easyorder.service.js",
      "src/services/easyorderCatalog.service.js",
      "src/services/importSources.service.js",
      "src/controllers/ordersImport.controller.js",
    ]) {
      const src = read(relative);
      assert.doesNotMatch(src, /writeCatalogProductPlan\(/);
      assert.doesNotMatch(src, /writeShopifyCatalogDualWrite\(/);
      assert.doesNotMatch(src, /apply_catalog_product_plan/);
    }

    const shopifySrc = read("src/services/shopifyProducts.service.js");
    assert.match(shopifySrc, /writeShopifyCatalogDualWrite\(/);
    assert.doesNotMatch(shopifySrc, /apply_catalog_product_plan/);
    assert.doesNotMatch(
      read("src/services/catalogShopifyDualWrite.service.js"),
      /apply_catalog_product_plan/,
    );
    assert.match(
      read("src/services/catalogShopifyDualWrite.service.js"),
      /writeCatalogProductPlan/,
    );

    assert.match(read("supabase/migrations/013_catalog_foundation.sql"), /create table if not exists public\.product_variants/);
    assert.match(read("supabase/migrations/014_catalog_write_rpc.sql"), /apply_catalog_product_plan/);
    assert.equal(fs.existsSync(path.join(BACKEND_ROOT, "supabase/migrations/015_catalog_write_rpc.sql")), false);
    assert.equal(fs.existsSync(path.join(BACKEND_ROOT, "supabase/migrations/015.sql")), false);
    assert.doesNotMatch(read("src/services/shopifyProducts.service.js"), /VITE_/);
    assert.doesNotMatch(read("src/services/catalogDualWrite.gate.js"), /VITE_/);
  });
});
