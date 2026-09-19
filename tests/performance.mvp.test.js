process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ANALYTICS_TIMING = "1";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

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
  MAX_TREND_BUCKETS,
  TOP_PRODUCTS_SCAN_CAP,
  TOP_PRODUCTS_LIMIT,
} = require("../src/services/analytics.service");
const { clearDashboardCache } = require("../src/services/dashboardCache.service");
const { EASYORDERS_TIMEOUT_MS } = require("../src/services/easyorder.service");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SHOP_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BOSTA_A = "bbbbbbbb-1111-4111-8111-111111111111";
const PRODUCT_A = "p1111111-1111-4111-8111-111111111111";
const ORDER_A = "o1111111-1111-4111-8111-111111111111";

let server;
let baseUrl;
let fake;
const originalAxiosGet = axios.get;
let capturedHttp = [];

function tokenA() {
  return signEmployeeToken({
    employeeId: ADMIN_A,
    companyId: COMPANY_A,
    role: "company_admin",
    email: "admin@a.local",
  });
}

function platformToken() {
  return signPlatformAdminToken({
    platformAdminId: PLATFORM_ADMIN_ID,
    email: "platform@saas.local",
  });
}

async function request(method, pathName, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathName}`, {
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
  return { status: response.status, json, text, byteLength: Buffer.byteLength(text) };
}

function hugeRaw() {
  return {
    provider_blob: "x".repeat(8000),
    cart_items: [
      { name: "Serum", quantity: 1, sku: "SER-1", variation_prop: "50ml" },
      { name: "Cream", quantity: 2, sku: "CRM-1" },
    ],
  };
}

function seed({ extraOrders = [], extraProducts = [] } = {}) {
  const orders = [
    {
      id: ORDER_A,
      company_id: COMPANY_A,
      order_id: "ext-local-1",
      order_reference: 1001,
      status: "new",
      customer_status: "pending",
      customer_name: "Local Customer",
      customer_phone: "01000000000",
      shipping_status: "in_progress",
      total_amount: 120,
      source_integration_id: SHOP_A,
      assigned_employee_id: ADMIN_A,
      created_at: "2026-09-18T10:00:00.000Z",
      raw_data: hugeRaw(),
    },
    ...extraOrders,
  ];
  const products = [
    {
      id: PRODUCT_A,
      company_id: COMPANY_A,
      name: "Serum Gold",
      sku: "SER-1",
      easyorder_id: "eo-ser-1",
      source_integration_id: SHOP_A,
      is_active: true,
      raw_data: { variants: [{ id: "v1", blob: "y".repeat(4000) }], thumb: "https://img.test/s.png" },
    },
    ...extraProducts,
  ];
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
    ],
    platform_admins: [
      {
        id: PLATFORM_ADMIN_ID,
        name: "Platform",
        email: "platform@saas.local",
        is_active: true,
      },
    ],
    company_integrations: [
      {
        id: SHOP_A,
        company_id: COMPANY_A,
        provider: "shopify",
        category: "commerce",
        name: "Store A",
        is_enabled: true,
      },
      {
        id: BOSTA_A,
        company_id: COMPANY_A,
        provider: "bosta",
        category: "shipping",
        name: "Bosta A",
        is_enabled: true,
      },
      {
        id: "int-b",
        company_id: COMPANY_B,
        provider: "salla",
        category: "commerce",
        name: "Store B",
        is_enabled: true,
      },
    ],
    products,
    orders,
    bosta_sku_mappings: [
      {
        id: "map-1",
        company_id: COMPANY_A,
        catalog_product_id: PRODUCT_A,
        shipping_integration_id: BOSTA_A,
        mapping_type: "product",
        entity_id: PRODUCT_A,
        name: "Serum Gold",
        skus: ["BO-1"],
      },
    ],
    order_cost_daily: [
      {
        id: "cost-1",
        company_id: COMPANY_A,
        cost_date: "2026-09-18",
        expense: 40,
        total_orders: 2,
        shipped_orders: 0,
        successful_orders: 0,
        total_sales: 20,
        shipped_sales: 0,
        successful_sales: 0,
      },
    ],
  });
}

describe("Phase 13B performance architecture", () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    supabase.__setClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    capturedHttp = [];
    axios.get = async (url, config = {}) => {
      capturedHttp.push({ url, headers: config.headers || {} });
      return { data: { id: "remote", status: "confirmed" } };
    };
    fake = seed();
    supabase.__setClientForTests(fake);
    resetAnalyticsQueryLog();
    clearDashboardCache();
  });

  afterEach(() => {
    axios.get = originalAxiosGet;
  });

  it("GET /api/orders?limit=5000 returns at most 100 rows and no raw_data", async () => {
    const extraOrders = [];
    for (let i = 0; i < 120; i += 1) {
      extraOrders.push({
        id: `ord-${i}`,
        company_id: COMPANY_A,
        order_id: `ext-${i}`,
        status: "new",
        customer_status: "pending",
        customer_name: `C${i}`,
        customer_phone: `01000000${String(i).padStart(3, "0")}`,
        total_amount: 10,
        created_at: "2026-09-18T11:00:00.000Z",
        raw_data: hugeRaw(),
      });
    }
    fake = seed({ extraOrders });
    supabase.__setClientForTests(fake);

    const { status, json, byteLength } = await request(
      "GET",
      "/api/orders?limit=5000",
      { token: tokenA() },
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.data.length <= 100);
    assert.equal(json.limit, 100);
    const payload = JSON.stringify(json.data);
    assert.equal(payload.includes('"raw_data"'), false);
    assert.ok(byteLength < 250_000, `list payload ${byteLength} bytes`);
    const listSelects = fake.__queryLog.filter(
      (entry) =>
        entry.table === "orders" &&
        entry.action === "select" &&
        String(entry.columns || "").includes("customer_status"),
    );
    assert.ok(listSelects.length >= 1);
    for (const entry of listSelects) {
      assert.notEqual(String(entry.columns).trim(), "*");
    }
  });

  it("GET local order details makes zero provider HTTP calls", async () => {
    const { status, json } = await request("GET", `/api/orders/${ORDER_A}`, {
      token: tokenA(),
    });
    assert.equal(status, 200);
    assert.equal(capturedHttp.length, 0);
    assert.equal(json.data.customer_status || json.data.customerStatus, "pending");
    const productGets = fake.__queryLog.filter(
      (entry) => entry.table === "products",
    );
    assert.equal(productGets.length, 0);
  });

  it("Bosta SKU options skip inventory HTTP by default", async () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../src/services/bostaSkuMappings.service.js"),
      "utf8",
    );
    assert.match(src, /includeInventory === true/);
    assert.match(src, /if \(!inventoryDetailsMap\)/);
    assert.equal(src.includes("fetchBostaInventoryDetailsMap()"), true);
    const controller = fs.readFileSync(
      path.join(__dirname, "../src/controllers/bostaSkuMappings.controller.js"),
      "utf8",
    );
    assert.match(controller, /includeInventory/);
    const fulfillment = fs.readFileSync(
      path.join(__dirname, "../src/services/bostaFulfillment.service.js"),
      "utf8",
    );
    assert.match(fulfillment, /validateOrderLinesInventory/);
  });

  it("GET /api/products clamps limit to 100 and omits raw_data", async () => {
    const extraProducts = [];
    for (let i = 0; i < 130; i += 1) {
      extraProducts.push({
        id: `prod-${i}`,
        company_id: COMPANY_A,
        name: `Product ${i}`,
        sku: `SKU-${i}`,
        raw_data: { blob: "z".repeat(2000), variants: [{ n: i }] },
      });
    }
    fake = seed({ extraProducts });
    supabase.__setClientForTests(fake);
    const { status, json } = await request(
      "GET",
      "/api/products?limit=5000",
      { token: tokenA() },
    );
    assert.equal(status, 200);
    assert.ok(json.data.length <= 100);
    assert.equal(json.limit, 100);
    for (const row of json.data) {
      assert.equal(row.raw_data, undefined);
      assert.equal(row.variants, undefined);
    }
  });

  it("product options search is bounded and lightweight", async () => {
    const extraProducts = [];
    for (let i = 0; i < 80; i += 1) {
      extraProducts.push({
        id: `serum-${i}`,
        company_id: COMPANY_A,
        name: `Serum ${i}`,
        sku: `SER-${i}`,
        raw_data: { blob: "nope".repeat(500) },
      });
    }
    fake = seed({ extraProducts });
    supabase.__setClientForTests(fake);
    const { status, json } = await request(
      "GET",
      "/api/products/options?q=Serum&limit=40",
      { token: tokenA() },
    );
    assert.equal(status, 200);
    assert.ok(json.data.length <= 40);
    for (const row of json.data) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "raw_data"), false);
      assert.ok(row.id);
      assert.ok("name" in row);
      assert.ok("sku" in row);
    }
  });

  it("EasyOrders outbound timeout is bounded at 15s", () => {
    assert.equal(EASYORDERS_TIMEOUT_MS, 15000);
    const src = fs.readFileSync(
      path.join(__dirname, "../src/services/easyorder.service.js"),
      "utf8",
    );
    assert.match(src, /timeout: EASYORDERS_TIMEOUT_MS/);
    assert.match(src, /maxRedirects: 0/);
  });

  it("analytics trend stays within 32 bounded aggregates", async () => {
    const { status, json } = await request(
      "GET",
      "/api/analytics/trend?from=2026-08-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z",
      { token: tokenA() },
    );
    assert.equal(status, 200);
    const log = getAnalyticsQueryLog().filter(
      (entry) => entry.table === "orders" && String(entry.select || "").includes("count("),
    );
    assert.ok(log.length <= MAX_TREND_BUCKETS);
    assert.ok((json.trend?.points || []).length <= MAX_TREND_BUCKETS);
  });

  it("top products remains bounded and independent", async () => {
    const extraOrders = [];
    for (let i = 0; i < 100; i += 1) {
      extraOrders.push({
        id: `top-${i}`,
        company_id: COMPANY_A,
        order_id: `top-ext-${i}`,
        status: "new",
        total_amount: 10,
        created_at: "2026-09-18T12:00:00.000Z",
        raw_data: {
          cart_items: [{ name: `P${i % 12}`, quantity: 1, sku: `S${i % 12}` }],
        },
      });
    }
    fake = seed({ extraOrders });
    supabase.__setClientForTests(fake);
    resetAnalyticsQueryLog();
    const { status, json } = await request(
      "GET",
      "/api/analytics/products?from=2026-09-18T00:00:00.000Z&to=2026-09-18T23:59:59.999Z",
      { token: tokenA() },
    );
    assert.equal(status, 200);
    assert.ok((json.products?.items || []).length <= TOP_PRODUCTS_LIMIT);
    assert.ok((json.products?.scannedOrders || 0) <= TOP_PRODUCTS_SCAN_CAP);
    assert.equal(capturedHttp.length, 0);
  });

  it("normal costs chart does not scan orders when daily rows are missing", async () => {
    const extraOrders = [];
    for (let i = 0; i < 100; i += 1) {
      extraOrders.push({
        id: `cost-order-${i}`,
        company_id: COMPANY_A,
        order_id: `cost-ext-${i}`,
        status: "new",
        total_amount: 5,
        created_at: "2026-09-01T10:00:00.000Z",
        raw_data: hugeRaw(),
      });
    }
    fake = seed({ extraOrders });
    supabase.__setClientForTests(fake);
    clearDashboardCache();
    const before = fake.__queryLog.length;
    const { status, json } = await request(
      "GET",
      "/api/costs/chart?from=2026-09-01&to=2026-09-18",
      { token: tokenA() },
    );
    assert.equal(status, 200, json?.message);
    assert.equal(json.chart?.liveFilledDaysCount, 0);
    assert.equal(json.chart?.historicalGap, true);
    const after = fake.__queryLog.slice(before);
    const orderReads = after.filter(
      (entry) => entry.table === "orders" && entry.action === "select",
    );
    assert.equal(orderReads.length, 0);
  });

  it("legacy stats stay bounded rather than scanning 50k rows", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../src/services/webhookOrders.service.js"),
      "utf8",
    );
    assert.match(src, /MAX_STATS_ROWS = 1500/);
    assert.match(src, /MAX_ORDER_COST_ROWS = 1500/);
    assert.equal(src.includes("50000"), false);
    assert.equal(src.includes("50_000"), false);
  });

  it("platform integrations overview is one batched request without credentials", async () => {
    const { status, json } = await request("GET", "/api/platform/integrations", {
      token: platformToken(),
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.data.length >= 2);
    const payload = JSON.stringify(json.data);
    assert.equal(payload.includes("shpat"), false);
    assert.equal(payload.includes("credentials"), false);
    const companyReads = fake.__queryLog.filter(
      (entry) => entry.table === "companies" && entry.action === "select",
    );
    const integrationReads = fake.__queryLog.filter(
      (entry) =>
        entry.table === "company_integrations" && entry.action === "select",
    );
    assert.ok(companyReads.length <= 2);
    assert.ok(integrationReads.length <= 2);
  });

  it("100 / 5,000 logical fixtures remain list-capped; 50k is not a live scan path", async () => {
    const extraOrders = [];
    for (let i = 0; i < 100; i += 1) {
      extraOrders.push({
        id: `n100-${i}`,
        company_id: COMPANY_A,
        order_id: `n100-ext-${i}`,
        status: "new",
        created_at: "2026-09-18T10:00:00.000Z",
        raw_data: hugeRaw(),
      });
    }
    fake = seed({ extraOrders });
    supabase.__setClientForTests(fake);
    const hundred = await request("GET", "/api/orders?limit=100", { token: tokenA() });
    assert.equal(hundred.status, 200);
    assert.ok(hundred.json.data.length <= 100);

    const src = fs.readFileSync(
      path.join(__dirname, "../src/utils/listPagination.js"),
      "utf8",
    );
    assert.match(src, /MAX_LIST_LIMIT = 100/);
    const costs = fs.readFileSync(
      path.join(__dirname, "../src/services/orderCostDaily.service.js"),
      "utf8",
    );
    assert.match(costs, /database_partial/);
    assert.match(costs, /liveFilledDaysCount: 0/);
  });
});
