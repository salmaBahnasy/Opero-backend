process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ANALYTICS_TIMING = "1";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const {
  signEmployeeToken,
  signPlatformAdminToken,
} = require("../src/config/jwt");
const {
  resetAnalyticsQueryLog,
  getAnalyticsQueryLog,
  getLastAnalyticsTiming,
} = require("../src/services/analytics.service");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHOP_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SHOP_B = "bbbbbbbb-1111-4111-8111-111111111111";
const OTHER_SHOP = "cccccccc-2222-4222-8222-222222222222";
const FEATURE_ANALYTICS = "f4444444-4444-4444-8444-444444444444";
const FEATURE_ORDERS = "f1111111-1111-4111-8111-111111111111";
const NOW = "2026-09-19T12:00:00.000Z";

let server;
let baseUrl;
let fake;

function tokenA() {
  return signEmployeeToken({
    employeeId: ADMIN_A,
    companyId: COMPANY_A,
    role: "company_admin",
    email: "admin@a.local",
  });
}

function tokenB() {
  return signEmployeeToken({
    employeeId: ADMIN_B,
    companyId: COMPANY_B,
    role: "company_admin",
    email: "admin@b.local",
  });
}

async function request(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json, text };
}

function featureRows(companyId, analyticsEnabled) {
  return [
    {
      company_id: companyId,
      feature_id: FEATURE_ORDERS,
      is_enabled: true,
    },
    {
      company_id: companyId,
      feature_id: FEATURE_ANALYTICS,
      is_enabled: analyticsEnabled,
    },
  ];
}

function orderRow(overrides = {}) {
  return {
    id: overrides.id || `ord-${Math.random().toString(16).slice(2)}`,
    company_id: COMPANY_A,
    order_id: overrides.order_id || `ext-${Math.random().toString(16).slice(2)}`,
    status: "new",
    total_amount: 100,
    source_integration_id: SHOP_A,
    created_at: "2026-09-18T10:00:00.000Z",
    raw_data: {},
    ...overrides,
  };
}

function seedClient({ analyticsEnabled = true, orders = [], extra = {} } = {}) {
  return createFakeSupabase({
    companies: [
      { id: COMPANY_A, name: "Alpha", slug: "alpha", is_active: true },
      { id: COMPANY_B, name: "Beta", slug: "beta", is_active: true },
    ],
    employees: [
      {
        id: ADMIN_A,
        company_id: COMPANY_A,
        name: "A Admin",
        email: "admin@a.local",
        role: "company_admin",
        is_active: true,
      },
      {
        id: ADMIN_B,
        company_id: COMPANY_B,
        name: "B Admin",
        email: "admin@b.local",
        role: "company_admin",
        is_active: true,
      },
    ],
    features: [
      { id: FEATURE_ORDERS, key: "orders", is_active: true },
      { id: FEATURE_ANALYTICS, key: "analytics", is_active: true },
    ],
    company_features: [
      ...featureRows(COMPANY_A, analyticsEnabled),
      ...featureRows(COMPANY_B, true),
    ],
    company_integrations: [
      {
        id: SHOP_A,
        company_id: COMPANY_A,
        provider: "shopify",
        category: "commerce",
        name: "Shopify Store A",
        is_enabled: true,
      },
      {
        id: SHOP_B,
        company_id: COMPANY_A,
        provider: "shopify",
        category: "commerce",
        name: "Shopify Store B",
        is_enabled: true,
      },
      {
        id: OTHER_SHOP,
        company_id: COMPANY_B,
        provider: "shopify",
        category: "commerce",
        name: "Other Shopify",
        is_enabled: true,
      },
    ],
    orders,
    products: extra.products || [],
  });
}

