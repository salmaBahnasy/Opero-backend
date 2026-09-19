process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-07";
process.env.ANALYTICS_TIMING = "1";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const {
  getJwtSecret,
  signEmployeeToken,
  signPlatformAdminToken,
} = require("../src/config/jwt");
const { decryptJson } = require("../src/config/integrationSecrets");
const {
  resetAnalyticsQueryLog,
  getAnalyticsQueryLog,
  MAX_TREND_BUCKETS,
} = require("../src/services/analytics.service");
const { clearDashboardCache } = require("../src/services/dashboardCache.service");
const { EASYORDERS_TIMEOUT_MS } = require("../src/services/easyorder.service");

const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEV_PASSWORD = "DevPassword123!";
const FEATURE = {
  orders: "f1111111-1111-4111-8111-111111111111",
  products: "f2222222-2222-4222-8222-222222222222",
  employees: "f3333333-3333-4333-8333-333333333333",
  analytics: "f4444444-4444-4444-8444-444444444444",
  bosta: "f5555555-5555-4555-8555-555555555555",
  imports: "f6666666-6666-4666-8666-666666666666",
};

let passwordHash;
let server;
let baseUrl;
let fake;
let capturedHttp = [];
const originalAxiosGet = axios.get;
const originalAxiosPost = axios.post;

