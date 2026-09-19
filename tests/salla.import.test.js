process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.PLATFORM_ADMIN_PUBLIC_BASE_URL = "https://admin.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SALLA_OAUTH_CLIENT_ID = "salla-client-id";
process.env.SALLA_OAUTH_CLIENT_SECRET = "salla-client-secret";
process.env.SALLA_OAUTH_REDIRECT_URI =
  "https://api.example.test/api/integrations/salla/oauth/callback";
process.env.SALLA_OAUTH_STATE_SECRET = "salla-oauth-state-secret-test";
process.env.SALLA_APP_WEBHOOK_SECRET = "salla-app-webhook-secret";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-07";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");
const { encryptJson } = require("../src/config/integrationSecrets");
const { runWithTenantContext } = require("../src/utils/tenantScope");
const { persistSallaOrder } = require("../src/services/sallaOrders.service");
const { resetSallaRefreshLocksForTests } = require("../src/services/sallaClient.service");
const { resolveLineCatalogProduct } = require("../src/services/bostaShipping.service");
const {
  MAX_ORDER_PAGES,
  MAX_RANGE_DAYS,
  ORDER_PAGE_SIZE,
} = require("../src/services/sallaOrderImport.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRODUCT_A_ID = "c1111111-aaaa-4111-8111-111111111111";
const PRODUCT_B_ID = "c2222222-bbbb-4222-8222-222222222222";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "salla-app-webhook-secret";
const RANGE = "from=2020-01-01&to=2030-12-31";
const MERCHANT_A = "1001";
const MERCHANT_B = "2002";
const FROM = "2026-08-01";
const TO = "2026-08-31";

let passwordHash;
let server;
let baseUrl;
let fake;
let httpGets = [];
let orderPages = {};
let orderDetails = {};
let getImpl = null;
const originalAxiosGet = axios.get;
const originalAxiosPost = axios.post;

function tokenFromWebhookUrl(url) {
  const parts = String(url || "").split("/");
  const idx = parts.indexOf("webhooks");
  return idx >= 0 ? decodeURIComponent(parts[idx + 2] || "") : "";
}

function sallaSignature(raw, secret = WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

async function request(method, pathName, { token, body, headers = {}, raw } = {}) {
  const nextHeaders = { ...headers };
  if (token) nextHeaders.Authorization = `Bearer ${token}`;
  let payload = raw;
  if (payload === undefined && body !== undefined) {
    nextHeaders["Content-Type"] = nextHeaders["Content-Type"] || "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
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

function employeeToken(
  companyId = ENAYA_ID,
  employeeId = ENAYA_ADMIN_ID,
  email = "admin@enaya.local",
) {
  return signEmployeeToken({ employeeId, companyId, role: "company_admin", email });
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
        id: OTHER_ADMIN_ID,
        company_id: OTHER_ID,
        name: "Other Admin",
        email: "admin@other.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
    ],
    orders: [],
    products: [],
    company_integrations: [],
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

function rowById(id) {
  return fake.__db.company_integrations.find((row) => String(row.id) === String(id));
}

function markConnected(id, patch = {}) {
  const row = rowById(id);
  row.credentials = encryptJson({
    accessToken: patch.accessToken || "access-salla",
    refreshToken: patch.refreshToken || "refresh-salla",
    tokenType: "bearer",
    scope: "offline_access",
  });
  row.settings = {
    ...(row.settings || {}),
    authorizationStatus: patch.authorizationStatus || "connected",
    tokenExpiresAt:
      patch.tokenExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    merchantName: patch.merchantName || "Enaya Store",
  };
  row.provider_account_id = String(patch.merchantId || MERCHANT_A);
  if (patch.enabled === false) row.is_enabled = false;
  if (patch.refreshToken === "") {
    row.credentials = encryptJson({
      accessToken: patch.accessToken || "access-salla",
    });
  }
  return row;
}

async function createConnectedSalla(
  token,
  { name = "Enaya Salla", merchantId = MERCHANT_A, companyId = ENAYA_ID } = {},
) {
  const created = await createConnection(token, companyId, {
    category: "commerce",
    provider: "salla",
    name,
    enabled: true,
  });
  markConnected(created.id, { merchantId });
  return created;
}

function sampleOrderData(overrides = {}) {
  return {
    id: 203948534,
    reference_id: 554433,
    date: { date: "2026-08-18 10:00:00" },
    updated_at: { date: "2026-08-18 10:05:00" },
    status: { id: 5, name: "In progress", slug: "in_progress" },
    payment_method: "cod",
    currency: "SAR",
    amounts: {
      sub_total: { amount: 200, currency: "SAR" },
      shipping_cost: { amount: 15, currency: "SAR" },
      tax: { amount: 0, currency: "SAR" },
      total: { amount: 215, currency: "SAR" },
    },
    customer: {
      id: 88,
      first_name: "Layla",
      last_name: "Hassan",
      mobile: "0551234567",
      email: "layla@example.com",
    },
    shipping: {
      receiver: { name: "Layla Hassan", phone: "0551234567", email: "layla@example.com" },
      address: {
        country: "Saudi Arabia",
        country_code: "SA",
        city: "Riyadh",
        shipping_address: "King Fahd Rd",
        block: "12",
        postal_code: "12345",
      },
    },
    items: [
      {
        id: 1,
        name: "Serum 30ml",
        sku: "SERUM-30",
        quantity: 2,
        product_sku_id: 99001,
        product: { id: 632910392, name: "Serum 30ml", sku: "SERUM-30" },
        amounts: {
          price_without_tax: { amount: 100, currency: "SAR" },
          total_discount: { amount: 0, currency: "SAR" },
          total: { amount: 200, currency: "SAR" },
        },
      },
    ],
    ...overrides,
  };
}

function listSummary(id, extras = {}) {
  return {
    id,
    reference_id: 554433,
    total: { amount: 215, currency: "SAR" },
    date: { date: "2026-08-18 10:00:00" },
    status: { slug: "in_progress", name: "In progress" },
    items: [{ name: "Serum 30ml", quantity: 2 }],
    ...extras,
  };
}

function listPayload(orders, { page = 1, totalPages = 1 } = {}) {
  return {
    status: 200,
    success: true,
    data: orders,
    pagination: {
      count: orders.length,
      total: orders.length,
      perPage: ORDER_PAGE_SIZE,
      currentPage: page,
      totalPages,
      links: {},
    },
  };
}

function sampleEnvelope({ event = "order.created", merchant = Number(MERCHANT_A), data } = {}) {
  return {
    event,
    merchant,
    created_at: "2026-08-18T10:05:00Z",
    company_id: OTHER_ID,
    data: sampleOrderData(data),
  };
}

async function signedSallaWebhook(webhookUrl, { envelope, headers = {}, raw, secret } = {}) {
  const body = raw != null ? raw : JSON.stringify(envelope);
  const token = tokenFromWebhookUrl(webhookUrl);
  return request("POST", `/webhooks/salla/${encodeURIComponent(token)}/orders`, {
    raw: body,
    headers: {
      "Content-Type": "application/json",
      "X-Salla-Security-Strategy": "Signature",
      "X-Salla-Signature": sallaSignature(Buffer.from(body), secret || WEBHOOK_SECRET),
      ...headers,
    },
  });
}

function mockSallaOrders() {
  axios.get = async (url) => {
    if (typeof getImpl === "function") return getImpl(url);
    const href = String(url || "");
    httpGets.push(href);
    if (href.includes("/admin/v2/orders?")) {
      const page = Number(new URL(href).searchParams.get("page") || 1);
      const payload = orderPages[page] || listPayload([], { page, totalPages: 1 });
      return { status: 200, data: payload, headers: {} };
    }
    const detail = href.match(/\/orders\/(\d+)(?:\?|$)/);
    if (detail) {
      const found = orderDetails[detail[1]];
      if (found === "missing") return { status: 404, data: {}, headers: {} };
      if (found === "truncated") {
        return {
          status: 200,
          data: {
            data: sampleOrderData({
              id: Number(detail[1]),
              items_count: 4,
              items: [{ name: "Partial", quantity: 1 }],
            }),
          },
          headers: {},
        };
      }
      return {
        status: 200,
        data: { data: found || sampleOrderData({ id: Number(detail[1]) }) },
        headers: {},
      };
    }
    return { status: 200, data: { data: { merchant: { id: Number(MERCHANT_A) } } }, headers: {} };
  };
}

async function importOrders(store, body = {}, token = employeeToken()) {
  return request("POST", "/api/orders/import", {
    token,
    body: {
      integrationId: store.id,
      from: FROM,
      to: TO,
      company_id: OTHER_ID,
      ...body,
    },
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
  resetSallaRefreshLocksForTests();
  httpGets = [];
  getImpl = null;
  orderPages = {
    1: listPayload([listSummary(203948534)], { page: 1, totalPages: 1 }),
  };
  orderDetails = {
    203948534: sampleOrderData(),
  };
  mockSallaOrders();
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

describe("PHASE 7I-B6 Salla bounded historical order import", () => {
  it("1-9. exact integration gates and provider dispatch", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    const other = await createConnectedSalla(platform, {
      name: "Other Salla",
      merchantId: MERCHANT_B,
      companyId: OTHER_ID,
    });
    const shopify = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Egypt",
      credentials: {
        accessToken: "shpat-x",
        shopDomain: "enaya-eg.myshopify.com",
        webhookSecret: "whsec",
      },
    });
    const easy = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-key" },
    });

    const imported = await importOrders(store);
    assert.equal(imported.status, 200);
    assert.equal(imported.json.data.provider, "salla");
    assert.equal(imported.json.data.integrationId, store.id);
    assert.equal(imported.json.data.created, 1);
    assert.equal(fake.__db.orders[0].company_id, ENAYA_ID);

    const missing = await request("POST", "/api/orders/import", {
      token: employeeToken(),
      body: { from: FROM, to: TO },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "SHOPIFY_IMPORT_INTEGRATION_REQUIRED");

    const cross = await importOrders(other);
    assert.equal(cross.status, 403);
    assert.equal(cross.json.code, "INTEGRATION_NOT_OWNED");

    const shopifyDispatch = await request("POST", "/api/orders/import", {
      token: employeeToken(),
      body: { integrationId: shopify.id },
    });
    assert.equal(shopifyDispatch.status, 400);
    assert.equal(shopifyDispatch.json.code, "SHOPIFY_IMPORT_RANGE_INVALID");

    const easyDispatch = await request("POST", "/api/orders/import", {
      token: employeeToken(),
      body: { integrationId: easy.id, from: FROM, to: TO },
    });
    assert.equal(easyDispatch.status, 400);
    assert.equal(easyDispatch.json.code, "SHOPIFY_PROVIDER_MISMATCH");

    const disabled = await createConnectedSalla(platform, { name: "Disabled" });
    markConnected(disabled.id, { enabled: false });
    const disabledImport = await importOrders(disabled);
    assert.equal(disabledImport.status, 409);
    assert.equal(disabledImport.json.code, "INTEGRATION_DISABLED");

    const pending = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Pending",
    });
    const pendingImport = await importOrders(pending);
    assert.equal(pendingImport.status, 409);
    assert.equal(pendingImport.json.code, "SALLA_AUTHORIZATION_PENDING");

    const revoked = await createConnectedSalla(platform, { name: "Revoked" });
    markConnected(revoked.id, { authorizationStatus: "revoked" });
    const revokedImport = await importOrders(revoked);
    assert.equal(revokedImport.status, 401);
    assert.equal(revokedImport.json.code, "SALLA_AUTHORIZATION_REVOKED");

    const legacy = await createConnectedSalla(platform, { name: "Legacy" });
    markConnected(legacy.id, { refreshToken: "" });
    const legacyImport = await importOrders(legacy);
    assert.equal(legacyImport.status, 409);
    assert.equal(legacyImport.json.code, "SALLA_AUTHORIZATION_LEGACY");
  });

  it("10-17. calendar range validation without UTC shift", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    const jwt = employeeToken();

    const missingFrom = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, to: TO },
    });
    assert.equal(missingFrom.status, 400);
    assert.equal(missingFrom.json.code, "SALLA_IMPORT_RANGE_INVALID");

    const missingTo = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, from: FROM },
    });
    assert.equal(missingTo.status, 400);
    assert.equal(missingTo.json.code, "SALLA_IMPORT_RANGE_INVALID");

    const invalid = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, from: "nope", to: TO },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "SALLA_IMPORT_RANGE_INVALID");

    const backwards = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, from: TO, to: FROM },
    });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.json.code, "SALLA_IMPORT_RANGE_INVALID");

    const huge = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, from: "2026-08-01", to: "2026-09-01" },
    });
    assert.equal(huge.status, 400);
    assert.equal(huge.json.code, "SALLA_IMPORT_RANGE_TOO_LARGE");

    const max = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, from: FROM, to: TO },
    });
    assert.equal(max.status, 200);
    assert.equal(max.json.data.from, FROM);
    assert.equal(max.json.data.to, TO);
    assert.equal(MAX_RANGE_DAYS, 31);

    const iso = await request("POST", "/api/orders/import", {
      token: jwt,
      body: {
        integrationId: store.id,
        from: "2026-08-01T21:00:00.000Z",
        to: TO,
      },
    });
    assert.equal(iso.status, 400);
    assert.equal(iso.json.code, "SALLA_IMPORT_RANGE_INVALID");
    assert.match(httpGets[0], /from_date=2026-08-01/);
    assert.match(httpGets[0], /to_date=2026-08-31/);
    assert.equal(httpGets[0].includes("T21:00:00"), false);
  });

  it("18-23. page pagination, bound, continuation, and no infinite loop", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    orderPages = {};
    for (let page = 1; page <= 12; page += 1) {
      const id = 1000 + page;
      orderPages[page] = listPayload([listSummary(id)], { page, totalPages: 12 });
      orderDetails[String(id)] = sampleOrderData({ id });
    }
    const first = await importOrders(store);
    assert.equal(first.status, 200);
    assert.equal(first.json.data.hasMore, true);
    assert.equal(first.json.data.nextPage, MAX_ORDER_PAGES + 1);
    assert.equal(first.json.data.pagesFetched, MAX_ORDER_PAGES);
    assert.equal(
      httpGets.filter((url) => url.includes("/admin/v2/orders?")).length,
      MAX_ORDER_PAGES,
    );

    httpGets = [];
    const resume = await importOrders(store, { page: first.json.data.nextPage });
    assert.equal(resume.status, 200);
    assert.equal(
      httpGets.some((url) => url.includes("page=6") && url.includes("from_date=2026-08-01")),
      true,
    );
    const otherResume = await importOrders(store, { page: 6 }, employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local"));
    assert.equal(otherResume.status, 403);
  });

  it("24-37. B3 identity, cart contract, catalog linking, and missing product import", async () => {
    const platform = await loginPlatform();
    const storeA = await createConnectedSalla(platform, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(platform, { name: "Store B", merchantId: MERCHANT_B });
    fake.__db.products.push(
      {
        id: PRODUCT_A_ID,
        company_id: ENAYA_ID,
        source_integration_id: storeA.id,
        easyorder_id: "632910392",
        name: "Serum A",
      },
      {
        id: PRODUCT_B_ID,
        company_id: ENAYA_ID,
        source_integration_id: storeB.id,
        easyorder_id: "632910392",
        name: "Serum B",
      },
    );

    const source = fs.readFileSync(
      path.join(__dirname, "../src/services/sallaOrderImport.service.js"),
      "utf8",
    );
    assert.match(source, /persistSallaOrder/);
    assert.match(source, /normalizeSallaOrder|sallaOrders\.service/);
    assert.equal(source.includes("function normalizeCustomer"), false);

    const imported = await importOrders(storeA);
    assert.equal(imported.status, 200);
    const row = fake.__db.orders[0];
    assert.equal(row.order_id, "203948534");
    assert.notEqual(row.order_id, "554433");
    assert.equal(row.raw_data.full_name, "Layla Hassan");
    assert.equal(row.raw_data.phone, "0551234567");
    assert.equal(row.raw_data.email, "layla@example.com");
    assert.match(row.raw_data.address, /King Fahd Rd/);
    assert.equal(row.raw_data.city, "Riyadh");
    assert.equal(row.raw_data.currency, "SAR");
    assert.equal(String(row.raw_data.total), "215");
    assert.equal(row.raw_data.cart_items[0].product_id, "632910392");
    assert.equal(row.raw_data.cart_items[0].variant_id, "99001");
    assert.equal(row.raw_data.cart_items[0].catalogProductId, PRODUCT_A_ID);
    assert.equal(row.raw_data.salla.ingested_via, "historical_import");
    assert.equal(row.ingestion_source, "salla");

    orderPages = {
      1: listPayload([listSummary(203948534)], { page: 1, totalPages: 1 }),
    };
    await importOrders(storeB);
    const storeBRow = fake.__db.orders.find((item) => item.source_integration_id === storeB.id);
    assert.ok(storeBRow);
    assert.notEqual(storeBRow.id, row.id);
    assert.equal(storeBRow.raw_data.cart_items[0].catalogProductId, PRODUCT_B_ID);

    orderPages = {
      1: listPayload([listSummary(77)], { page: 1, totalPages: 1 }),
    };
    orderDetails[77] = sampleOrderData({
      id: 77,
      items: [
        {
          id: 9,
          name: "Unknown",
          quantity: 1,
          product_sku_id: 12,
          product: { id: 999 },
        },
      ],
    });
    const missingProduct = await importOrders(storeA);
    assert.equal(missingProduct.status, 200);
    const unknown = fake.__db.orders.find((item) => item.order_id === "77");
    assert.ok(unknown);
    assert.equal(unknown.raw_data.cart_items[0].catalogProductId, undefined);
  });

  it("38-44. UUID idempotency across import/webhook and order_reference", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    const first = await importOrders(store);
    assert.equal(first.json.data.created, 1);
    const localId = fake.__db.orders[0].id;
    const reference = fake.__db.orders[0].order_reference;
    assert.ok(reference);

    const repeat = await importOrders(store);
    assert.equal(repeat.json.data.updated, 1);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].id, localId);
    assert.equal(fake.__db.orders[0].order_reference, reference);

    const webhook = await signedSallaWebhook(store.webhookUrl, { envelope: sampleEnvelope() });
    assert.equal(webhook.status, 200);
    assert.equal(webhook.json.data.id, localId);

    fake.__db.orders = [];
    const createdHook = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({ data: { id: 44 } }),
    });
    orderPages = { 1: listPayload([listSummary(44)], { page: 1, totalPages: 1 }) };
    orderDetails[44] = sampleOrderData({ id: 44 });
    const afterHook = await importOrders(store);
    assert.equal(afterHook.json.data.updated, 1);
    assert.equal(fake.__db.orders[0].id, createdHook.json.data.id);
    assert.equal(fake.__db.orders[0].order_id, "44");
  });

  it("45-54. status preservation, freshness, and cancellation safety", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    orderDetails[203948534] = sampleOrderData({
      status: { slug: "canceled", name: "Canceled" },
    });
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "canceled");

    fake.__db.orders = [];
    orderDetails[203948534] = sampleOrderData({
      status: { slug: "completed", name: "Completed" },
      payment_method: "paid",
    });
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "new");
    assert.notEqual(fake.__db.orders[0].status, "Confirmed");
    assert.notEqual(fake.__db.orders[0].status, "Shipped");

    fake.__db.orders = [];
    orderDetails[203948534] = sampleOrderData({
      status: { slug: "delivered", name: "Delivered" },
    });
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "new");

    fake.__db.orders[0].status = "Confirmed";
    fake.__db.orders[0].raw_data.status = "Confirmed";
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "Confirmed");

    fake.__db.orders[0].status = "Shipped";
    fake.__db.orders[0].raw_data.status = "Shipped";
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "Shipped");

    fake.__db.orders[0].status = "no_replay";
    fake.__db.orders[0].raw_data.status = "no_replay";
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "no_replay");

    fake.__db.orders[0].status = "follow up";
    fake.__db.orders[0].raw_data.status = "follow up";
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "follow up");

    await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.updated",
        data: { email: "new@example.com", updated_at: { date: "2026-08-18 18:00:00" } },
      }),
    });
    orderDetails[203948534] = sampleOrderData({
      email: "stale@example.com",
      customer: {
        id: 88,
        first_name: "Old",
        last_name: "Name",
        mobile: "0550000000",
        email: "stale@example.com",
      },
      updated_at: { date: "2026-08-18 09:00:00" },
    });
    await importOrders(store);
    assert.equal(fake.__db.orders[0].raw_data.email, "new@example.com");
    assert.equal(fake.__db.orders[0].raw_data.full_name, "Layla Hassan");

    orderDetails[203948534] = sampleOrderData({
      status: { slug: "canceled" },
      updated_at: { date: "2026-08-18 19:00:00" },
    });
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "canceled");
    assert.equal(fake.__db.orders[0].raw_data.full_name, "Layla Hassan");
  });

  it("55-63. races, partial failure, provider errors, and safe response", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    const integration = rowById(store.id);
    const [first, second] = await Promise.all([
      runWithTenantContext({ companyId: ENAYA_ID, integration }, () =>
        persistSallaOrder({
          companyId: ENAYA_ID,
          sourceIntegrationId: store.id,
          integration,
          merchantId: MERCHANT_A,
          event: "order.created",
          ingestedVia: "historical_import",
          data: sampleOrderData({ id: 88 }),
        }),
      ),
      runWithTenantContext({ companyId: ENAYA_ID, integration }, () =>
        persistSallaOrder({
          companyId: ENAYA_ID,
          sourceIntegrationId: store.id,
          integration,
          merchantId: MERCHANT_A,
          event: "order.created",
          ingestedVia: "webhook",
          data: sampleOrderData({ id: 88 }),
        }),
      ),
    ]);
    assert.equal(first.id, second.id);

    orderPages = {
      1: listPayload(
        [listSummary(203948534), { reference_id: 9 }, listSummary(66), listSummary(77)],
        { page: 1, totalPages: 1 },
      ),
    };
    orderDetails[66] = "missing";
    orderDetails[77] = "truncated";
    const partial = await importOrders(store);
    assert.equal(partial.status, 200);
    assert.equal(partial.json.data.created >= 1, true);
    assert.equal(partial.json.data.skipped >= 3, true);
    assert.equal(
      partial.json.data.errors.some((item) => item.code === "SALLA_ORDER_ID_REQUIRED"),
      true,
    );
    assert.equal(
      partial.json.data.errors.some((item) => item.code === "SALLA_ORDER_DETAIL_FAILED"),
      true,
    );
    assert.equal(
      partial.json.data.errors.some((item) => item.code === "SALLA_ORDER_ITEMS_TRUNCATED"),
      true,
    );
    assert.equal(fake.__db.orders.some((row) => row.order_id === "77"), false);
    assert.equal(JSON.stringify(partial.json).includes("access-salla"), false);
    assert.equal(JSON.stringify(partial.json).includes("0551234567"), false);

    fake.__db.orders = [];
    await importOrders(store);
    const beforeFail = fake.__db.orders.length;
    getImpl = async () => ({ status: 429, headers: { "retry-after": "0" }, data: {} });
    const limited = await importOrders(store);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, "SALLA_RATE_LIMITED");
    assert.equal(fake.__db.orders.length, beforeFail);

    getImpl = async () => ({ status: 503, headers: {}, data: {} });
    const down = await importOrders(store);
    assert.equal(down.status, 502);
    assert.equal(down.json.code, "SALLA_PROVIDER_UNAVAILABLE");
    assert.equal(fake.__db.orders.length, beforeFail);
    assert.equal(fake.__db.orders[0].order_id, "203948534");
    assert.notEqual(fake.__db.orders[0].raw_data.salla.ingested_via, fake.__db.orders[0].order_id);
  });

  it("70-83. dashboard, EasyConfirm, Bosta, regressions, no SQL", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    fake.__db.products.push({
      id: PRODUCT_A_ID,
      company_id: ENAYA_ID,
      source_integration_id: store.id,
      easyorder_id: "632910392",
      name: "Serum",
    });
    const imported = await importOrders(store);
    assert.equal(imported.status, 200);
    const jwt = employeeToken();
    const listed = await request("GET", `/api/orders?${RANGE}`, { token: jwt });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.some((row) => row.order_id === "203948534"), true);

    const filtered = await request(
      "GET",
      `/api/orders?${RANGE}&source_integration_id=${store.id}`,
      { token: jwt },
    );
    assert.equal(filtered.json.data.every((row) => row.source_integration_id === store.id), true);

    const stats = await request("GET", `/api/orders/stats?${RANGE}`, { token: jwt });
    assert.equal(stats.status, 200);
    const analytics = await request("GET", `/api/orders/analytics?${RANGE}`, { token: jwt });
    assert.notEqual(analytics.status, 500);

    const easyConfirm = await request(
      "POST",
      `/api/orders/${fake.__db.orders[0].id}/refresh-customer-status`,
      { token: jwt },
    );
    assert.equal(easyConfirm.status, 409);
    assert.equal(easyConfirm.json.code, "EASYCONFIRM_NOT_EASYORDERS");

    const line = fake.__db.orders[0].raw_data.cart_items[0];
    const catalog = await runWithTenantContext({ companyId: ENAYA_ID }, () =>
      resolveLineCatalogProduct(line, store.id),
    );
    assert.equal(catalog.id, PRODUCT_A_ID);
    assert.equal(
      fake.__db.orders.every((row) => !row.raw_data.bosta_order_id && !row.raw_data.sent_to_bosta),
      true,
    );

    const hook = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({ data: { id: 501 } }),
    });
    assert.equal(hook.status, 200);

    const sync = await request("POST", "/api/products/sync", {
      token: jwt,
      body: { integrationId: store.id, provider: "salla" },
    });
    assert.notEqual(sync.json?.code, "COMMERCE_SYNC_NOT_IMPLEMENTED");

    const connect = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/salla/connect`,
      { token: platform },
    );
    assert.equal(connect.status, 200);

    const migrations = fs.readdirSync(path.join(__dirname, "../supabase/migrations"));
    assert.equal(migrations.some((name) => name.startsWith("014_")), true);
    assert.equal(
      migrations.some(
        (name) => name.startsWith("015_") && name !== "015_atomic_company_signup.sql",
      ),
      false,
    );
    assert.equal(MAX_ORDER_PAGES, 5);
    assert.equal(ORDER_PAGE_SIZE, 30);
  });
});