const SAMPLE_ORDERS = [
  orderRow({
    id: "1",
    order_id: "s-a-1",
    status: "new",
    total_amount: 200,
    source_integration_id: SHOP_A,
    created_at: "2026-09-18T08:00:00.000Z",
    raw_data: {
      cart_items: [{ product_id: "p1", name: "Serum", sku: "SER-1", quantity: 2, price: 100 }],
    },
  }),
  orderRow({
    id: "2",
    order_id: "s-a-2",
    status: "Confirmed",
    total_amount: 150,
    source_integration_id: SHOP_A,
    created_at: "2026-09-18T12:00:00.000Z",
    raw_data: {
      cart_items: [{ product_id: "p1", name: "Serum", sku: "SER-1", quantity: 1, price: 150 }],
    },
  }),
  orderRow({
    id: "3",
    order_id: "s-b-1",
    status: "canceled",
    total_amount: 50,
    source_integration_id: SHOP_B,
    created_at: "2026-09-18T14:00:00.000Z",
    raw_data: {
      cart_items: [{ product_id: "p2", name: "Cream", sku: "CRM-1", quantity: 1, price: 50 }],
    },
  }),
  orderRow({
    id: "4",
    order_id: "manual-1",
    status: "Shipped",
    total_amount: 80,
    source_integration_id: null,
    created_at: "2026-09-18T16:00:00.000Z",
    raw_data: {
      cart_items: [{ product_id: "p3", name: "Manual Kit", sku: "MAN-1", quantity: 1, price: 80 }],
    },
  }),
  orderRow({
    id: "5",
    order_id: "other-1",
    company_id: COMPANY_B,
    status: "new",
    total_amount: 9999,
    source_integration_id: OTHER_SHOP,
    created_at: "2026-09-18T10:00:00.000Z",
  }),
];

