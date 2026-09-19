process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.BOSTA_API_KEY = "GLOBAL_BOSTA_SHOULD_NOT_BE_USED";
process.env.BOSTA_FULFILLMENT_API_KEY = "GLOBAL_BOSTA_FULFILLMENT_SHOULD_NOT_BE_USED";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken, signPlatformAdminToken } = require("../src/config/jwt");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROD_EGYPT_ID = "c1111111-1111-4111-8111-111111111111";
const PROD_KSA_ID = "c2222222-2222-4222-8222-222222222222";
const PROD_OTHER_ID = "c3333333-3333-4333-8333-333333333333";
const DEV_PASSWORD = "DevPassword123!";
const NOW = new Date().toISOString();

let passwordHash;
let server;
let baseUrl;
let fake;
let capturedHttp = [];
const originalAxiosGet = axios.get;
const originalAxiosPost = axios.post;

function tokenFromWebhookUrl(url) {
  const parts = String(url || "").split("/");
  const idx = parts.indexOf("webhooks");
  return idx >= 0 ? decodeURIComponent(parts[idx + 2] || "") : "";
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
  return { status: response.status, json };
}

function employeeToken(companyId, employeeId, email) {
  return signEmployeeToken({
    employeeId,
    companyId,
    role: "company_admin",
    email,
  });
}

const enayaToken = () =>
  employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
const otherToken = () =>
  employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");