async function request(method, pathname, { token, body, headers = {} } = {}) {
  const nextHeaders = { ...headers };
  if (token) nextHeaders.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    nextHeaders["Content-Type"] = nextHeaders["Content-Type"] || "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: nextHeaders,
    body: payload,
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

function platformToken() {
  return signPlatformAdminToken({
    platformAdminId: PLATFORM_ADMIN_ID,
    email: "platform@saas.local",
  });
}

function seedBase() {
  return createFakeSupabase({
    companies: [
      {
        id: COMPANY_B,
        name: "Beta Co",
        slug: "beta-co",
        is_active: true,
        deleted_at: null,
      },
    ],
    platform_admins: [
      {
        id: PLATFORM_ADMIN_ID,
        name: "Platform",
        email: "platform@saas.local",
        password: passwordHash,
        is_active: true,
      },
    ],
    employees: [
      {
        id: ADMIN_B,
        company_id: COMPANY_B,
        name: "Beta Admin",
        email: "admin@beta.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
    ],
    features: Object.entries(FEATURE).map(([key, id]) => ({
      id,
      key,
      name: key,
      is_active: true,
      group: key === "bosta" || key === "imports" ? "operational" : "core",
    })),
    company_features: [
      { company_id: COMPANY_B, feature_id: FEATURE.orders, is_enabled: true },
      { company_id: COMPANY_B, feature_id: FEATURE.products, is_enabled: true },
      { company_id: COMPANY_B, feature_id: FEATURE.employees, is_enabled: true },
      { company_id: COMPANY_B, feature_id: FEATURE.analytics, is_enabled: true },
      { company_id: COMPANY_B, feature_id: FEATURE.bosta, is_enabled: true },
      { company_id: COMPANY_B, feature_id: FEATURE.imports, is_enabled: false },
    ],
    products: [
      {
        id: "pb111111-1111-4111-8111-111111111111",
        company_id: COMPANY_B,
        name: "Beta Only Product",
        sku: "BETA-1",
        is_active: true,
      },
    ],
    orders: [
      {
        id: "b0b0b0b0-1111-4111-8111-111111111111",
        company_id: COMPANY_B,
        order_id: "beta-ext-1",
        order_reference: 2001,
        status: "new",
        customer_status: "pending",
        customer_name: "Beta Customer",
        customer_phone: "01111111111",
        total_amount: 99,
        created_at: "2026-09-18T10:00:00.000Z",
        raw_data: { cart_items: [{ name: "Secret", quantity: 1 }] },
      },
    ],
  });
}

function enableFeature(companyId, featureKey, enabled) {
  const featureId = FEATURE[featureKey];
  fake.__db.company_features = (fake.__db.company_features || []).filter(
    (item) =>
      !(
        String(item.company_id) === String(companyId) &&
        (String(item.feature_id) === String(featureId) ||
          String(item.feature_key) === featureKey)
      ),
  );
  fake.__db.company_features.push({
    id: `cf-${companyId}-${featureKey}`,
    company_id: companyId,
    feature_id: featureId,
    is_enabled: enabled,
  });
}

function assertNoSecrets(payload) {
  const blob = JSON.stringify(payload);
  assert.equal(blob.includes("shpat-"), false);
  assert.equal(blob.includes("easyorders-secret"), false);
  assert.equal(blob.includes("bosta-secret"), false);
  assert.equal(blob.includes("$2a$"), false);
  assert.equal(blob.includes("$2b$"), false);
  assert.equal(blob.toLowerCase().includes("stack"), false);
}

describe("Phase 14 MVP end-to-end QA (Enaya-like new customer)", () => {
  before(async () => {
    passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
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
      capturedHttp.push({ method: "GET", url, headers: config.headers || {} });
      if (String(url).includes("/inventory")) {
        return {
          status: 200,
          data: {
            data: [
              { skuCode: "BO-SKU-1", availableQuantity: 50, name: "Gold Serum" },
            ],
          },
        };
      }
      return { data: { id: "remote", status: "confirmed", data: { id: "remote", status: "confirmed" } } };
    };
    axios.post = async (url, body, config = {}) => {
      capturedHttp.push({
        method: "POST",
        url,
        body,
        headers: config.headers || {},
      });
      if (String(url).includes("myshopify.com")) {
        return { data: { data: { shop: { name: "Demo" } } } };
      }
      return {
        data: {
          success: true,
          data: {
            _id: "bosta-fulfillment-1",
            trackingNumber: "TRK-1",
            businessReference: "BR-1",
          },
        },
      };
    };
    fake = seedBase();
    supabase.__setClientForTests(fake);
    resetAnalyticsQueryLog();
    clearDashboardCache();
  });

  afterEach(() => {
    axios.get = originalAxiosGet;
    axios.post = originalAxiosPost;
  });

  it("signup → bootstrap → self-service integrations → products → orders → Bosta send → analytics", async () => {
    const signup = await request("POST", "/api/public/signup", {
      body: {
        name: "Salma Owner",
        email: "owner@enaya-like.test",
        password: "SignupPass123!",
        companyName: "Enaya Like Beauty",
        slug: "enaya-like",
      },
    });
    assert.equal(signup.status, 201, signup.json?.message);
    assert.equal(signup.json.success, true);
    assert.ok(signup.json.token);
    assert.equal(signup.json.data.employee.role, "company_admin");
    assert.equal(signup.json.data.employee.is_active, true);
    assert.equal(signup.json.data.company.slug, "enaya-like");

    const tokenPayload = jwt.verify(signup.json.token, getJwtSecret());
    assert.equal(tokenPayload.scope, "company");
    assert.equal(tokenPayload.role, "company_admin");
    assert.equal(tokenPayload.companyId, signup.json.data.company.id);
    assert.equal(tokenPayload.employeeId, signup.json.data.employee.id);
    assertNoSecrets(signup.json);

    const companyId = signup.json.data.company.id;
    const adminId = signup.json.data.employee.id;
    const adminToken = signup.json.token;

    // Real provision defaults: core features on, bosta/imports off until platform enables.
    for (const key of ["orders", "products", "employees", "analytics"]) {
      enableFeature(companyId, key, true);
    }
    enableFeature(companyId, "bosta", false);
    enableFeature(companyId, "imports", false);

    const login = await request("POST", "/api/employees/login", {
      body: {
        companySlug: "enaya-like",
        email: "owner@enaya-like.test",
        password: "SignupPass123!",
      },
    });
    assert.equal(login.status, 200, login.json?.message);
    assert.ok(login.json.token);

    const bootstrap = await request("GET", "/api/company/bootstrap", {
      token: adminToken,
    });
    assert.equal(bootstrap.status, 200, bootstrap.json?.message);
    assert.equal(bootstrap.json.data.company.id, companyId);
    assert.equal(bootstrap.json.data.company.slug, "enaya-like");
    assert.equal(bootstrap.json.data.employee.role, "company_admin");
    assert.equal(bootstrap.json.data.features.orders, true);
    assert.equal(bootstrap.json.data.features.bosta, false);
    assertNoSecrets(bootstrap.json);

    const emptyProducts = await request("GET", "/api/products?limit=20", {
      token: adminToken,
    });
    assert.equal(emptyProducts.status, 200);
    assert.equal(emptyProducts.json.data.length, 0);
    assert.equal(capturedHttp.length, 0);

    const emptyOrders = await request("GET", "/api/orders?limit=50", {
      token: adminToken,
    });
    assert.equal(emptyOrders.status, 200);
    assert.equal(emptyOrders.json.data.length, 0);
    assert.equal(emptyOrders.json.limit, 50);
    assert.equal(JSON.stringify(emptyOrders.json).includes('"raw_data"'), false);
    assert.equal(capturedHttp.length, 0);

    const shopify = await request("POST", "/api/company/integrations", {
      token: adminToken,
      body: {
        provider: "shopify",
        name: "Shopify Store 1",
        credentials: {
          shopDomain: "enaya-like.myshopify.com",
          accessToken: "shpat-company-token-aaaa",
        },
      },
    });
    assert.equal(shopify.status, 201, shopify.json?.message);
    assert.equal(shopify.json.data.provider, "shopify");
    assert.ok(shopify.json.data.id);
    assert.ok(shopify.json.data.webhookUrl);
    assertNoSecrets(shopify.json);

    const shopify2 = await request("POST", "/api/company/integrations", {
      token: adminToken,
      body: {
        provider: "shopify",
        name: "Shopify Store 2",
        credentials: {
          shopDomain: "enaya-like-b.myshopify.com",
          accessToken: "shpat-company-token-bbbb",
        },
      },
    });
    assert.equal(shopify2.status, 201, shopify2.json?.message);
    assert.notEqual(shopify.json.data.id, shopify2.json.data.id);

    const easy = await request("POST", "/api/company/integrations", {
      token: adminToken,
      body: {
        provider: "easyorders",
        name: "EasyOrders Store",
        credentials: { apiKey: "easyorders-secret-aaaa", apiBaseUrl: "https://evil.example" },
      },
    });
    assert.equal(easy.status, 201, easy.json?.message);
    const easySecrets = decryptJson(
      fake.__db.company_integrations.find((row) => row.id === easy.json.data.id)
        .credentials,
    );
    assert.equal(easySecrets.apiKey, "easyorders-secret-aaaa");
    assert.equal(Boolean(easySecrets.apiBaseUrl), false);
    assertNoSecrets(easy.json);

    const bosta = await request("POST", "/api/company/integrations", {
      token: adminToken,
      body: {
        provider: "bosta",
        name: "Bosta Main",
        credentials: {
          apiKey: "bosta-secret-aaaa",
          fulfillmentApiKey: "boost_aaaa",
        },
      },
    });
    assert.equal(bosta.status, 201, bosta.json?.message);
    assert.equal(bosta.json.data.provider, "bosta");
    assert.match(bosta.json.data.webhookUrl, /\/webhooks\/bosta\/.+\/order-status$/);
    assertNoSecrets(bosta.json);

    const staffCreate = await request("POST", "/api/employees", {
      token: adminToken,
      body: {
        name: "Ops Staff",
        email: "staff@enaya-like.test",
        password: "StaffPass123!",
        role: "employee",
      },
    });
    assert.equal(staffCreate.status, 201, staffCreate.json?.message);
    assert.equal(staffCreate.json.data.is_active ?? staffCreate.json.data.isActive, true);
    assert.equal(staffCreate.json.data.role, "employee");
    assert.equal(staffCreate.json.data.companyId ?? staffCreate.json.data.company_id, companyId);
    assertNoSecrets(staffCreate.json);

    const staffLogin = await request("POST", "/api/employees/login", {
      body: {
        companySlug: "enaya-like",
        email: "staff@enaya-like.test",
        password: "StaffPass123!",
      },
    });
    assert.equal(staffLogin.status, 200);
    const staffToken = staffLogin.json.token;

    const staffDenied = await request("POST", "/api/company/integrations", {
      token: staffToken,
      body: {
        provider: "shopify",
        name: "Should Fail",
        credentials: {
          shopDomain: "fail.myshopify.com",
          accessToken: "shpat-fail",
        },
      },
    });
    assert.equal(staffDenied.status, 403);

    const product = await request("POST", "/api/products", {
      token: adminToken,
      body: {
        name: "Gold Serum",
        sku: "SERUM-1",
        price: 250,
        quantity: 10,
      },
    });
    assert.equal(product.status, 201, product.json?.message);
    assert.equal(product.json.data.name, "Gold Serum");
    assert.equal(product.json.data.sku, "SERUM-1");
    const storedProduct = fake.__db.products.find((row) => row.id === product.json.data.id);
    assert.equal(storedProduct.company_id, companyId);

    const listedProducts = await request("GET", "/api/products?limit=20", {
      token: adminToken,
    });
    assert.equal(listedProducts.status, 200);
    assert.equal(listedProducts.json.data.length, 1);
    assert.equal(listedProducts.json.data[0].raw_data, undefined);
    assert.equal(listedProducts.json.data[0].variants, undefined);
    assert.equal(listedProducts.json.data[0].company_id, undefined);

    const options = await request("GET", "/api/products/options?q=Gold&limit=40", {
      token: adminToken,
    });
    assert.equal(options.status, 200);
    assert.ok(options.json.data.length <= 40);
    assert.equal(Object.prototype.hasOwnProperty.call(options.json.data[0], "raw_data"), false);

    const beforeCreateHttp = capturedHttp.length;
    const createdOrder = await request("POST", "/api/orders", {
      token: adminToken,
      body: {
        full_name: "Nour Customer",
        phone: "01012345678",
        address: "12 Nile St",
        city: "Cairo",
        district: "Nasr City",
        total: 250,
        status: "Confirmed",
        source_integration_id: shopify.json.data.id,
        cart_items: [
          {
            name: "Gold Serum",
            quantity: 1,
            price: 250,
            sku: "SERUM-1",
            product_id: product.json.data.id,
          },
        ],
      },
    });
    assert.ok(
      createdOrder.status === 201 || createdOrder.status === 200,
      createdOrder.json?.message,
    );
    const localOrderId =
      createdOrder.json.data?.id ||
      createdOrder.json.data?.localOrderId ||
      fake.__db.orders.find((row) => row.company_id === companyId)?.id;
    assert.ok(localOrderId);
    assert.equal(capturedHttp.length, beforeCreateHttp);

    const detailsHttpBefore = capturedHttp.length;
    const details = await request("GET", `/api/orders/${localOrderId}`, {
      token: adminToken,
    });
    assert.equal(details.status, 200, details.json?.message);
    assert.equal(capturedHttp.length, detailsHttpBefore);
    const detailBlob = JSON.stringify(details.json.data);
    assert.match(detailBlob, /Nour Customer|01012345678|Gold Serum|Confirmed/i);

    const statusUpdate = await request("PATCH", `/api/orders/${localOrderId}/status`, {
      token: adminToken,
      body: { status: "follow up" },
    });
    assert.ok(
      statusUpdate.status === 200 || statusUpdate.status === 201,
      statusUpdate.json?.message || String(statusUpdate.status),
    );

    const foreignOrder = await request(
      "GET",
      "/api/orders/b0b0b0b0-1111-4111-8111-111111111111",
      { token: adminToken },
    );
    assert.equal(foreignOrder.status, 404, JSON.stringify(foreignOrder.json));

    const foreignProduct = await request(
      "GET",
      "/api/products/pb111111-1111-4111-8111-111111111111",
      { token: adminToken },
    );
    assert.ok(
      foreignProduct.status === 404 || foreignProduct.status === 403,
      JSON.stringify(foreignProduct.json),
    );

    const betaToken = signEmployeeToken({
      employeeId: ADMIN_B,
      companyId: COMPANY_B,
      role: "company_admin",
      email: "admin@beta.local",
    });
    const betaList = await request("GET", "/api/orders", { token: betaToken });
    assert.equal(betaList.status, 200);
    assert.equal(
      (betaList.json.data || []).every((row) => String(row.id) !== String(localOrderId)),
      true,
    );
    assert.equal(
      (betaList.json.data || []).every(
        (row) => !String(row.customer_name || "").includes("Nour"),
      ),
      true,
    );

    // Bosta fulfillment requires feature enable (intentional platform gating).
    const sendBeforeFeature = await request(
      "POST",
      `/api/orders/${localOrderId}/send-to-bosta`,
      {
        token: adminToken,
        body: {
          shippingIntegrationId: bosta.json.data.id,
          cityId: "city-cairo",
          districtId: "dist-nasr",
        },
      },
    );
    assert.equal(sendBeforeFeature.status, 403);

    enableFeature(companyId, "bosta", true);

    const mapSku = await request("POST", "/api/bosta/sku-mappings", {
      token: adminToken,
      body: {
        shippingIntegrationId: bosta.json.data.id,
        catalogProductId: product.json.data.id,
        mappingType: "product",
        name: "Gold Serum",
        skus: ["BO-SKU-1"],
      },
    });
    assert.ok(
      mapSku.status === 201 || mapSku.status === 200,
      mapSku.json?.message || String(mapSku.status),
    );

    capturedHttp = [];
    const orderRow = fake.__db.orders.find((row) => String(row.id) === String(localOrderId));
    if (orderRow) {
      orderRow.status = "Confirmed";
      orderRow.raw_data = {
        ...(orderRow.raw_data && typeof orderRow.raw_data === "object" ? orderRow.raw_data : {}),
        full_name: "Nour Customer",
        phone: "01012345678",
        address: "12 Nile St",
        bosta_city_id: "city-cairo",
        bosta_district_id: "dist-nasr",
        cart_items: [
          {
            name: "Gold Serum",
            quantity: 1,
            price: 250,
            sku: "SERUM-1",
            product_id: product.json.data.id,
            catalogProductId: product.json.data.id,
          },
        ],
      };
    }

    const sent = await request("POST", `/api/orders/${localOrderId}/send-to-bosta`, {
      token: adminToken,
      body: {
        shippingIntegrationId: bosta.json.data.id,
        cityId: "city-cairo",
        districtId: "dist-nasr",
      },
    });
    assert.equal(sent.status, 200, sent.json?.message);
    const fulfillmentPosts = capturedHttp.filter(
      (entry) => entry.method === "POST" && String(entry.url).includes("/orders"),
    );
    assert.ok(fulfillmentPosts.length >= 1);
    assert.equal(fulfillmentPosts[0].headers["x-api-key"] || fulfillmentPosts[0].headers["Authorization"], "boost_aaaa");
    const inventoryGets = capturedHttp.filter(
      (entry) => entry.method === "GET" && String(entry.url).includes("/inventory"),
    );
    assert.ok(inventoryGets.length <= 2);

    resetAnalyticsQueryLog();
    clearDashboardCache();
    const overview = await request(
      "GET",
      "/api/analytics/overview?from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z",
      { token: adminToken },
    );
    assert.equal(overview.status, 200, overview.json?.message);
    assert.equal(JSON.stringify(overview.json).toLowerCase().includes("revenue"), false);

    resetAnalyticsQueryLog();
    const trend = await request(
      "GET",
      "/api/analytics/trend?from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z",
      { token: adminToken },
    );
    assert.equal(trend.status, 200, trend.json?.message);
    const trendAggs = getAnalyticsQueryLog().filter(
      (entry) => entry.table === "orders" && String(entry.select || "").includes("count("),
    );
    assert.ok(trendAggs.length <= MAX_TREND_BUCKETS);
    assert.ok((trend.json.trend?.points || []).length <= MAX_TREND_BUCKETS);

    clearDashboardCache();
    const costs = await request("GET", "/api/costs/chart?from=2026-09-01&to=2026-09-18", {
      token: adminToken,
    });
    assert.equal(costs.status, 200, costs.json?.message);
    assert.equal(costs.json.chart?.liveFilledDaysCount, 0);

    const rotate = await request(
      "POST",
      `/api/company/integrations/${shopify.json.data.id}/rotate-webhook`,
      { token: adminToken },
    );
    assert.equal(rotate.status, 200, rotate.json?.message);
    assert.ok(rotate.json.data.webhookUrl);
    const listed = await request("GET", `/api/company/integrations/${shopify.json.data.id}`, {
      token: adminToken,
    });
    assert.equal(listed.status, 200);
    assert.equal(Boolean(listed.json.data.webhookUrl), false);
    assertNoSecrets(listed.json);

    const platformList = await request("GET", "/api/platform/companies", {
      token: platformToken(),
    });
    assert.equal(platformList.status, 200);
    assert.ok((platformList.json.data || []).some((row) => row.slug === "enaya-like"));
    assertNoSecrets(platformList.json);

    const platformOverview = await request("GET", "/api/platform/integrations", {
      token: platformToken(),
    });
    assert.equal(platformOverview.status, 200);
    assert.ok(Array.isArray(platformOverview.json.data));
    assert.ok(
      platformOverview.json.data.some(
        (row) => String(row.companyId) === String(companyId) && row.provider === "shopify",
      ),
    );
    assertNoSecrets(platformOverview.json);

    enableFeature(companyId, "orders", false);
    const blockedOrders = await request("GET", "/api/orders", { token: adminToken });
    assert.equal(blockedOrders.status, 403);
    enableFeature(companyId, "orders", true);

    fake.__db.companies.find((row) => row.id === companyId).is_active = false;
    const deadJwt = await request("GET", "/api/company/bootstrap", { token: adminToken });
    assert.ok(deadJwt.status === 401 || deadJwt.status === 403);
    const deadLogin = await request("POST", "/api/employees/login", {
      body: {
        companySlug: "enaya-like",
        email: "owner@enaya-like.test",
        password: "SignupPass123!",
      },
    });
    assert.equal(deadLogin.status, 401);
    fake.__db.companies.find((row) => row.id === companyId).is_active = true;

    const staffRow = fake.__db.employees.find(
      (row) => row.email === "staff@enaya-like.test",
    );
    staffRow.is_active = false;
    const deactivatedStaff = await request("GET", "/api/orders", { token: staffToken });
    assert.ok(deactivatedStaff.status === 401 || deactivatedStaff.status === 403);

    assert.equal(EASYORDERS_TIMEOUT_MS, 15000);
    assert.equal(fs.existsSync(path.join(__dirname, "../supabase/migrations/016_anything.sql")), false);
    const migrations = fs.readdirSync(path.join(__dirname, "../supabase/migrations"));
    assert.equal(migrations.some((name) => name.startsWith("016")), false);
  });

  it("orders list clamps to 100 and never returns raw_data; local details make zero provider calls", async () => {
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const adminId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fake.__db.companies.push({
      id: companyId,
      name: "Clamp Co",
      slug: "clamp-co",
      is_active: true,
    });
    fake.__db.employees.push({
      id: adminId,
      company_id: companyId,
      name: "Clamp Admin",
      email: "admin@clamp.local",
      password: passwordHash,
      role: "company_admin",
      is_active: true,
    });
    for (const key of Object.keys(FEATURE)) {
      enableFeature(companyId, key, true);
    }
    for (let i = 0; i < 120; i += 1) {
      fake.__db.orders.push({
        id: `clamp-ord-${i}`,
        company_id: companyId,
        order_id: `ext-${i}`,
        status: "new",
        customer_status: "pending",
        customer_name: `C${i}`,
        customer_phone: `01000000${String(i).padStart(3, "0")}`,
        total_amount: 10,
        created_at: "2026-09-18T11:00:00.000Z",
        raw_data: { blob: "x".repeat(2000), cart_items: [{ name: "Item", quantity: 1 }] },
      });
    }
    const token = signEmployeeToken({
      employeeId: adminId,
      companyId,
      role: "company_admin",
      email: "admin@clamp.local",
    });
    capturedHttp = [];
    const list = await request("GET", "/api/orders?limit=5000", { token });
    assert.equal(list.status, 200);
    assert.ok(list.json.data.length <= 100);
    assert.equal(list.json.limit, 100);
    assert.equal(JSON.stringify(list.json.data).includes('"raw_data"'), false);
    assert.equal(capturedHttp.length, 0);

    const details = await request("GET", "/api/orders/clamp-ord-0", { token });
    assert.equal(details.status, 200);
    assert.equal(capturedHttp.length, 0);
  });

  it("frontend Getting Started / Settings / empty-state architecture remains self-service", () => {
    const feRoot = path.join(
      __dirname,
      "../../saas project companies frontend /src",
    );
    const gettingStarted = fs.readFileSync(
      path.join(feRoot, "pages/onboarding/GettingStartedPage.jsx"),
      "utf8",
    );
    assert.match(gettingStarted, /settingsHref\("integrations"\)/);
    assert.match(gettingStarted, /productsHref/);
    assert.match(gettingStarted, /RequireCompanyAdmin|أهلاً بك/);
    assert.equal(gettingStarted.includes("platform"), false);

    const settings = fs.readFileSync(
      path.join(feRoot, "pages/settings/settings.selfservice.test.js"),
      "utf8",
    );
    assert.match(settings, /company-admin APIs/);

    const products = fs.readFileSync(
      path.join(feRoot, "pages/products/ProductsPage.jsx"),
      "utf8",
    );
    assert.match(products, /Sync|مزامنة|إضافة/);
    assert.match(products, /loading="lazy"/);

    const app = fs.readFileSync(path.join(feRoot, "App.jsx"), "utf8");
    assert.match(app, /lazyPage/);
    assert.match(app, /getting-started/);
    assert.match(app, /settings\/integrations/);

    const orders = fs.readFileSync(
      path.join(feRoot, "pages/orders/OrdersPage.jsx"),
      "utf8",
    );
    assert.match(orders, /getProductOptions/);
    assert.equal(orders.includes("pendingCustomerStatusPass"), false);
    assert.match(orders, /handleRefreshCustomerStatus|refreshCustomerStatus/);

    const details = fs.readFileSync(
      path.join(feRoot, "pages/orders/OrderPayloadDetailsPage.jsx"),
      "utf8",
    );
    assert.equal(details.includes("refreshOnOpen"), false);
    assert.match(details, /تحديث حالة العميل/);

    const mainLayout = fs.readFileSync(
      path.join(feRoot, "layouts/MainLayout.jsx"),
      "utf8",
    );
    assert.match(mainLayout, /hasFeature\("bosta"\)/);
  });
});
