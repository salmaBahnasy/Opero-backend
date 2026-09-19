process.env.NODE_ENV = "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DIAGNOSTIC,
  SEVERITY,
  unwrapEasyOrdersDetails,
  listNeedsDetails,
  requestEasyOrdersDetailsWithRetry,
  normalizeEasyOrdersProduct,
  enrichEasyOrdersCatalog,
} = require("../src/services/easyorderCatalog.service");

const SERVICE_PATH = path.resolve(
  __dirname,
  "../src/services/easyorderCatalog.service.js",
);

function variant({ id = "v1", sku = "SKU-1", price = 10, props = null, extra = {} } = {}) {
  return {
    id,
    sku,
    price,
    sale_price: extra.sale_price ?? price,
    quantity: extra.quantity ?? 3,
    variation_props: props,
    selected_options: extra.selected_options,
    product_id: extra.product_id ?? "p1",
    ...extra,
  };
}

function listItem(overrides = {}) {
  return {
    id: "eo-1",
    name: "Cream",
    sku: "EO-1",
    price: 15,
    quantity: 4,
    image: "https://cdn.example/list.jpg",
    ...overrides,
  };
}

function httpError(status, message = "failed", extra = {}) {
  const error = new Error(message);
  error.response = {
    status,
    data: { message },
    headers: extra.headers || {},
  };
  return error;
}

function timeoutError() {
  const error = new Error("timeout of 15000ms exceeded");
  error.code = "ECONNABORTED";
  return error;
}

function codes(product) {
  return (product.diagnostics || []).map((item) => item.code);
}

function stringifySafe(value) {
  return JSON.stringify(value);
}