function seedClient() {
  return createFakeSupabase({
    companies: [
      { id: ENAYA_ID, name: "Enaya", slug: "enaya", is_active: true, deleted_at: null },
      { id: OTHER_ID, name: "Other Co", slug: "other", is_active: true, deleted_at: null },
    ],
    platform_admins: [
      {
        id: PLATFORM_ADMIN_ID,
        name: "Platform Super Admin",
        email: "platform@saas.local",
        password: passwordHash,
        is_active: true,
      },
    ],
    employees: [
      {
        id: ENAYA_ADMIN_ID,
        company_id: ENAYA_ID,
        name: "Enaya Admin",
        email: "admin@enaya.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
      {
        id: OTHER_ADMIN_ID,
        company_id: OTHER_ID,
        name: "Other Admin",
        email: "admin@other.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
    ],
    products: [
      {
        id: PROD_EGYPT_ID,
        company_id: ENAYA_ID,
        easyorder_id: "123",
        name: "Egypt Cream",
        sku: "EG-1",
        synced_at: NOW,
      },
      {
        id: PROD_KSA_ID,
        company_id: ENAYA_ID,
        easyorder_id: "123",
        name: "KSA Cream",
        sku: "KSA-1",
        synced_at: NOW,
      },
      {
        id: PROD_OTHER_ID,
        company_id: OTHER_ID,
        easyorder_id: "123",
        name: "Other Cream",
        sku: "OTH-1",
        synced_at: NOW,
      },
    ],
    bosta_cities: [
      {
        id: "city-cairo",
        name: "Cairo",
        name_ar: "القاهرة",
        alias: "CAI",
        code: "CAI",
      },
    ],
    bosta_districts: [
      {
        id: "dist-nasr",
        city_id: "city-cairo",
        district_name: "Nasr City",
        district_other_name: "مدينة نصر",
      },
    ],
  });
}

async function loginPlatform() {
  const { status, json } = await request("POST", "/api/platform/auth/login", {
    body: { email: "platform@saas.local", password: DEV_PASSWORD },
  });
  assert.equal(status, 200);
  return json.token;
}

async function createConnection(token, companyId, body) {
  const { status, json } = await request(
    "POST",
    `/api/platform/companies/${companyId}/integrations`,
    { token, body },
  );
  assert.equal(status, 201, json?.message || "create connection failed");
  return json.data;
}

function stampProductSource(productId, sourceIntegrationId) {
  const row = fake.__db.products.find((item) => item.id === productId);
  assert.ok(row);
  row.source_integration_id = sourceIntegrationId;
}

function inventoryResponse() {
  return {
    status: 200,
    data: {
      data: [
        { skuCode: "bo-account-a", availableQuantity: 40, name: "Account A" },
        { skuCode: "bo-account-b", availableQuantity: 40, name: "Account B" },
      ],
    },
  };
}

before(async () => {
  passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  fake = seedClient();
  supabase.__setClientForTests(fake);
  capturedHttp = [];
  axios.get = async (url, config = {}) => {
    capturedHttp.push({ method: "GET", url, headers: config.headers || {} });
    const path = String(url || "").split("?")[0];
    if (path.includes("/inventory/products")) return inventoryResponse();
    return { status: 200, data: { data: [] } };
  };
  axios.post = async (url, body, config = {}) => {
    capturedHttp.push({
      method: "POST",
      url,
      headers: config.headers || {},
      body,
    });
    return { status: 200, data: { id: "bosta-fulfillment-1" } };
  };
});

afterEach(() => {
  axios.get = originalAxiosGet;
  axios.post = originalAxiosPost;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("Phase 7G Bosta multi-account shipping", () => {
  it("1-3. Company A cannot read Company B mappings; body companyId is ignored; platform JWT is rejected", async () => {
    const platform = await loginPlatform();
    const enayaBosta = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Enaya Bosta 1",
      credentials: { apiKey: "boost_enaya" },
    });
    await createConnection(platform, OTHER_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Other Bosta",
      credentials: { apiKey: "boost_other" },
    });

    const created = await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        company_id: OTHER_ID,
        companyId: OTHER_ID,
        shippingIntegrationId: enayaBosta.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Enaya attributed",
        skus: ["bo-account-a"],
      },
    });
    assert.equal(created.status, 201, created.json?.message);
    assert.equal(
      fake.__db.bosta_sku_mappings.every(
        (row) => row.name !== "Enaya attributed" || row.company_id === ENAYA_ID,
      ),
      true,
    );

    const otherList = await request("GET", "/api/bosta/sku-mappings", {
      token: otherToken(),
    });
    assert.equal(otherList.status, 200);
    assert.equal(otherList.json.data.productSkuMap[PROD_EGYPT_ID], undefined);
    assert.equal(
      (otherList.json.data.mappings || []).some((row) => row.name === "Enaya attributed"),
      false,
    );

    const platformJwt = signPlatformAdminToken({
      platformAdminId: PLATFORM_ADMIN_ID,
      email: "platform@saas.local",
    });
    const rejected = await request("GET", "/api/bosta/sku-mappings", {
      token: platformJwt,
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.json.code, "JWT_WRONG_SCOPE");
  });

  it("4-6. shipping UUID / other-company / wrong category-provider use the safe error contract", async () => {
    const platform = await loginPlatform();
    const commerce = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "eo-secret" },
    });
    const otherBosta = await createConnection(platform, OTHER_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Other Bosta",
      credentials: { apiKey: "boost_other" },
    });
    await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Enaya Bosta",
      credentials: { apiKey: "boost_enaya" },
    });

    const malformed = await request(
      "GET",
      "/api/bosta/sku-mappings?shippingIntegrationId=not-a-uuid",
      { token: enayaToken() },
    );
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, "INVALID_SHIPPING_INTEGRATION");

    const otherCompany = await request(
      "GET",
      `/api/bosta/sku-mappings?shippingIntegrationId=${otherBosta.id}`,
      { token: enayaToken() },
    );
    assert.equal(otherCompany.status, 404);
    assert.equal(otherCompany.json.code, "INTEGRATION_NOT_FOUND");

    const wrongCategory = await request(
      "GET",
      `/api/bosta/sku-mappings?shippingIntegrationId=${commerce.id}`,
      { token: enayaToken() },
    );
    assert.equal(wrongCategory.status, 404);
    assert.equal(wrongCategory.json.code, "INTEGRATION_NOT_FOUND");
  });

  it("7-9 and 23. 0/1/2+ Bosta accounts never silently pick the first of many", async () => {
    const none = await request("GET", "/api/bosta/sku-mappings", {
      token: enayaToken(),
    });
    assert.equal(none.status, 409);
    assert.equal(none.json.code, "INTEGRATION_NOT_CONFIGURED");

    const platform = await loginPlatform();
    const first = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Only Bosta",
      credentials: { apiKey: "boost_one" },
    });
    const auto = await request("GET", "/api/bosta/sku-mappings", {
      token: enayaToken(),
    });
    assert.equal(auto.status, 200);
    assert.equal(auto.json.data.shippingIntegrationId, first.id);

    const second = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Second Bosta",
      credentials: { apiKey: "boost_two" },
    });
    const ambiguous = await request("GET", "/api/bosta/sku-mappings", {
      token: enayaToken(),
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "INTEGRATION_AMBIGUOUS");

    const explicit = await request(
      "GET",
      `/api/bosta/sku-mappings?shippingIntegrationId=${second.id}`,
      { token: enayaToken() },
    );
    assert.equal(explicit.status, 200);
    assert.equal(explicit.json.data.shippingIntegrationId, second.id);
    assert.notEqual(explicit.json.data.shippingIntegrationId, first.id);
  });

  it("10-13. mappings and unmapped state are per Bosta account and catalog product UUID", async () => {
    const platform = await loginPlatform();
    const egyptStore = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "eo-eg" },
    });
    const ksaStore = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders KSA",
      credentials: { apiKey: "eo-ksa" },
    });
    stampProductSource(PROD_EGYPT_ID, egyptStore.id);
    stampProductSource(PROD_KSA_ID, ksaStore.id);
    const bostaA = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta Account 1",
      credentials: { apiKey: "boost_aaaa" },
    });
    const bostaB = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta Account 2",
      credentials: { apiKey: "boost_bbbb" },
    });

    const mapA = await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Egypt on A",
        skus: ["bo-account-a"],
      },
    });
    const mapB = await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaB.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Egypt on B",
        skus: ["bo-account-b"],
      },
    });
    assert.equal(mapA.status, 201, mapA.json?.message);
    assert.equal(mapB.status, 201, mapB.json?.message);

    const ksaMap = await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        catalogProductId: PROD_KSA_ID,
        mappingType: "product",
        name: "KSA on A",
        skus: ["bo-account-a"],
      },
    });
    assert.equal(ksaMap.status, 201, ksaMap.json?.message);

    const variantA = await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "variant",
        entityId: "var-123",
        name: "Egypt variant",
        skus: ["bo-account-a"],
      },
    });
    const variantKsa = await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        catalogProductId: PROD_KSA_ID,
        mappingType: "variant",
        entityId: "var-123",
        name: "KSA variant",
        skus: ["bo-account-a"],
      },
    });
    assert.equal(variantA.status, 201, variantA.json?.message);
    assert.equal(variantKsa.status, 201, variantKsa.json?.message);

    fake.__db.bosta_unmapped_products.push(
      {
        id: "unmap-a",
        company_id: ENAYA_ID,
        shipping_integration_id: bostaA.id,
        catalog_product_id: PROD_KSA_ID,
        product_id: "123",
        name: "Unmapped on A",
        reason: "missing sku",
      },
      {
        id: "unmap-b",
        company_id: ENAYA_ID,
        shipping_integration_id: bostaB.id,
        catalog_product_id: PROD_EGYPT_ID,
        product_id: "123",
        name: "Unmapped on B",
        reason: "missing sku",
      },
    );

    const listedA = await request(
      "GET",
      `/api/bosta/sku-mappings?shippingIntegrationId=${bostaA.id}`,
      { token: enayaToken() },
    );
    const listedB = await request(
      "GET",
      `/api/bosta/sku-mappings?shippingIntegrationId=${bostaB.id}`,
      { token: enayaToken() },
    );
    assert.equal(listedA.json.data.productSkuMap[PROD_EGYPT_ID].skus[0], "bo-account-a");
    assert.equal(listedB.json.data.productSkuMap[PROD_EGYPT_ID].skus[0], "bo-account-b");
    assert.equal(listedA.json.data.productSkuMap[PROD_KSA_ID].name, "KSA on A");
    assert.equal(listedB.json.data.productSkuMap[PROD_KSA_ID], undefined);
    assert.equal(
      listedA.json.data.unmappedProducts.some((row) => row.catalogProductId === PROD_KSA_ID),
      true,
    );
    assert.equal(
      listedB.json.data.unmappedProducts.some((row) => row.catalogProductId === PROD_EGYPT_ID),
      true,
    );
    assert.equal(
      listedA.json.data.unmappedProducts.some((row) => row.catalogProductId === PROD_EGYPT_ID),
      false,
    );
  });

  it("14-15. import targets one Bosta account and rejects ambiguous external ids", async () => {
    const platform = await loginPlatform();
    const egyptStore = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "eo-eg" },
    });
    const ksaStore = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders KSA",
      credentials: { apiKey: "eo-ksa" },
    });
    stampProductSource(PROD_EGYPT_ID, egyptStore.id);
    stampProductSource(PROD_KSA_ID, ksaStore.id);
    const bostaA = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta A",
      credentials: { apiKey: "boost_aaaa" },
    });
    const bostaB = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta B",
      credentials: { apiKey: "boost_bbbb" },
    });

    await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaB.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Keep B",
        skus: ["bo-account-b"],
      },
    });

    const imported = await request("POST", "/api/bosta/sku-mappings/import", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        sourceIntegrationId: egyptStore.id,
        productSkuMap: {
          123: { name: "Imported Egypt", skus: ["bo-account-a"] },
        },
      },
    });
    assert.equal(imported.status, 200, imported.json?.message);
    assert.equal(
      fake.__db.bosta_sku_mappings.some(
        (row) =>
          row.shipping_integration_id === bostaB.id &&
          row.catalog_product_id === PROD_EGYPT_ID &&
          row.name === "Keep B",
      ),
      true,
    );

    const ambiguous = await request("POST", "/api/bosta/sku-mappings/import", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        productSkuMap: {
          123: { name: "Ambiguous", skus: ["bo-account-a"] },
        },
      },
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "IMPORT_PRODUCT_AMBIGUOUS");
  });

  it("16-17. send-to-Bosta uses the selected account mappings and persists shipping_integration_id immediately", async () => {
    const platform = await loginPlatform();
    const egyptStore = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "eo-eg" },
    });
    stampProductSource(PROD_EGYPT_ID, egyptStore.id);
    const bostaA = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta A",
      credentials: { apiKey: "boost_aaaa" },
    });
    const bostaB = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta B",
      credentials: { apiKey: "boost_bbbb" },
    });
    await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Egypt A",
        skus: ["bo-account-a"],
      },
    });
    await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaB.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Egypt B",
        skus: ["bo-account-b"],
      },
    });

    fake.__db.orders.push({
      id: "ord-send",
      company_id: ENAYA_ID,
      order_id: "send-order-1",
      status: "Confirmed",
      source_integration_id: egyptStore.id,
      shipping_integration_id: null,
      created_at: NOW,
      raw_data: {
        full_name: "Send Customer",
        phone: "01000000000",
        address: "102 street mohamed abd el shafy",
        bosta_city_id: "city-cairo",
        bosta_district_id: "dist-nasr",
        cart_items: [
          {
            product_id: "123",
            product: { id: "123", name: "Egypt Cream" },
            quantity: 1,
            price: 150,
          },
        ],
      },
    });

    const missingAccount = await request(
      "POST",
      "/api/orders/send-order-1/send-to-bosta",
      {
        token: enayaToken(),
        body: { cityId: "city-cairo", districtId: "dist-nasr" },
      },
    );
    assert.equal(missingAccount.status, 409);
    assert.equal(missingAccount.json.code, "INTEGRATION_AMBIGUOUS");

    const sent = await request("POST", "/api/orders/send-order-1/send-to-bosta", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bostaA.id,
        cityId: "city-cairo",
        districtId: "dist-nasr",
      },
    });
    assert.equal(sent.status, 200, sent.json?.message);
    const order = fake.__db.orders.find((row) => row.order_id === "send-order-1");
    assert.equal(order.shipping_integration_id, bostaA.id);
    const fulfillmentPost = capturedHttp.find(
      (entry) => entry.method === "POST" && String(entry.url).includes("/orders"),
    );
    assert.ok(fulfillmentPost);
    assert.equal(fulfillmentPost.headers["x-api-key"], "boost_aaaa");
    assert.equal(fulfillmentPost.body.items[0].skuCode, "bo-account-a");
  });

  it("18-19. Bosta webhook cannot switch tenant and cannot overwrite a different shipping integration", async () => {
    const platform = await loginPlatform();
    const bostaA = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta A",
      credentials: { apiKey: "boost_aaaa" },
    });
    const bostaB = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta B",
      credentials: { apiKey: "boost_bbbb" },
    });
    fake.__db.orders.push({
      id: "ord-wh",
      company_id: ENAYA_ID,
      order_id: "ALIAS-LOCKED",
      status: "Shipped",
      shipping_integration_id: bostaA.id,
      created_at: NOW,
      raw_data: {
        bosta_order_alias: "ALIAS-LOCKED",
        full_name: "Locked order",
      },
    });

    const tokenA = tokenFromWebhookUrl(bostaA.webhookUrl);
    const tokenB = tokenFromWebhookUrl(bostaB.webhookUrl);

    const tenantAttempt = await request(
      "POST",
      `/webhooks/bosta/${tokenA}/order-status`,
      {
        body: {
          orderAlias: "ALIAS-LOCKED",
          status: "Delivered",
          company_id: OTHER_ID,
          companyId: OTHER_ID,
        },
      },
    );
    assert.equal(tenantAttempt.status, 200, tenantAttempt.json?.message);
    const afterTenant = fake.__db.orders.find((row) => row.order_id === "ALIAS-LOCKED");
    assert.equal(afterTenant.company_id, ENAYA_ID);
    assert.equal(afterTenant.shipping_integration_id, bostaA.id);

    const mismatch = await request(
      "POST",
      `/webhooks/bosta/${tokenB}/order-status`,
      {
        body: { orderAlias: "ALIAS-LOCKED", status: "Delivered" },
      },
    );
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.code, "SHIPPING_INTEGRATION_MISMATCH");
    const afterMismatch = fake.__db.orders.find((row) => row.order_id === "ALIAS-LOCKED");
    assert.equal(afterMismatch.shipping_integration_id, bostaA.id);
  });

  it("20. legacy NULL mappings are not assigned to an explicitly selected Bosta account", async () => {
    const platform = await loginPlatform();
    const bostaA = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta A",
      credentials: { apiKey: "boost_aaaa" },
    });
    fake.__db.bosta_sku_mappings.push({
      id: "legacy-row",
      company_id: ENAYA_ID,
      shipping_integration_id: null,
      catalog_product_id: null,
      mapping_type: "product",
      entity_id: "123",
      name: "Legacy company-wide",
      skus: ["bo-legacy"],
    });

    const listed = await request(
      "GET",
      `/api/bosta/sku-mappings?shippingIntegrationId=${bostaA.id}`,
      { token: enayaToken() },
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.productSkuMap[PROD_EGYPT_ID], undefined);
    assert.equal(
      (listed.json.data.mappings || []).some((row) => row.name === "Legacy company-wide"),
      false,
    );
    assert.equal(
      (listed.json.data.legacyMappings || []).some(
        (row) => row.name === "Legacy company-wide",
      ),
      true,
    );
  });

  it("21-22. cities require company auth + bosta feature; unauthenticated location sync is rejected", async () => {
    const openCities = await request("GET", "/api/bosta/cities");
    assert.equal(openCities.status, 401);
    const cities = await request("GET", "/api/bosta/cities", { token: enayaToken() });
    assert.equal(cities.status, 200);
    const list = cities.json.data?.list || [];
    assert.equal(
      (Array.isArray(list) ? list : []).some(
        (row) => row._id === "city-cairo" || row.nameAr === "القاهرة" || row.name === "Cairo",
      ),
      true,
    );

    const openSync = await request("POST", "/api/bosta/locations/sync");
    assert.equal(openSync.status, 401);

    const employeeSync = await request("POST", "/api/bosta/locations/sync", {
      token: enayaToken(),
    });
    assert.equal(employeeSync.status, 403);

    const mylerz = await request("POST", "/webhooks/mylerz/token-placeholder/order-status", {
      body: { orderAlias: "X" },
    });
    assert.equal(mylerz.status, 501);
    assert.equal(mylerz.json.code, "SHIPPING_PROVIDER_NOT_IMPLEMENTED");
  });
});
