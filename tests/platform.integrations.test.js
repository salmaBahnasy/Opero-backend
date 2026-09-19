process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.EASYORDER_API_KEY = "GLOBAL_EASYORDERS_SHOULD_NOT_BE_USED";
process.env.BOSTA_API_KEY = "GLOBAL_BOSTA_SHOULD_NOT_BE_USED";
process.env.BOSTA_FULFILLMENT_API_KEY = "GLOBAL_BOSTA_FULFILLMENT_SHOULD_NOT_BE_USED";
process.env.SALLA_ACCESS_TOKEN = "GLOBAL_SALLA_SHOULD_NOT_BE_USED";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");
const { decryptJson } = require("../src/config/integrationSecrets");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENAYA_STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
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

function employeeToken(companyId, employeeId, email, role = "company_admin") {
  return signEmployeeToken({ employeeId, companyId, role, email });
}

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
        id: ENAYA_STAFF_ID,
        company_id: ENAYA_ID,
        name: "Enaya Staff",
        email: "staff@enaya.local",
        password: passwordHash,
        role: "employee",
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
    orders: [
      {
        id: "ord-legacy",
        company_id: ENAYA_ID,
        order_id: "legacy-no-source",
        status: "new",
        source_integration_id: null,
        raw_data: { full_name: "Legacy Customer", is_manual: true },
        created_at: NOW,
      },
    ],
  });
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
    const path = String(url || "").split("?")[0].replace(/\/$/, "");
    if (path.endsWith("/products")) {
      return {
        status: 200,
        data: [
          {
            id: "123",
            name: "Remote Product",
            sku: "RP-1",
            price: 99,
            quantity: 4,
            thumb: "https://img.test/p.png",
          },
        ],
      };
    }
    if (/\/products\/[^/]+$/.test(path)) {
      return {
        status: 200,
        data: {
          id: "remote-1",
          name: "Remote Product",
          status: "pending",
          variants: [{ id: "v1", price: 10 }],
        },
      };
    }
    return {
      status: 200,
      data: { id: "remote-1", name: "Remote Product", status: "pending" },
    };
  };
  axios.post = async (url, body, config = {}) => {
    capturedHttp.push({
      method: "POST",
      url,
      headers: config.headers || {},
      body,
    });
    return { status: 200, data: { id: "bosta-remote-1" } };
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

describe("platform admin and integration connections", () => {
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

  it("1. platform admin can manage companies", async () => {
    const token = await loginPlatform();
    const listed = await request("GET", "/api/platform/companies", { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.length, 2);

    const created = await request("POST", "/api/platform/companies", {
      token,
      body: { name: "New Co", slug: "new-co" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.slug, "new-co");

    const updated = await request(
      "PATCH",
      `/api/platform/companies/${created.json.data.id}/active`,
      { token, body: { is_active: false } },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.is_active, false);
  });

  it("2. company admin cannot access platform admin routes", async () => {
    const token = employeeToken(
      ENAYA_ID,
      ENAYA_ADMIN_ID,
      "admin@enaya.local",
    );
    const { status } = await request("GET", "/api/platform/companies", { token });
    assert.equal(status, 403);
  });

  it("3. employee cannot access platform admin routes", async () => {
    const token = employeeToken(
      ENAYA_ID,
      ENAYA_STAFF_ID,
      "staff@enaya.local",
      "employee",
    );
    const { status } = await request("GET", "/api/platform/companies", { token });
    assert.equal(status, 403);
  });

  it("4-6. platform admin configures isolated EasyOrders connections without exposing secrets", async () => {
    const token = await loginPlatform();
    const a = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Enaya EasyOrders Egypt",
      credentials: { apiKey: "enaya-easy-secret-aaaa" },
    });
    const b = await createConnection(token, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other EasyOrders",
      credentials: { apiKey: "other-easy-secret-bbbb" },
    });
    assert.equal(a.provider, "easyorders");
    assert.equal(b.provider, "easyorders");
    assert.notEqual(a.id, b.id);
    assert.equal(a.apiKeyMasked, "****aaaa");
    assert.equal(b.apiKeyMasked, "****bbbb");
    const serialized = JSON.stringify({ a, b });
    assert.equal(serialized.includes("enaya-easy-secret-aaaa"), false);
    assert.equal(serialized.includes("other-easy-secret-bbbb"), false);
  });

  it("7-8. Company A and B EasyOrders operations use only their own credentials", async () => {
    const token = await loginPlatform();
    await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Enaya EO",
      credentials: { apiKey: "enaya-easy-AAA1" },
    });
    await createConnection(token, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other EO",
      credentials: { apiKey: "other-easy-BBB2" },
    });

    const enaya = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const other = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    const syncedA = await request("POST", "/api/products/sync", { token: enaya });
    assert.equal(syncedA.status, 200, syncedA.json?.message);
    const enayaCall = capturedHttp.find((row) => row.headers["Api-Key"]);
    assert.equal(enayaCall.headers["Api-Key"], "enaya-easy-AAA1");

    capturedHttp = [];
    const syncedB = await request("POST", "/api/products/sync", { token: other });
    assert.equal(syncedB.status, 200, syncedB.json?.message);
    const otherCall = capturedHttp.find((row) => row.headers["Api-Key"]);
    assert.equal(otherCall.headers["Api-Key"], "other-easy-BBB2");
  });

  it("9. Bosta credential isolation", async () => {
    const token = await loginPlatform();
    await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Enaya Bosta",
      credentials: { apiKey: "boost_enaya_1" },
    });
    await createConnection(token, OTHER_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Other Bosta",
      credentials: { apiKey: "boost_other_2" },
    });
    const enaya = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const other = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    await request("GET", "/api/bosta/fulfillment/health", { token: enaya });
    assert.equal(
      capturedHttp.some((row) => row.headers["x-api-key"] === "boost_enaya_1"),
      true,
    );
    capturedHttp = [];
    await request("GET", "/api/bosta/fulfillment/health", { token: other });
    assert.equal(
      capturedHttp.some((row) => row.headers["x-api-key"] === "boost_other_2"),
      true,
    );
  });

  it("10. Salla credential isolation and no body-token override", async () => {
    const token = await loginPlatform();
    const connection = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
      credentials: { accessToken: "salla-enaya-token" },
    });
    const enaya = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const missingId = await request("POST", "/api/salla/auth/login", {
      token: enaya,
      body: { access_token: "stolen-other-company-token" },
    });
    assert.equal(missingId.status, 400);
    assert.equal(missingId.json.code, "SALLA_INTEGRATION_REQUIRED");
    const legacy = await request("POST", "/api/salla/auth/login", {
      token: enaya,
      body: {
        access_token: "stolen-other-company-token",
        integrationId: connection.id,
      },
    });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.json.code, "SALLA_AUTHORIZATION_LEGACY");
    assert.equal(
      capturedHttp.some(
        (row) => row.headers.Authorization === "Bearer salla-enaya-token",
      ),
      false,
    );
    assert.equal(
      capturedHttp.some(
        (row) => row.headers.Authorization === "Bearer stolen-other-company-token",
      ),
      false,
    );
  });

  it("11-16. webhook tokens resolve the exact connection and ignore payload company_id", async () => {
    const token = await loginPlatform();
    const a = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Enaya EO WH",
      credentials: { apiKey: "eo-a" },
    });
    const b = await createConnection(token, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other EO WH",
      credentials: { apiKey: "eo-b" },
    });
    const tokenA = tokenFromWebhookUrl(a.webhookUrl);
    const tokenB = tokenFromWebhookUrl(b.webhookUrl);
    assert.ok(tokenA);
    assert.notEqual(tokenA, tokenB);

    const before = fake.__db.orders.length;
    const invalid = await request(
      "POST",
      "/webhooks/easyorders/not-a-real-token/order-created",
      { body: { id: "should-not-write", company_id: ENAYA_ID } },
    );
    assert.equal(invalid.status, 401);
    assert.equal(fake.__db.orders.length, before);

    const createdA = await request(
      "POST",
      `/webhooks/easyorders/${tokenA}/order-created`,
      {
        body: {
          id: "eo-order-a",
          company_id: OTHER_ID,
          full_name: "From webhook A",
        },
      },
    );
    assert.equal(createdA.status, 200);
    const rowA = fake.__db.orders.find((row) => row.order_id === "eo-order-a");
    assert.equal(rowA.company_id, ENAYA_ID);
    assert.equal(rowA.source_integration_id, a.id);

    const createdB = await request(
      "POST",
      `/webhooks/easyorders/${tokenB}/order-created`,
      {
        body: {
          id: "eo-order-b",
          company_id: ENAYA_ID,
          full_name: "From webhook B",
        },
      },
    );
    assert.equal(createdB.status, 200);
    const rowB = fake.__db.orders.find((row) => row.order_id === "eo-order-b");
    assert.equal(rowB.company_id, OTHER_ID);
    assert.equal(rowB.source_integration_id, b.id);
  });

  it("14. Bosta webhook resolves the correct company", async () => {
    const token = await loginPlatform();
    const shipping = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Enaya Bosta WH",
      credentials: { apiKey: "boost_wh" },
    });
    fake.__db.orders.push({
      id: "ord-bosta",
      company_id: ENAYA_ID,
      order_id: "ALIAS-1",
      status: "Confirmed",
      raw_data: { bosta_order_alias: "ALIAS-1", full_name: "Ship me" },
      created_at: NOW,
    });
    const hookToken = tokenFromWebhookUrl(shipping.webhookUrl);
    const { status, json } = await request(
      "POST",
      `/webhooks/bosta/${hookToken}/order-status`,
      {
        body: {
          orderAlias: "ALIAS-1",
          status: "Delivered",
          company_id: OTHER_ID,
        },
      },
    );
    assert.equal(status, 200, json?.message);
    const updated = fake.__db.orders.find((row) => row.order_id === "ALIAS-1");
    assert.equal(updated.company_id, ENAYA_ID);
    assert.equal(updated.shipping_integration_id, shipping.id);
  });

  it("17-18. webhook tokens can be rotated and the old token stops working", async () => {
    const token = await loginPlatform();
    const created = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Rotate me",
      credentials: { apiKey: "rotate-key" },
    });
    const oldToken = tokenFromWebhookUrl(created.webhookUrl);
    const rotated = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${created.id}/rotate-webhook`,
      { token },
    );
    assert.equal(rotated.status, 200);
    const newToken = tokenFromWebhookUrl(rotated.json.data.webhookUrl);
    assert.notEqual(newToken, oldToken);

    const oldRes = await request(
      "POST",
      `/webhooks/easyorders/${oldToken}/order-created`,
      { body: { id: "after-rotate-old" } },
    );
    assert.equal(oldRes.status, 401);

    const newRes = await request(
      "POST",
      `/webhooks/easyorders/${newToken}/order-created`,
      { body: { id: "after-rotate-new" } },
    );
    assert.equal(newRes.status, 200);
  });

  it("19. integration secrets are not written to logs", async () => {
    const token = await loginPlatform();
    const secret = "PLAINTEXT_SECRET_XYZ_9999";
    const logs = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...args) => logs.push(args.map(String).join(" "));
    console.info = (...args) => logs.push(args.map(String).join(" "));
    console.warn = (...args) => logs.push(args.map(String).join(" "));
    console.error = (...args) => logs.push(args.map(String).join(" "));
    try {
      await createConnection(token, ENAYA_ID, {
        category: "commerce",
        provider: "easyorders",
        name: "Log check",
        credentials: { apiKey: secret },
      });
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
    assert.equal(logs.some((line) => line.includes(secret)), false);
  });

  it("20. tenant operations do not fall back to global env credentials", async () => {
    const enaya = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const { status, json } = await request("POST", "/api/products/sync", {
      token: enaya,
    });
    assert.equal(status, 409);
    assert.equal(json.code, "INTEGRATION_NOT_CONFIGURED");
    assert.equal(
      capturedHttp.some(
        (row) => row.headers["Api-Key"] === "GLOBAL_EASYORDERS_SHOULD_NOT_BE_USED",
      ),
      false,
    );
  });

  it("MC1. one company can have EasyOrders + Shopify simultaneously", async () => {
    const token = await loginPlatform();
    const eo = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Enaya EasyOrders Egypt",
      credentials: { apiKey: "eo-multi" },
    });
    const shop = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Enaya Shopify Egypt",
      credentials: { accessToken: "shop-egypt" },
    });
    const listed = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token },
    );
    assert.equal(listed.status, 200);
    const providers = listed.json.data.map((row) => row.provider).sort();
    assert.deepEqual(providers, ["easyorders", "shopify"]);
    assert.notEqual(eo.id, shop.id);
  });

  it("MC2-6. two Shopify connections have different credentials, webhooks, and resolution", async () => {
    const token = await loginPlatform();
    const storeA = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Store A",
      credentials: { accessToken: "shop-store-A-secret" },
    });
    const storeB = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Store B",
      credentials: { accessToken: "shop-store-B-secret" },
    });
    assert.equal(storeA.apiKeyMasked, "****cret");
    assert.notEqual(storeA.webhookUrl, storeB.webhookUrl);
    const tokenA = tokenFromWebhookUrl(storeA.webhookUrl);
    const tokenB = tokenFromWebhookUrl(storeB.webhookUrl);

    const a = await request("POST", `/webhooks/shopify/${tokenA}/orders`, {
      body: { id: "shop-a-order", company_id: OTHER_ID },
    });
    const b = await request("POST", `/webhooks/shopify/${tokenB}/orders`, {
      body: { id: "shop-b-order", company_id: OTHER_ID },
    });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(
      fake.__db.orders.some((row) => row.order_id === "shop-a-order"),
      false,
    );
    assert.equal(
      fake.__db.orders.some((row) => row.order_id === "shop-b-order"),
      false,
    );
  });

  it("MC8. Company B cannot use Company A integration id", async () => {
    const token = await loginPlatform();
    const aConn = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "A only",
      credentials: { apiKey: "only-a" },
    });
    const other = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    const { status, json } = await request(
      "GET",
      `/api/products/p1?integrationId=${aConn.id}`,
      { token: other },
    );
    assert.equal(status, 403);
    assert.equal(json.code, "INTEGRATION_NOT_OWNED");
  });

  it("MC9-10. one company can have Bosta plus Mylerz, and two Bosta accounts", async () => {
    const token = await loginPlatform();
    const bosta1 = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta Account 1",
      credentials: { apiKey: "boost_one" },
    });
    const bosta2 = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta Account 2",
      credentials: { apiKey: "boost_two" },
    });
    const mylerz = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "mylerz",
      name: "Mylerz Egypt",
      credentials: { apiKey: "mylerz-key" },
    });
    assert.notEqual(bosta1.id, bosta2.id);
    assert.equal(mylerz.provider, "mylerz");
    assert.equal(mylerz.category, "shipping");
  });

  it("MC11-12. disabling one connection does not disable others and secrets stay isolated", async () => {
    const token = await loginPlatform();
    const one = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Keep enabled",
      credentials: { accessToken: "keep-secret-1111" },
    });
    const two = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Disable me",
      credentials: { accessToken: "drop-secret-2222" },
    });
    const disabled = await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${two.id}`,
      { token, body: { enabled: false } },
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.data.enabled, false);

    const listed = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token },
    );
    const keep = listed.json.data.find((row) => row.id === one.id);
    const gone = listed.json.data.find((row) => row.id === two.id);
    assert.equal(keep.enabled, true);
    assert.equal(gone.enabled, false);
    assert.equal(JSON.stringify(listed.json).includes("keep-secret-1111"), false);
    assert.equal(JSON.stringify(listed.json).includes("drop-secret-2222"), false);

    const oldToken = tokenFromWebhookUrl(two.webhookUrl);
    const { status } = await request("POST", `/webhooks/shopify/${oldToken}/orders`, {
      body: { id: "disabled-should-fail" },
    });
    assert.equal(status, 401);
  });

  it("MC13. historical orders without source_integration_id continue to work", async () => {
    const enaya = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const { status, json } = await request(
      "GET",
      "/api/orders/legacy-no-source?raw=true",
      { token: enaya },
    );
    assert.equal(status, 200);
    assert.equal(json.data.full_name, "Legacy Customer");
    assert.equal(json.data.source_integration_id ?? null, null);
  });

  it("source_integration_id filters list and export at query level without leaking other companies", async () => {
    const platform = await loginPlatform();
    const storeA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "filter-a-key" },
    });
    const storeB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Saudi",
      credentials: { accessToken: "filter-b-token" },
    });
    const otherStore = await createConnection(platform, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other Store",
      credentials: { apiKey: "filter-other-key" },
    });

    fake.__db.orders.push(
      {
        id: "ord-src-a",
        company_id: ENAYA_ID,
        order_id: "src-a-1",
        status: "new",
        source_integration_id: storeA.id,
        raw_data: { full_name: "Store A Customer" },
        created_at: NOW,
      },
      {
        id: "ord-src-b",
        company_id: ENAYA_ID,
        order_id: "src-b-1",
        status: "new",
        source_integration_id: storeB.id,
        raw_data: { full_name: "Store B Customer" },
        created_at: NOW,
      },
      {
        id: "ord-src-other",
        company_id: OTHER_ID,
        order_id: "src-other-1",
        status: "new",
        source_integration_id: otherStore.id,
        raw_data: { full_name: "Other Company Customer" },
        created_at: NOW,
      },
    );

    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const range = "from=2020-01-01&to=2030-12-31";

    const all = await request("GET", `/api/orders?${range}&limit=50`, { token });
    assert.equal(all.status, 200, all.json?.message);
    const allNames = (all.json.data || []).map((row) => row.full_name);
    assert.equal(allNames.includes("Store A Customer"), true);
    assert.equal(allNames.includes("Store B Customer"), true);
    assert.equal(allNames.includes("Legacy Customer"), true);
    assert.equal(allNames.includes("Other Company Customer"), false);
    assert.equal(all.json.appliedFilters.source_integration_id ?? null, null);

    const onlyA = await request(
      "GET",
      `/api/orders?${range}&source_integration_id=${storeA.id}`,
      { token },
    );
    assert.equal(onlyA.status, 200, onlyA.json?.message);
    assert.equal(onlyA.json.total, 1);
    assert.equal(onlyA.json.data.length, 1);
    assert.equal(onlyA.json.data[0].full_name, "Store A Customer");
    assert.equal(onlyA.json.data[0].source_integration_id, storeA.id);
    assert.equal(onlyA.json.appliedFilters.source_integration_id, storeA.id);

    const onlyB = await request(
      "GET",
      `/api/orders?${range}&source_integration_id=${storeB.id}`,
      { token },
    );
    assert.equal(onlyB.status, 200, onlyB.json?.message);
    assert.equal(onlyB.json.total, 1);
    assert.equal(onlyB.json.data.length, 1);
    assert.equal(onlyB.json.data[0].full_name, "Store B Customer");
    assert.equal(onlyB.json.data[0].source_integration_id, storeB.id);

    const foreign = await request(
      "GET",
      `/api/orders?${range}&source_integration_id=${otherStore.id}`,
      { token },
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.code, "INTEGRATION_NOT_FOUND");
    assert.equal(JSON.stringify(foreign.json).includes("Other Company Customer"), false);

    const invalid = await request(
      "GET",
      `/api/orders?${range}&source_integration_id=not-a-uuid`,
      { token },
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_SOURCE_INTEGRATION");

    const exported = await request(
      "GET",
      `/api/orders/export?${range}&source_integration_id=${storeA.id}`,
      { token },
    );
    assert.equal(exported.status, 200);
  });

  it("stores Shopify shopDomain in settings, not encrypted credentials", async () => {
    const token = await loginPlatform();
    const created = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Egypt",
      credentials: {
        accessToken: "shpat-not-for-settings",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    assert.equal(created.shopDomain, "enaya-eg.myshopify.com");
    assert.equal(JSON.stringify(created).includes("shpat-not-for-settings"), false);

    const stored = fake.__db.company_integrations.find((row) => row.id === created.id);
    assert.equal(stored.settings.shopDomain, "enaya-eg.myshopify.com");
    const secrets = decryptJson(stored.credentials);
    assert.equal(secrets.shopDomain, undefined);
    assert.equal(secrets.accessToken, "shpat-not-for-settings");
  });

  it("platform admin can set login image and favicon branding URLs", async () => {
    const token = await loginPlatform();
    const created = await request("POST", "/api/platform/companies", {
      token,
      body: {
        name: "Brand Co",
        slug: "brand-co",
        logoUrl: "https://cdn.example.test/brand/logo.png",
        loginImageUrl: "https://cdn.example.test/brand/login.png",
        faviconUrl: "https://cdn.example.test/brand/favicon.ico",
        primaryColor: "#111111",
        secondaryColor: "#222222",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.login_image_url, "https://cdn.example.test/brand/login.png");
    assert.equal(created.json.data.favicon_url, "https://cdn.example.test/brand/favicon.ico");

    const updated = await request(
      "PATCH",
      `/api/platform/companies/${created.json.data.id}`,
      {
        token,
        body: { loginImageUrl: "https://cdn.example.test/brand/login-2.png" },
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(
      updated.json.data.login_image_url,
      "https://cdn.example.test/brand/login-2.png",
    );
  });

  it("P7C. two EasyOrders connections keep separate product rows for the same external id", async () => {
    const platform = await loginPlatform();
    const egypt = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "prod-egypt-key" },
    });
    const ksa = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders KSA",
      credentials: { apiKey: "prod-ksa-key" },
    });
    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");

    const ambiguous = await request("POST", "/api/products/sync", { token });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "INTEGRATION_AMBIGUOUS");

    const syncEgypt = await request(
      "POST",
      `/api/products/sync?integrationId=${egypt.id}`,
      { token },
    );
    assert.equal(syncEgypt.status, 200, syncEgypt.json?.message);
    const syncKsa = await request("POST", "/api/products/sync", {
      token,
      body: { integrationId: ksa.id },
    });
    assert.equal(syncKsa.status, 200, syncKsa.json?.message);

    const listed = await request("GET", "/api/products?limit=50", { token });
    assert.equal(listed.status, 200);
    const rows = listed.json.data || [];
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.easyorder_id === "123"), true);
    const sources = rows.map((row) => row.source_integration_id).sort();
    assert.deepEqual(sources, [egypt.id, ksa.id].sort());

    const onlyEgypt = await request(
      "GET",
      `/api/products?source_integration_id=${egypt.id}`,
      { token },
    );
    assert.equal(onlyEgypt.status, 200);
    assert.equal(onlyEgypt.json.data.length, 1);
    assert.equal(onlyEgypt.json.data[0].source_integration_id, egypt.id);

    const otherStore = await createConnection(platform, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other Products Store",
      credentials: { apiKey: "prod-other-key" },
    });
    const foreign = await request(
      "GET",
      `/api/products?source_integration_id=${otherStore.id}`,
      { token },
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.code, "INTEGRATION_NOT_FOUND");

    const invalid = await request(
      "GET",
      "/api/products?source_integration_id=not-a-uuid",
      { token },
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_SOURCE_INTEGRATION");
  });

  it("P7E. company analytics stay tenant-scoped and support source_integration_id", async () => {
    const { clearDashboardCache } = require("../src/services/dashboardCache.service");
    clearDashboardCache();
    const platform = await loginPlatform();
    const storeA = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "stats-a-key" },
    });
    const storeB = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Saudi",
      credentials: { accessToken: "stats-b-token" },
    });
    const otherStore = await createConnection(platform, OTHER_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Other Stats Store",
      credentials: { apiKey: "stats-other-key" },
    });

    fake.__db.products.push(
      {
        id: "prod-stats-a",
        company_id: ENAYA_ID,
        easyorder_id: "123",
        source_integration_id: storeA.id,
        name: "Egypt Cream",
        sku: "EG-123",
      },
      {
        id: "prod-stats-b",
        company_id: ENAYA_ID,
        easyorder_id: "123",
        source_integration_id: storeB.id,
        name: "KSA Cream",
        sku: "KSA-123",
      },
    );

    fake.__db.orders.push(
      {
        id: "ord-stats-a",
        company_id: ENAYA_ID,
        order_id: "stats-a-1",
        status: "new",
        source_integration_id: storeA.id,
        raw_data: {
          full_name: "Store A Customer",
          cart_items: [
            {
              product_id: "123",
              quantity: 2,
              price: 10,
              product: { name: "Egypt Cream", sku: "EG-123" },
            },
          ],
        },
        created_at: NOW,
      },
      {
        id: "ord-stats-b",
        company_id: ENAYA_ID,
        order_id: "stats-b-1",
        status: "new",
        source_integration_id: storeB.id,
        raw_data: {
          full_name: "Store B Customer",
          cart_items: [
            {
              product_id: "123",
              quantity: 1,
              price: 20,
              product: { name: "KSA Cream", sku: "KSA-123" },
            },
          ],
        },
        created_at: NOW,
      },
      {
        id: "ord-stats-other",
        company_id: OTHER_ID,
        order_id: "stats-other-1",
        status: "new",
        source_integration_id: otherStore.id,
        raw_data: {
          full_name: "Other Company Customer",
          cart_items: [
            {
              product_id: "123",
              quantity: 9,
              price: 99,
              product: { name: "Other Cream" },
            },
          ],
        },
        created_at: NOW,
      },
    );

    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const otherToken = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    const range = "from=2020-01-01&to=2030-12-31";

    const companyWide = await request("GET", `/api/orders/stats?${range}`, {
      token,
    });
    assert.equal(companyWide.status, 200, companyWide.json?.message);
    assert.equal(companyWide.json.stats.totalOrders, 3);
    assert.equal(companyWide.json.filters.source_integration_id ?? null, null);

    const injected = await request(
      "GET",
      `/api/orders/stats?${range}&companyId=${OTHER_ID}&company_id=${OTHER_ID}`,
      { token },
    );
    assert.equal(injected.status, 200);
    assert.equal(injected.json.stats.totalOrders, 3);

    const onlyA = await request(
      "GET",
      `/api/orders/stats?${range}&source_integration_id=${storeA.id}`,
      { token },
    );
    assert.equal(onlyA.status, 200, onlyA.json?.message);
    assert.equal(onlyA.json.stats.totalOrders, 1);
    assert.equal(onlyA.json.filters.source_integration_id, storeA.id);

    const onlyB = await request(
      "GET",
      `/api/orders/stats?${range}&source_integration_id=${storeB.id}`,
      { token },
    );
    assert.equal(onlyB.status, 200);
    assert.equal(onlyB.json.stats.totalOrders, 1);

    const foreign = await request(
      "GET",
      `/api/orders/stats?${range}&source_integration_id=${otherStore.id}`,
      { token },
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.code, "INTEGRATION_NOT_FOUND");

    const invalid = await request(
      "GET",
      `/api/orders/stats?${range}&source_integration_id=not-a-uuid`,
      { token },
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_SOURCE_INTEGRATION");

    const otherCompany = await request("GET", `/api/orders/stats?${range}`, {
      token: otherToken,
    });
    assert.equal(otherCompany.status, 200);
    assert.equal(otherCompany.json.stats.totalOrders, 1);

    const sales = await request(
      "GET",
      `/api/orders/charts/product-sales?${range}`,
      { token },
    );
    assert.equal(sales.status, 200, sales.json?.message);
    const products = sales.json.chart?.products || [];
    const names = products.map((row) => row.name).sort();
    assert.equal(names.includes("Egypt Cream"), true);
    assert.equal(names.includes("KSA Cream"), true);
    assert.equal(names.includes("Other Cream"), false);
    assert.equal(
      products.filter((row) => String(row.external_product_id) === "123").length,
      2,
    );

    const salesA = await request(
      "GET",
      `/api/orders/charts/product-sales?${range}&source_integration_id=${storeA.id}`,
      { token },
    );
    assert.equal(salesA.status, 200);
    const onlyEgypt = (salesA.json.chart?.products || []).filter(
      (row) => String(row.external_product_id) === "123",
    );
    assert.equal(onlyEgypt.length, 1);
    assert.equal(onlyEgypt[0].name, "Egypt Cream");
    assert.equal(onlyEgypt[0].source_integration_id, storeA.id);

    const platformToken = await loginPlatform();
    const platformStats = await request("GET", `/api/orders/stats?${range}`, {
      token: platformToken,
    });
    assert.equal(platformStats.status, 403);
    assert.equal(platformStats.json.code, "JWT_WRONG_SCOPE");
  });

  it("P7F. company-wide costs stay tenant-scoped and reject store filters", async () => {
    const { clearDashboardCache } = require("../src/services/dashboardCache.service");
    clearDashboardCache();

    fake.__db.order_cost_daily.push(
      {
        id: "cost-enaya-p7f",
        company_id: ENAYA_ID,
        cost_date: "2026-09-01",
        expense: 40,
        total_orders: 2,
        shipped_orders: 0,
        successful_orders: 0,
        total_sales: 20,
        shipped_sales: 0,
        successful_sales: 0,
      },
      {
        id: "cost-other-p7f",
        company_id: OTHER_ID,
        cost_date: "2026-09-01",
        expense: 900,
        total_orders: 9,
        shipped_orders: 0,
        successful_orders: 0,
        total_sales: 90,
        shipped_sales: 0,
        successful_sales: 0,
      },
    );

    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const otherToken = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    const range = "from=2026-09-01&to=2026-09-01";

    const enayaChart = await request("GET", `/api/costs/chart?${range}`, {
      token,
    });
    assert.equal(enayaChart.status, 200, enayaChart.json?.message);
    const enayaPoint = (enayaChart.json.chart?.points || []).find(
      (row) => row.date === "2026-09-01",
    );
    assert.equal(Number(enayaPoint?.expense), 40);
    assert.equal(
      JSON.stringify(enayaChart.json).includes("900"),
      false,
    );

    const injected = await request(
      "GET",
      `/api/costs/chart?${range}&companyId=${OTHER_ID}&company_id=${OTHER_ID}`,
      { token },
    );
    assert.equal(injected.status, 200);
    const injectedPoint = (injected.json.chart?.points || []).find(
      (row) => row.date === "2026-09-01",
    );
    assert.equal(Number(injectedPoint?.expense), 40);

    const otherChart = await request("GET", `/api/costs/chart?${range}`, {
      token: otherToken,
    });
    assert.equal(otherChart.status, 200);
    const otherPoint = (otherChart.json.chart?.points || []).find(
      (row) => row.date === "2026-09-01",
    );
    assert.equal(Number(otherPoint?.expense), 900);

    const saveDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(NOW));

    const saved = await request("POST", "/api/costs/daily", {
      token,
      body: {
        date: saveDate,
        expense: 15,
        companyId: OTHER_ID,
        company_id: OTHER_ID,
      },
    });
    assert.equal(saved.status, 201, saved.json?.message);
    assert.equal(
      fake.__db.order_cost_daily.some(
        (row) => row.company_id === OTHER_ID && Number(row.expense) === 15,
      ),
      false,
    );
    const enayaSaved = fake.__db.order_cost_daily.find(
      (row) => row.company_id === ENAYA_ID && String(row.cost_date).slice(0, 10) === saveDate,
    );
    assert.equal(Number(enayaSaved?.expense), 15);
    assert.ok(Number(enayaSaved?.total_orders) >= 1);

    const storeFilter = await request(
      "GET",
      `/api/costs/chart?${range}&source_integration_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      { token },
    );
    assert.equal(storeFilter.status, 400);
    assert.equal(storeFilter.json.code, "COST_SOURCE_FILTER_UNSUPPORTED");

    const storeFilterWrite = await request("POST", "/api/costs/daily", {
      token,
      body: {
        date: saveDate,
        expense: 20,
        source_integration_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    assert.equal(storeFilterWrite.status, 400);
    assert.equal(storeFilterWrite.json.code, "COST_SOURCE_FILTER_UNSUPPORTED");

    const platformToken = await loginPlatform();
    const platformCosts = await request("GET", `/api/costs/chart?${range}`, {
      token: platformToken,
    });
    assert.equal(platformCosts.status, 403);
    assert.equal(platformCosts.json.code, "JWT_WRONG_SCOPE");
  });
});
