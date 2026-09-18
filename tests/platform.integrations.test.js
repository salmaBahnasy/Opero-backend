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
    await request("GET", "/api/products/p1", { token: enaya });
    const enayaCall = capturedHttp.find((row) => row.headers["Api-Key"]);
    assert.equal(enayaCall.headers["Api-Key"], "enaya-easy-AAA1");

    capturedHttp = [];
    await request("GET", "/api/products/p1", { token: other });
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
    await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
      credentials: { accessToken: "salla-enaya-token" },
    });
    const enaya = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    await request("POST", "/api/salla/auth/login", {
      token: enaya,
      body: { access_token: "stolen-other-company-token" },
    });
    assert.equal(
      capturedHttp.some(
        (row) => row.headers.Authorization === "Bearer salla-enaya-token",
      ),
      true,
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
    const { status, json } = await request("GET", "/api/products/p-env", {
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
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const rowA = fake.__db.orders.find((row) => row.order_id === "shop-a-order");
    const rowB = fake.__db.orders.find((row) => row.order_id === "shop-b-order");
    assert.equal(rowA.company_id, ENAYA_ID);
    assert.equal(rowB.company_id, ENAYA_ID);
    assert.equal(rowA.source_integration_id, storeA.id);
    assert.equal(rowB.source_integration_id, storeB.id);
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
});