describe("EasyOrders catalog enrichment", () => {
  it("1. list item already has complete variants → no details fetch", async () => {
    let calls = 0;
    const report = await enrichEasyOrdersCatalog({
      listItems: [
        listItem({
          variants: [
            variant({
              id: "eo-v1",
              props: [{ variation: "مقاس", variation_prop: "S" }],
            }),
          ],
        }),
      ],
      requestDetails: async () => {
        calls += 1;
        throw new Error("details should not be fetched");
      },
    });
    assert.equal(calls, 0);
    assert.equal(report.stats.detailsSkipped, 1);
    assert.equal(report.stats.detailsAttempted, 0);
    assert.equal(report.products[0].detailsFetched, false);
    assert.equal(report.products[0].variantsComplete, true);
    assert.equal(report.products[0].variants[0].externalVariantId, "eo-v1");
  });

  it("2. list item has no variants → details fetched", async () => {
    let fetchedId = null;
    const report = await enrichEasyOrdersCatalog({
      listItems: [listItem()],
      requestDetails: async (id) => {
        fetchedId = id;
        return {
          id: "eo-1",
          name: "Cream",
          variants: [variant({ id: "eo-v9" })],
        };
      },
    });
    assert.equal(fetchedId, "eo-1");
    assert.equal(report.stats.detailsAttempted, 1);
    assert.equal(report.stats.detailsSucceeded, 1);
    assert.equal(report.products[0].detailsFetched, true);
    assert.ok(codes(report.products[0]).includes(DIAGNOSTIC.DETAILS_REQUIRED));
    assert.equal(report.products[0].variants[0].externalVariantId, "eo-v9");
  });

  it("3. details wrapped in data", () => {
    const root = unwrapEasyOrdersDetails({
      data: { name: "From data", variants: [variant({ id: "d1" })] },
    });
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem(),
      details: { data: { name: "From data", variants: [variant({ id: "d1" })] } },
      detailsFetched: true,
    });
    assert.equal(root.name, "From data");
    assert.equal(normalized.title, "From data");
    assert.equal(normalized.variants[0].externalVariantId, "d1");
  });

  it("4. details wrapped in product", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem(),
      details: {
        product: { name: "From product", variants: [variant({ id: "p1" })] },
      },
      detailsFetched: true,
    });
    assert.equal(normalized.title, "From product");
    assert.equal(normalized.variants[0].externalVariantId, "p1");
  });

  it("5. details raw root", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem(),
      details: { name: "Root", variants: [variant({ id: "r1" })] },
      detailsFetched: true,
    });
    assert.equal(normalized.title, "Root");
    assert.equal(normalized.variants[0].externalVariantId, "r1");
  });

  it("6. variant.id preserved", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({
        variants: [variant({ id: 99001, sku: "NOT-IDENTITY" })],
      }),
    });
    assert.equal(normalized.variants[0].externalVariantId, "99001");
  });

  it("7. SKU is NOT used as variant identity", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem(),
      details: {
        variants: [{ sku: "EO-SKU-ONLY", price: 10, variation_props: [] }],
      },
      detailsFetched: true,
    });
    assert.equal(normalized.variants.length, 0);
    assert.equal(normalized.variantsComplete, false);
    assert.ok(codes(normalized).includes(DIAGNOSTIC.VARIANT_ID_MISSING));
    assert.ok(
      !normalized.variants.some((row) => row.externalVariantId === "EO-SKU-ONLY"),
    );
  });

  it("8. Arabic variation names/values preserved", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({
        variants: [
          variant({
            id: "eo-ar",
            props: [{ variation: "لون", variation_prop: "أسود" }],
          }),
        ],
      }),
    });
    assert.deepEqual(normalized.variants[0].options, [
      { name: "لون", value: "أسود" },
    ]);
  });

  it("9. multiple generic option dimensions", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({
        variants: [
          variant({
            id: "eo-multi",
            props: [
              { variation: "لون", variation_prop: "أبيض" },
              { variation: "مقاس", variation_prop: "XL" },
            ],
          }),
        ],
      }),
    });
    assert.equal(normalized.productType, "variable");
    assert.deepEqual(normalized.variants[0].options, [
      { name: "لون", value: "أبيض" },
      { name: "مقاس", value: "XL" },
    ]);
  });

  it("10. details timeout", async () => {
    let sends = 0;
    await assert.rejects(
      () =>
        requestEasyOrdersDetailsWithRetry(
          async () => {
            sends += 1;
            throw timeoutError();
          },
          { maxRetries: 1, sleep: async () => {} },
        ),
      (error) => {
        assert.equal(error.code, DIAGNOSTIC.DETAILS_TIMEOUT);
        assert.equal(error.kind, "timeout");
        return true;
      },
    );
    assert.equal(sends, 2);
  });

  it("11. transient 500 retry then success", async () => {
    let sends = 0;
    const payload = await requestEasyOrdersDetailsWithRetry(
      async () => {
        sends += 1;
        if (sends < 3) throw httpError(500, "upstream");
        return { id: "ok" };
      },
      { maxRetries: 2, sleep: async () => {} },
    );
    assert.equal(sends, 3);
    assert.equal(payload.id, "ok");
  });

  it("12. 429 retry then success", async () => {
    let sends = 0;
    const payload = await requestEasyOrdersDetailsWithRetry(
      async () => {
        sends += 1;
        if (sends === 1) throw httpError(429, "slow down");
        return { id: "after-429" };
      },
      { maxRetries: 2, sleep: async () => {} },
    );
    assert.equal(sends, 2);
    assert.equal(payload.id, "after-429");
  });

  it("13. 400 no retry", async () => {
    let sends = 0;
    await assert.rejects(
      () =>
        requestEasyOrdersDetailsWithRetry(
          async () => {
            sends += 1;
            throw httpError(400, "bad request");
          },
          { maxRetries: 3, sleep: async () => {} },
        ),
      (error) => {
        assert.equal(error.code, DIAGNOSTIC.DETAILS_FAILED);
        assert.equal(error.kind, "permanent");
        return true;
      },
    );
    assert.equal(sends, 1);
  });

  it("14. 401/403 auth failure", async () => {
    await assert.rejects(
      () =>
        requestEasyOrdersDetailsWithRetry(
          async () => {
            throw httpError(401, "Api-Key not valid");
          },
          { maxRetries: 3, sleep: async () => {} },
        ),
      (error) => {
        assert.equal(error.code, DIAGNOSTIC.AUTH_INVALID);
        assert.equal(error.kind, "auth");
        return true;
      },
    );
    await assert.rejects(
      () =>
        requestEasyOrdersDetailsWithRetry(
          async () => {
            throw httpError(403, "forbidden");
          },
          { sleep: async () => {} },
        ),
      (error) => error.code === DIAGNOSTIC.AUTH_INVALID,
    );
  });

  it("15. one details failure does not destroy other results", async () => {
    const report = await enrichEasyOrdersCatalog({
      listItems: [
        listItem({ id: "ok-1" }),
        listItem({ id: "fail-2" }),
        listItem({ id: "ok-3" }),
      ],
      concurrency: 1,
      maxRetries: 0,
      sleep: async () => {},
      requestDetails: async (id) => {
        if (id === "fail-2") throw httpError(500, "boom");
        return {
          id,
          variants: [variant({ id: `${id}-v` })],
        };
      },
    });
    assert.equal(report.products.length, 3);
    assert.equal(report.products[0].variantsComplete, true);
    assert.equal(report.products[1].incomplete, true);
    assert.equal(report.products[1].variants.length, 0);
    assert.ok(codes(report.products[1]).includes(DIAGNOSTIC.DETAILS_FAILED));
    assert.equal(report.products[2].variants[0].externalVariantId, "ok-3-v");
    assert.equal(report.stats.detailsSucceeded, 2);
    assert.equal(report.stats.detailsFailed, 1);
  });

  it("16. auth failure short-circuits remaining work", async () => {
    const fetched = [];
    const report = await enrichEasyOrdersCatalog({
      listItems: [
        listItem({ id: "a" }),
        listItem({ id: "b" }),
        listItem({ id: "c" }),
      ],
      concurrency: 1,
      maxRetries: 0,
      sleep: async () => {},
      requestDetails: async (id) => {
        fetched.push(id);
        throw httpError(401, "Api-Key not valid");
      },
    });
    assert.deepEqual(fetched, ["a"]);
    assert.equal(report.stats.authInvalid, true);
    assert.equal(report.stats.shortCircuited, 2);
    assert.equal(report.diagnostics[0].code, DIAGNOSTIC.AUTH_INVALID);
    assert.equal(report.products[1].skippedAfterAuth, true);
    assert.equal(report.products[2].variants.length, 0);
  });

  it("17. malformed variants require details and stay incomplete if still malformed", async () => {
    assert.equal(listNeedsDetails(listItem({ variants: { id: "nope" } })).needed, true);
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({ variants: { id: "nope" } }),
      details: { variants: { still: "bad" } },
      detailsFetched: true,
    });
    assert.equal(normalized.variants.length, 0);
    assert.equal(normalized.variantsComplete, false);
    assert.ok(codes(normalized).includes(DIAGNOSTIC.VARIANTS_INCOMPLETE));
    assert.equal(normalized.productType, null);
  });

  it("18. variant missing id", () => {
    const mixed = listItem({
      variants: [
        variant({ id: "keep" }),
        { sku: "NO-ID", price: 8, variation_props: [{ variation: "Size", variation_prop: "M" }] },
      ],
    });
    assert.equal(listNeedsDetails(mixed).needed, true);
    const fromDetails = normalizeEasyOrdersProduct({
      listItem: listItem(),
      details: mixed,
      detailsFetched: true,
    });
    assert.deepEqual(
      fromDetails.variants.map((row) => row.externalVariantId),
      ["keep"],
    );
    assert.equal(fromDetails.variantsComplete, false);
    assert.ok(codes(fromDetails).includes(DIAGNOSTIC.VARIANT_ID_MISSING));
  });

  it("19. no fake simple/default variant on incomplete details", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({ sku: "EO-1", price: 15 }),
      details: { name: "Cream" },
      detailsFetched: true,
    });
    assert.equal(normalized.variants.length, 0);
    assert.equal(normalized.variantsComplete, false);
    assert.equal(normalized.productType, null);
    assert.equal(normalized.incomplete, true);
    assert.ok(!normalized.variants.some((row) => row.externalVariantId === ""));
  });

  it("20. bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const report = await enrichEasyOrdersCatalog({
      listItems: Array.from({ length: 6 }, (_, index) =>
        listItem({ id: `p${index}` }),
      ),
      concurrency: 2,
      sleep: async () => {},
      requestDetails: async (id) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { id, variants: [variant({ id: `${id}-v` })] };
      },
    });
    assert.ok(peak <= 2, `peak in-flight ${peak}`);
    assert.ok(report.stats.maxInFlight <= 2);
    assert.equal(report.stats.detailsSucceeded, 6);
  });

  it("21. no 013 table writes", async () => {
    const source = fs.readFileSync(SERVICE_PATH, "utf8");
    assert.match(source, /must NOT write Migration-013/);
    assert.doesNotMatch(
      source,
      /from\(["']product_variants["']\)|from\(["']product_options["']\)|from\(["']catalog_source_mappings["']\)/,
    );
    const report = await enrichEasyOrdersCatalog({
      listItems: [listItem({ variants: [variant({ id: "v1" })] })],
    });
    assert.deepEqual(report.catalogTablesWritten, []);
  });

  it("22. no provider secrets in diagnostics/logging", async () => {
    const report = await enrichEasyOrdersCatalog({
      listItems: [listItem({ id: "secret-check" })],
      concurrency: 1,
      maxRetries: 0,
      sleep: async () => {},
      requestDetails: async () => {
        const error = httpError(401, "Api-Key not valid");
        error.response.headers.Authorization = "Bearer super-secret";
        error.config = { headers: { "Api-Key": "abc123secret" } };
        throw error;
      },
    });
    const dumped = stringifySafe(report);
    assert.equal(dumped.includes("super-secret"), false);
    assert.equal(dumped.includes("abc123secret"), false);
    assert.equal(dumped.includes("Api-Key"), false);
    assert.ok(
      report.products[0].diagnostics.every(
        (item) => !/bearer|api-key|secret/i.test(item.message || ""),
      ),
    );
  });

  it("empty list variants are not treated as a complete simple product", () => {
    assert.equal(listNeedsDetails(listItem({ variants: [] })).needed, true);
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({ variants: [] }),
    });
    assert.equal(normalized.productType, null);
    assert.equal(normalized.variantsComplete, false);
  });

  it("selected_options are used when present", () => {
    const normalized = normalizeEasyOrdersProduct({
      listItem: listItem({
        variants: [
          variant({
            id: "sel-1",
            extra: {
              selected_options: [{ name: "Color", value: "Blue" }],
            },
            props: [{ variation: "ignored", variation_prop: "nope" }],
          }),
        ],
      }),
    });
    assert.deepEqual(normalized.variants[0].options, [
      { name: "Color", value: "Blue" },
    ]);
  });
});
