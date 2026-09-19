process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.EASYORDER_API_KEY = "GLOBAL_EASYORDERS_SHOULD_NOT_BE_USED";
process.env.EASYORDER_API_BASE_URL =
  "https://api.easy-orders.net/api/v1/external-apps";
process.env.BOSTA_API_KEY = "GLOBAL_BOSTA_SHOULD_NOT_BE_USED";
process.env.BOSTA_FULFILLMENT_API_KEY =
  "GLOBAL_BOSTA_FULFILLMENT_SHOULD_NOT_BE_USED";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROD_EGYPT_ID = "c1111111-1111-4111-8111-111111111111";
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

function ordersByExternalId(externalId) {
  return fake.__db.orders.filter((row) => row.order_id === String(externalId));
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
    if (path.includes("/inventory/products")) {
      return {
        status: 200,
        data: {
          data: [{ skuCode: "bo-account-a", availableQuantity: 40, name: "Account A" }],
        },
      };
    }
    const orderId = String(url || "").split("/orders/")[1] || "";
    return {
      status: 200,
      data: { id: orderId, short_id: "1001", status: "confirmed" },
    };
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

describe("order identity runtime compatibility", () => {
  it("1. same company + same source + order_id updates the same local row", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const token = tokenFromWebhookUrl(shop.webhookUrl);
    const first = await request("POST", `/webhooks/easyorders/${token}/order-created`, {
      body: { id: "1001", full_name: "First" },
    });
    const second = await request("POST", `/webhooks/easyorders/${token}/order-created`, {
      body: { id: "1001", full_name: "Updated" },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const rows = ordersByExternalId("1001");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.json.data.localOrderId);
    assert.equal(rows[0].raw_data.full_name, "Updated");
    assert.equal(rows[0].source_integration_id, shop.id);
  });

  it("2. same company + different source + same order_id creates two rows", async () => {
    const platform = await loginPlatform();
    const shopA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const shopB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify B",
      credentials: { apiKey: "shop-b" },
    });
    const createdA = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Store A" } },
    );
    const createdB = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Store B" } },
    );
    assert.equal(createdA.status, 200);
    assert.equal(createdB.status, 200);
    const rows = ordersByExternalId("1001");
    assert.equal(rows.length, 2);
    assert.notEqual(createdA.json.data.localOrderId, createdB.json.data.localOrderId);
    assert.equal(
      rows.find((row) => row.source_integration_id === shopA.id).raw_data.full_name,
      "Store A",
    );
    assert.equal(
      rows.find((row) => row.source_integration_id === shopB.id).raw_data.full_name,
      "Store B",
    );
  });

  it("3. NULL-source duplicate is rejected", async () => {
    const first = await request("POST", "/api/orders", {
      token: enayaToken(),
      body: { id: "1001", full_name: "Manual one", is_manual: true },
    });
    const second = await request("POST", "/api/orders", {
      token: enayaToken(),
      body: { id: "1001", full_name: "Manual two", is_manual: true },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "ORDER_DUPLICATE");
    assert.equal(ordersByExternalId("1001").length, 1);
  });

  it("4. NULL 1001 and Shopify 1001 are both allowed", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const manual = await request("POST", "/api/orders", {
      token: enayaToken(),
      body: { id: "1001", full_name: "Manual 1001", is_manual: true },
    });
    const attributed = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Shopify 1001" } },
    );
    assert.equal(manual.status, 201);
    assert.equal(attributed.status, 200);
    const rows = ordersByExternalId("1001");
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.source_integration_id == null).length, 1);
    assert.equal(rows.filter((row) => row.source_integration_id === shop.id).length, 1);
  });

  it("5. company A 1001 and company B 1001 are allowed", async () => {
    const platform = await loginPlatform();
    const shopA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Enaya Shopify",
      credentials: { apiKey: "shop-a" },
    });
    const shopB = await createConnection(platform, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other Shopify",
      credentials: { apiKey: "shop-b" },
    });
    const a = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Enaya" } },
    );
    const b = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Other" } },
    );
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const enaya = fake.__db.orders.find(
      (row) => row.company_id === ENAYA_ID && row.order_id === "1001",
    );
    const other = fake.__db.orders.find(
      (row) => row.company_id === OTHER_ID && row.order_id === "1001",
    );
    assert.equal(enaya.raw_data.full_name, "Enaya");
    assert.equal(other.raw_data.full_name, "Other");

    const cross = await request("GET", `/api/orders/${other.id}?raw=true`, {
      token: enayaToken(),
    });
    assert.equal(cross.status, 404);
    assert.equal(JSON.stringify(cross.json).includes("Other"), false);
  });

  it("6. Shopify A webhook cannot overwrite Shopify B same id", async () => {
    const platform = await loginPlatform();
    const shopA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const shopB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify B",
      credentials: { apiKey: "shop-b" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "A original" } },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "B original" } },
    );
    const overwrite = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "A updated" } },
    );
    assert.equal(overwrite.status, 200);
    const rowA = fake.__db.orders.find((row) => row.source_integration_id === shopA.id);
    const rowB = fake.__db.orders.find((row) => row.source_integration_id === shopB.id);
    assert.equal(rowA.raw_data.full_name, "A updated");
    assert.equal(rowB.raw_data.full_name, "B original");
  });

  it("7. EasyOrders A cannot overwrite EasyOrders B same id", async () => {
    const platform = await loginPlatform();
    const eoA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO A",
      credentials: { apiKey: "eo-a-key" },
    });
    const eoB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO B",
      credentials: { apiKey: "eo-b-key" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(eoA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "EO A original" } },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(eoB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "EO B original" } },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(eoA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "EO A updated" } },
    );
    const rowA = fake.__db.orders.find((row) => row.source_integration_id === eoA.id);
    const rowB = fake.__db.orders.find((row) => row.source_integration_id === eoB.id);
    assert.equal(rowA.raw_data.full_name, "EO A updated");
    assert.equal(rowB.raw_data.full_name, "EO B original");
  });

  it("8. webhook body company_id is ignored", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const created = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", company_id: OTHER_ID, full_name: "Stolen?" } },
    );
    assert.equal(created.status, 200);
    const row = fake.__db.orders.find((item) => item.order_id === "1001");
    assert.equal(row.company_id, ENAYA_ID);
    assert.equal(row.source_integration_id, shop.id);
  });

  it("9-10. source-qualified lookup is exact and source-less 2 matches return ORDER_AMBIGUOUS", async () => {
    const platform = await loginPlatform();
    const shopA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const shopB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify B",
      credentials: { apiKey: "shop-b" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Store A" } },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Store B" } },
    );

    const ambiguous = await request("GET", "/api/orders/1001?raw=true", {
      token: enayaToken(),
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "ORDER_AMBIGUOUS");

    const exact = await request(
      "GET",
      `/api/orders/1001?raw=true&source_integration_id=${shopA.id}`,
      { token: enayaToken() },
    );
    assert.equal(exact.status, 200);
    assert.equal(exact.json.data.full_name, "Store A");
    assert.equal(exact.json.data.source_integration_id, shopA.id);
    assert.equal(exact.json.data.id, exact.json.data.localOrderId);
    assert.equal(exact.json.data.order_id, "1001");

    const listed = await request(
      "GET",
      "/api/orders?from=2020-01-01&to=2030-12-31&limit=50",
      { token: enayaToken() },
    );
    assert.equal(listed.status, 200);
    const listedRows = listed.json.data.filter((row) => row.order_id === "1001");
    assert.equal(listedRows.length, 2);
    const listedIds = new Set(listedRows.map((row) => row.id));
    assert.equal(listedIds.size, 2);
    assert.equal(
      listedRows.every((row) => row.id && row.id === row.localOrderId),
      true,
    );
    assert.equal(
      listedRows.every(
        (row) =>
          row.order_id === "1001" &&
          row.order_reference != null &&
          row.source_integration_id,
      ),
      true,
    );
    assert.notEqual(
      listedRows.find((row) => row.source_integration_id === shopA.id)?.id,
      listedRows.find((row) => row.source_integration_id === shopB.id)?.id,
    );

    const rowA = fake.__db.orders.find((row) => row.source_integration_id === shopA.id);
    const rowB = fake.__db.orders.find((row) => row.source_integration_id === shopB.id);
    const byUuidA = await request("GET", `/api/orders/${rowA.id}?raw=true`, {
      token: enayaToken(),
    });
    const byUuidB = await request("GET", `/api/orders/${rowB.id}?raw=true`, {
      token: enayaToken(),
    });
    assert.equal(byUuidA.status, 200);
    assert.equal(byUuidA.json.data.full_name, "Store A");
    assert.equal(byUuidA.json.data.id, rowA.id);
    assert.equal(byUuidB.status, 200);
    assert.equal(byUuidB.json.data.full_name, "Store B");
    assert.equal(byUuidB.json.data.id, rowB.id);

    const patched = await request("PATCH", `/api/orders/${rowA.id}/status`, {
      token: enayaToken(),
      body: { status: "canceled" },
    });
    assert.equal(patched.status, 200);
    assert.equal(
      fake.__db.orders.find((row) => row.id === rowA.id).status,
      "canceled",
    );
    assert.equal(
      fake.__db.orders.find((row) => row.id === rowB.id).status,
      "new",
    );

    const edited = await request("PATCH", `/api/orders/${rowB.id}`, {
      token: enayaToken(),
      body: { full_name: "Store B edited" },
    });
    assert.equal(edited.status, 200);
    assert.equal(
      fake.__db.orders.find((row) => row.id === rowB.id).raw_data.full_name,
      "Store B edited",
    );
    assert.equal(
      fake.__db.orders.find((row) => row.id === rowA.id).raw_data.full_name,
      "Store A",
    );
  });

  it("11. EasyConfirm uses the exact EasyOrders source", async () => {
    const platform = await loginPlatform();
    const eoA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO A",
      credentials: { apiKey: "eo-a-key" },
    });
    const eoB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO B",
      credentials: { apiKey: "eo-b-key" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(eoA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "EO A" } },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(eoB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "EO B" } },
    );
    const ambiguous = await request(
      "POST",
      "/api/orders/1001/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "ORDER_AMBIGUOUS");

    capturedHttp = [];
    const rowA = fake.__db.orders.find((row) => row.source_integration_id === eoA.id);
    const refreshed = await request(
      "POST",
      `/api/orders/${rowA.id}/refresh-customer-status`,
      { token: enayaToken() },
    );
    assert.equal(refreshed.status, 200, refreshed.json?.message);
    const easyOrdersCalls = capturedHttp.filter((entry) =>
      String(entry.url).includes("easy-orders.net"),
    );
    assert.equal(easyOrdersCalls.length, 1);
    assert.equal(easyOrdersCalls[0].headers["Api-Key"], "eo-a-key");
    assert.notEqual(easyOrdersCalls[0].headers["Api-Key"], "eo-b-key");
    assert.equal(String(easyOrdersCalls[0].url).includes(rowA.id), false);
    assert.equal(String(easyOrdersCalls[0].url).includes("/orders/1001"), true);
  });

  it("12. send-to-Bosta resolves the exact local order", async () => {
    const platform = await loginPlatform();
    const shopA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const shopB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify B",
      credentials: { apiKey: "shop-b" },
    });
    const bosta = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta A",
      credentials: { apiKey: "boost_aaaa" },
    });
    const product = fake.__db.products.find((row) => row.id === PROD_EGYPT_ID);
    product.source_integration_id = shopA.id;
    await request("POST", "/api/bosta/sku-mappings", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bosta.id,
        catalogProductId: PROD_EGYPT_ID,
        mappingType: "product",
        name: "Egypt A",
        skus: ["bo-account-a"],
      },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      {
        body: {
          id: "1001",
          full_name: "Send A",
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
      },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Send B sibling" } },
    );

    const ambiguous = await request("POST", "/api/orders/1001/send-to-bosta", {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bosta.id,
        cityId: "city-cairo",
        districtId: "dist-nasr",
      },
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "ORDER_AMBIGUOUS");

    const rowA = fake.__db.orders.find((row) => row.source_integration_id === shopA.id);
    const rowB = fake.__db.orders.find((row) => row.source_integration_id === shopB.id);
    const sent = await request("POST", `/api/orders/${rowA.id}/send-to-bosta`, {
      token: enayaToken(),
      body: {
        shippingIntegrationId: bosta.id,
        cityId: "city-cairo",
        districtId: "dist-nasr",
      },
    });
    assert.equal(sent.status, 200, sent.json?.message);
    assert.equal(
      fake.__db.orders.find((row) => row.id === rowA.id).shipping_integration_id,
      bosta.id,
    );
    assert.equal(fake.__db.orders.find((row) => row.id === rowA.id).status, "Shipped");
    assert.equal(
      fake.__db.orders.find((row) => row.id === rowB.id).shipping_integration_id || null,
      null,
    );
    assert.equal(fake.__db.orders.find((row) => row.id === rowB.id).status, "new");
  });

  it("13. Bosta webhook does not update a sibling store order", async () => {
    const platform = await loginPlatform();
    const shopA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const shopB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify B",
      credentials: { apiKey: "shop-b" },
    });
    const bosta = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta A",
      credentials: { apiKey: "boost_aaaa" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopA.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "A" } },
    );
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shopB.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "B" } },
    );
    const rowA = fake.__db.orders.find((row) => row.source_integration_id === shopA.id);
    const rowB = fake.__db.orders.find((row) => row.source_integration_id === shopB.id);
    rowA.shipping_integration_id = bosta.id;
    rowA.raw_data.bosta_order_alias = "ALIAS-A";
    rowB.shipping_integration_id = null;
    rowB.raw_data.bosta_order_alias = "ALIAS-B";

    const updated = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-A", status: "Delivered" } },
    );
    assert.equal(updated.status, 200, updated.json?.message);
    assert.equal(rowA.raw_data.bosta_status, "Delivered");
    assert.equal(rowB.raw_data.bosta_status, undefined);
    assert.equal(rowB.raw_data.full_name, "B");
  });

  it("14. deleting a commerce integration with attributed orders returns INTEGRATION_IN_USE", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Keep me" } },
    );
    const deleted = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${shop.id}`,
      { token: platform },
    );
    assert.equal(deleted.status, 409);
    assert.equal(deleted.json.code, "INTEGRATION_IN_USE");
    assert.equal(String(deleted.json.error || "").includes("23503"), false);
    const stillThere = fake.__db.company_integrations.find((row) => row.id === shop.id);
    assert.ok(stillThere);
    const order = fake.__db.orders.find((row) => row.order_id === "1001");
    assert.equal(order.source_integration_id, shop.id);
  });

  it("15. order_reference is unchanged on same-source webhook update", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    const first = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "First" } },
    );
    assert.equal(first.status, 200);
    const reference = first.json.data.order_reference;
    assert.equal(reference, 1001);
    const second = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Second" } },
    );
    assert.equal(second.status, 200);
    assert.equal(second.json.data.order_reference, reference);
    assert.equal(second.json.data.localOrderId, first.json.data.localOrderId);
  });

  it("16. unique external-id fallback still works", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Shopify A",
      credentials: { apiKey: "shop-a" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Only Store" } },
    );
    const row = fake.__db.orders.find((item) => item.order_id === "1001");
    const byExternal = await request("GET", "/api/orders/1001?raw=true", {
      token: enayaToken(),
    });
    assert.equal(byExternal.status, 200);
    assert.equal(byExternal.json.data.id, row.id);
    assert.equal(byExternal.json.data.order_id, "1001");
    assert.equal(byExternal.json.data.full_name, "Only Store");
    assert.equal(byExternal.json.data.order_reference, row.order_reference);
  });

  it("17. cross-company UUID returns 404", async () => {
    const platform = await loginPlatform();
    const shop = await createConnection(platform, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other Shopify",
      credentials: { apiKey: "shop-other" },
    });
    await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(shop.webhookUrl)}/order-created`,
      { body: { id: "1001", full_name: "Other Customer" } },
    );
    const otherRow = fake.__db.orders.find(
      (row) => row.company_id === OTHER_ID && row.order_id === "1001",
    );
    assert.ok(otherRow?.id);

    const details = await request("GET", `/api/orders/${otherRow.id}?raw=true`, {
      token: enayaToken(),
    });
    assert.equal(details.status, 404);

    const patched = await request("PATCH", `/api/orders/${otherRow.id}/status`, {
      token: enayaToken(),
      body: { status: "canceled" },
    });
    assert.equal(patched.status, 404);
    assert.equal(
      fake.__db.orders.find((row) => row.id === otherRow.id).status,
      "new",
    );

    const owned = await request("GET", `/api/orders/${otherRow.id}?raw=true`, {
      token: otherToken(),
    });
    assert.equal(owned.status, 200);
    assert.equal(owned.json.data.id, otherRow.id);
    assert.equal(owned.json.data.full_name, "Other Customer");
  });
});