describe("fast analytics MVP", () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.__setClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    fake = seedClient({ orders: SAMPLE_ORDERS });
    supabase.__setClientForTests(fake);
    resetAnalyticsQueryLog();
  });

  it("computes orders, gross order value, AOV, canceled count and rate", async () => {
    const { status, json } = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    assert.equal(status, 200);
    const current = json.overview.current;
    assert.equal(current.totalOrders, 4);
    assert.equal(current.grossOrderValue, 480);
    assert.equal(current.averageOrderValue, 120);
    assert.equal(current.canceledOrders, 1);
    assert.equal(current.cancellationRate, 0.25);
    assert.equal(String(JSON.stringify(json)).includes("revenue"), false);
    assert.equal(String(JSON.stringify(json)).includes("إيراد"), false);
  });

  it("compares against the previous equal-duration period and handles zero previous", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    const comparison = json.overview.comparison.totalOrders;
    assert.equal(comparison.previous, 0);
    assert.equal(comparison.current, 4);
    assert.equal(comparison.percentChange, null);
    assert.equal(comparison.kind, "new_activity");
    assert.equal(Number.isFinite(comparison.percentChange) || comparison.percentChange === null, true);
  });

  it("returns local ERP status distribution only", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/statuses?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    const statuses = json.statuses.items.map((item) => item.status);
    assert.equal(statuses.includes("Paid"), false);
    assert.equal(statuses.includes("Delivered"), false);
    assert.equal(statuses.includes("Fulfilled"), false);
    assert.equal(json.statuses.items.find((item) => item.status === "canceled").ordersCount, 1);
    assert.equal(json.statuses.items.find((item) => item.status === "Confirmed").ordersCount, 1);
  });

  it("keeps two Shopify stores separate and buckets manual/null source", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/stores?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    const items = json.stores.items;
    const storeA = items.find((item) => item.integrationId === SHOP_A);
    const storeB = items.find((item) => item.integrationId === SHOP_B);
    const manual = items.find((item) => item.integrationId == null);
    assert.equal(storeA.displayName, "Shopify Store A");
    assert.equal(storeA.provider, "shopify");
    assert.equal(storeA.ordersCount, 2);
    assert.equal(storeB.displayName, "Shopify Store B");
    assert.equal(storeB.ordersCount, 1);
    assert.equal(manual.displayName, "يدوي / قديم");
    assert.equal(manual.ordersCount, 1);
    assert.equal(items.some((item) => item.integrationId === OTHER_SHOP), false);
  });

  it("filters by exact store and rejects another company's integration", async () => {
    const ok = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z&source_integration_id=${SHOP_B}`,
      { token: tokenA() },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.json.overview.current.totalOrders, 1);
    assert.equal(ok.json.overview.current.grossOrderValue, 50);

    const foreign = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z&source_integration_id=${OTHER_SHOP}`,
      { token: tokenA() },
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.code, "INTEGRATION_NOT_FOUND");

    const invalid = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z&source_integration_id=not-a-uuid`,
      { token: tokenA() },
    );
    assert.equal(invalid.status, 400);
  });

  it("filters manual/legacy source_integration_id=null", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z&source_integration_id=manual`,
      { token: tokenA() },
    );
    assert.equal(json.overview.current.totalOrders, 1);
    assert.equal(json.overview.current.grossOrderValue, 80);
  });

  it("returns bounded top products from cart snapshots", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/products?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    assert.equal(json.products.truncated, false);
    assert.ok(json.products.items.length <= 10);
    const serum = json.products.items.find((item) => item.sku === "SER-1");
    assert.equal(serum.unitsSold, 3);
    assert.equal(serum.ordersCount, 2);
    assert.equal(serum.grossLineValue, 350);
  });

  it("returns daily trend buckets without raw orders", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/trend?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z&granularity=day`,
      { token: tokenA() },
    );
    assert.equal(json.trend.granularity, "day");
    assert.ok(Array.isArray(json.trend.points));
    assert.ok(json.trend.points.length >= 1);
    assert.ok(json.trend.points.length <= 32);
    const point = json.trend.points.find((row) => Number(row.ordersCount) > 0);
    assert.equal(point.ordersCount, 4);
    assert.equal(point.grossOrderValue, 480);
    assert.equal(json.trend.points.some((row) => row.raw_data), false);
  });

  it("returns empty analytics for a company with no orders", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/overview?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z`,
      { token: tokenA() },
    );
    assert.equal(json.overview.current.totalOrders, 0);
    assert.equal(json.overview.current.grossOrderValue, 0);
    assert.equal(json.overview.current.averageOrderValue, 0);
  });

  it("isolates tenants and ignores query companyId", async () => {
    const { json } = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z&companyId=${COMPANY_B}`,
      { token: tokenA() },
    );
    assert.equal(json.overview.current.totalOrders, 4);
    assert.equal(json.overview.current.grossOrderValue, 480);
  });

  it("rejects platform JWT and disabled analytics feature", async () => {
    const platform = signPlatformAdminToken({
      platformAdminId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      email: "platform@saas.local",
    });
    const blocked = await request("GET", "/api/analytics/overview", {
      token: platform,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, "JWT_WRONG_SCOPE");

    fake = seedClient({ analyticsEnabled: false, orders: SAMPLE_ORDERS });
    supabase.__setClientForTests(fake);
    const disabled = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    assert.equal(disabled.status, 403);
    assert.equal(disabled.json.code, "FEATURE_REQUIRED");
  });

  it("hides database errors from the client", async () => {
    fake.__db.__selectError = "relation orders boom secret";
    const { status, json, text } = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    assert.equal(status, 500);
    assert.equal(json.message, "Failed to load analytics");
    assert.equal(text.includes("relation orders boom secret"), false);
  });

  it("core overview/status/store queries are SQL aggregates without raw_data", async () => {
    await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    await request(
      "GET",
      `/api/analytics/statuses?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    await request(
      "GET",
      `/api/analytics/stores?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    const log = getAnalyticsQueryLog();
    const orderSelects = log.filter((entry) => entry.table === "orders");
    assert.ok(orderSelects.length > 0);
    for (const entry of orderSelects) {
      assert.match(String(entry.select), /count\(/);
      assert.equal(String(entry.select).includes("raw_data"), false);
      assert.ok(entry.returned <= 8);
    }
    const storeJoins = log.filter((entry) => entry.table === "company_integrations");
    assert.equal(storeJoins.length, 1);
  });

  it("does not call provider APIs", () => {
    const service = fs.readFileSync(
      path.join(__dirname, "../src/services/analytics.service.js"),
      "utf8",
    );
    assert.equal(service.includes("shopify.com"), false);
    assert.equal(service.includes("salla.sa"), false);
    assert.equal(service.includes("easy-orders"), false);
    assert.equal(service.includes("bosta.co"), false);
    assert.equal(service.includes("axios"), false);
  });

  it("aggregates 100 and 5,000 order datasets without returning raw rows", async () => {
    for (const size of [100, 5000]) {
      const many = [];
      for (let i = 0; i < size; i += 1) {
        many.push(
          orderRow({
            id: `n-${size}-${i}`,
            order_id: `n-ext-${size}-${i}`,
            total_amount: 20,
            created_at: "2026-09-18T10:00:00.000Z",
            raw_data: { skip: true },
          }),
        );
      }
      fake = seedClient({ orders: many });
      supabase.__setClientForTests(fake);
      resetAnalyticsQueryLog();
      const { status, json } = await request(
        "GET",
        `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
        { token: tokenA() },
      );
      assert.equal(status, 200);
      assert.equal(json.overview.current.totalOrders, size);
      const log = getAnalyticsQueryLog().filter((entry) => entry.table === "orders");
      assert.ok(log.length >= 1);
      for (const entry of log) {
        assert.ok(entry.returned < 20);
        assert.equal(String(entry.select).includes("raw_data"), false);
      }
    }
  });

  it("keeps payload size stable on a 50k-order dataset", async () => {
    const many = [];
    for (let i = 0; i < 50000; i += 1) {
      many.push(
        orderRow({
          id: `big-${i}`,
          order_id: `big-ext-${i}`,
          status: i % 10 === 0 ? "canceled" : "new",
          total_amount: 10,
          source_integration_id: i % 2 === 0 ? SHOP_A : SHOP_B,
          created_at: "2026-09-18T10:00:00.000Z",
          raw_data: { skip: true },
        }),
      );
    }
    fake = seedClient({ orders: many });
    supabase.__setClientForTests(fake);
    resetAnalyticsQueryLog();

    const started = Date.now();
    const overview = await request(
      "GET",
      `/api/analytics/overview?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    const stores = await request(
      "GET",
      `/api/analytics/stores?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    const elapsed = Date.now() - started;
    assert.equal(overview.status, 200);
    assert.equal(overview.json.overview.current.totalOrders, 50000);
    assert.equal(stores.json.stores.items.length, 2);
    const payloadSize = JSON.stringify(overview.json).length + JSON.stringify(stores.json).length;
    assert.ok(payloadSize < 8000, `payload ${payloadSize}`);
    const log = getAnalyticsQueryLog();
    for (const entry of log.filter((item) => item.table === "orders")) {
      assert.ok(entry.returned < 20, `returned ${entry.returned} rows`);
      assert.equal(String(entry.select).includes("raw_data"), false);
    }
    const timing = getLastAnalyticsTiming();
    assert.equal(typeof timing?.overview === "number" || typeof timing?.stores === "number", true);
    assert.ok(elapsed >= 0);
  });

  it("bounds top products even when more orders match", async () => {
    const many = [];
    for (let i = 0; i < 1600; i += 1) {
      many.push(
        orderRow({
          id: `p-${i}`,
          order_id: `p-ext-${i}`,
          created_at: "2026-09-18T10:00:00.000Z",
          raw_data: {
            cart_items: [
              { product_id: `sku-${i % 20}`, name: `Item ${i % 20}`, quantity: 1, price: 5 },
            ],
          },
        }),
      );
    }
    fake = seedClient({ orders: many });
    supabase.__setClientForTests(fake);
    const { json } = await request(
      "GET",
      `/api/analytics/products?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z`,
      { token: tokenA() },
    );
    assert.equal(json.products.truncated, true);
    assert.equal(json.products.bound, 1500);
    assert.ok(json.products.scannedOrders <= 1500);
    assert.ok(json.products.items.length <= 10);
  });
});
