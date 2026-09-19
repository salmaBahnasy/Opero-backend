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
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");
const { encryptJson, decryptJson } = require("../src/config/integrationSecrets");
const { runWithTenantContext } = require("../src/utils/tenantScope");
const { resolveLineCatalogProduct } = require("../src/services/bostaShipping.service");
const { persistSallaProduct, MAX_PRODUCT_PAGES } = require("../src/services/sallaProducts.service");
const { persistSallaOrder } = require("../src/services/sallaOrders.service");
const {
  ensureSallaAccessToken,
  resetSallaRefreshLocksForTests,
} = require("../src/services/sallaClient.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEV_PASSWORD = "DevPassword123!";
const MERCHANT_A = "1001";
const MERCHANT_B = "2002";
const WEBHOOK_SECRET = "salla-app-webhook-secret";

let passwordHash;
let server;
let baseUrl;
let fake;
const originalAxiosGet = axios.get;
const originalAxiosPost = axios.post;
let productGets = [];
let productPages = {};

function tokenFromWebhookUrl(url) {
  const parts = String(url || "").split("/");
  const idx = parts.indexOf("webhooks");
  return idx >= 0 ? decodeURIComponent(parts[idx + 2] || "") : "";
}

function sallaSignature(raw) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
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
  return { status: response.status, json };
}

function employeeToken(companyId = ENAYA_ID, employeeId = ENAYA_ADMIN_ID, email = "admin@enaya.local") {
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
  return row;
}

async function createConnectedSalla(token, { name = "Enaya Salla", merchantId = MERCHANT_A, companyId = ENAYA_ID } = {}) {
  const created = await createConnection(token, companyId, {
    category: "commerce",
    provider: "salla",
    name,
    enabled: true,
  });
  markConnected(created.id, { merchantId });
  return created;
}

function sampleSku(overrides = {}) {
  return {
    id: 99001,
    sku: "SERUM-30",
    price: { amount: 100, currency: "SAR" },
    regular_price: { amount: 120, currency: "SAR" },
    stock_quantity: 8,
    related_options: [11],
    is_default: true,
    ...overrides,
  };
}

function sampleProduct(overrides = {}) {
  return {
    id: 632910392,
    name: "Serum 30ml",
    sku: "SERUM-30",
    status: "sale",
    quantity: 8,
    price: { amount: 100, currency: "SAR" },
    main_image: "https://cdn.example/serum.jpg",
    images: [{ id: 1, url: "https://cdn.example/serum.jpg", main: true }],
    options: [
      {
        id: 1,
        name: "Size",
        values: [{ id: 11, name: "30ml" }],
      },
    ],
    skus: [sampleSku()],
    ...overrides,
  };
}

function listPayload(products, { page = 1, totalPages = 1 } = {}) {
  return {
    status: 200,
    success: true,
    data: products,
    pagination: {
      count: products.length,
      total: totalPages,
      perPage: 50,
      currentPage: page,
      totalPages,
      links: {
        next:
          page < totalPages
            ? `https://api.salla.dev/admin/v2/products?page=${page + 1}`
            : null,
      },
    },
  };
}

function mockSallaCatalog() {
  axios.get = async (url) => {
    const href = String(url || "");
    productGets.push(href);
    if (href.includes("/admin/v2/products?") || /\/products\?page=/.test(href)) {
      const page = Number(new URL(href).searchParams.get("page") || 1);
      const payload = productPages[page] || listPayload([], { page, totalPages: 1 });
      return { status: 200, data: payload, headers: {} };
    }
    const detail = href.match(/\/products\/(\d+)/);
    if (detail) {
      const found = Object.values(productPages)
        .flatMap((payload) => payload.data || [])
        .find((item) => String(item.id) === String(detail[1]));
      return { status: 200, data: { data: found || sampleProduct({ id: Number(detail[1]) }) }, headers: {} };
    }
    return { status: 200, data: { data: { merchant: { id: Number(MERCHANT_A) } } }, headers: {} };
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
  resetSallaRefreshLocksForTests();
  productGets = [];
  productPages = {
    1: listPayload([sampleProduct()], { page: 1, totalPages: 1 }),
  };
  mockSallaCatalog();
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

describe("PHASE 7I-B4 Salla product/variant sync", () => {
  it("1-9. exact integration, auth gates, and provider mismatch", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const shopify = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify",
      credentials: {
        accessToken: "shpat-x",
        webhookSecret: "whsec",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    const easy = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-key" },
    });

    const missing = await request("POST", "/api/products/sync?provider=salla", {
      token: employeeToken(),
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "SALLA_INTEGRATION_REQUIRED");

    const ok = await request(
      "POST",
      `/api/products/sync?integrationId=${store.id}`,
      { token: employeeToken(), body: { company_id: OTHER_ID } },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.provider, "salla");
    assert.equal(ok.json.data.integrationId, store.id);
    assert.equal(fake.__db.products[0].company_id, ENAYA_ID);

    const otherStore = await createConnectedSalla(token, {
      name: "Other Salla",
      merchantId: "9",
      companyId: OTHER_ID,
    });
    const cross = await request(
      "POST",
      `/api/products/sync?integrationId=${otherStore.id}`,
      { token: employeeToken() },
    );
    assert.equal(cross.status, 403);

    const shopAsSalla = await request(
      "POST",
      `/api/products/sync?integrationId=${shopify.id}&provider=salla`,
      { token: employeeToken() },
    );
    assert.notEqual(shopAsSalla.status, 200);
    const eoAsSalla = await request(
      "POST",
      `/api/products/sync?integrationId=${easy.id}&provider=salla`,
      { token: employeeToken() },
    );
    assert.notEqual(eoAsSalla.status, 200);

    const disabled = await createConnectedSalla(token, { name: "Disabled" });
    markConnected(disabled.id, { enabled: false });
    const disabledSync = await request(
      "POST",
      `/api/products/sync?integrationId=${disabled.id}`,
      { token: employeeToken() },
    );
    assert.equal(disabledSync.status, 409);

    const pending = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Pending",
    });
    const pendingSync = await request(
      "POST",
      `/api/products/sync?integrationId=${pending.id}`,
      { token: employeeToken() },
    );
    assert.equal(pendingSync.status, 409);
    assert.equal(pendingSync.json.code, "SALLA_AUTHORIZATION_PENDING");

    const revoked = await createConnectedSalla(token, { name: "Revoked" });
    markConnected(revoked.id, { authorizationStatus: "revoked" });
    const revokedSync = await request(
      "POST",
      `/api/products/sync?integrationId=${revoked.id}`,
      { token: employeeToken() },
    );
    assert.equal(revokedSync.status, 401);
    assert.equal(revokedSync.json.code, "SALLA_AUTHORIZATION_REVOKED");

    const legacy = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Legacy",
      credentials: { accessToken: "legacy-only" },
    });
    const legacySync = await request(
      "POST",
      `/api/products/sync?integrationId=${legacy.id}`,
      { token: employeeToken() },
    );
    assert.equal(legacySync.status, 409);
    assert.equal(legacySync.json.code, "SALLA_AUTHORIZATION_LEGACY");
  });

  it("10-14. REST page pagination, max-page bound, hasMore, and continuation", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    productPages = {};
    for (let page = 1; page <= 8; page += 1) {
      productPages[page] = listPayload(
        [sampleProduct({ id: 1000 + page, name: `P${page}` })],
        { page, totalPages: 8 },
      );
    }
    const first = await request(
      "POST",
      `/api/products/sync?integrationId=${store.id}`,
      { token: employeeToken() },
    );
    assert.equal(first.status, 200);
    assert.equal(first.json.data.hasMore, true);
    assert.equal(first.json.data.nextPage, MAX_PRODUCT_PAGES + 1);
    assert.equal(first.json.data.pagesFetched, MAX_PRODUCT_PAGES);
    const listCalls = productGets.filter((url) => url.includes("per_page="));
    assert.equal(listCalls.length <= MAX_PRODUCT_PAGES, true);

    productGets = [];
    const cont = await request(
      "POST",
      `/api/products/sync?integrationId=${store.id}&page=${first.json.data.nextPage}`,
      { token: employeeToken() },
    );
    assert.equal(cont.status, 200);
    assert.equal(cont.json.data.integrationId, store.id);
    assert.equal(
      fake.__db.products.some((row) => row.easyorder_id === "1006"),
      true,
    );
  });

  it("15-35. identity, normalization, variants, secrets, and race", async () => {
    const token = await loginPlatform();
    const storeA = await createConnectedSalla(token, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(token, { name: "Store B", merchantId: MERCHANT_B });
    const shopify = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify",
      credentials: {
        accessToken: "shpat-x",
        webhookSecret: "whsec",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    fake.__db.products.push({
      id: "shop-prod-123",
      company_id: ENAYA_ID,
      easyorder_id: "632910392",
      source_integration_id: shopify.id,
      name: "Shopify Serum",
      sku: "SH-SERUM",
      raw_data: { provider: "shopify" },
    });

    const first = await request(
      "POST",
      `/api/products/sync?integrationId=${storeA.id}`,
      { token: employeeToken() },
    );
    assert.equal(first.status, 200);
    const rowA = fake.__db.products.find(
      (row) => row.source_integration_id === storeA.id && row.easyorder_id === "632910392",
    );
    assert.ok(rowA);
    assert.equal(typeof rowA.id, "string");
    assert.match(rowA.id, /^[0-9a-f-]{36}$/i);
    assert.equal(rowA.name, "Serum 30ml");
    assert.equal(rowA.sku, "SERUM-30");
    assert.equal(rowA.raw_data.image, "https://cdn.example/serum.jpg");
    assert.equal(rowA.is_active, true);
    assert.equal(rowA.source_integration_id, storeA.id);
    const variant = rowA.raw_data.variants[0];
    assert.equal(variant.id, "99001");
    assert.equal(variant.product_id, "632910392");
    assert.equal(variant.sku, "SERUM-30");
    assert.equal(String(variant.price), "100");
    assert.equal(variant.variation_props[0].variation_prop, "30ml");
    assert.equal(rowA.raw_data.provider, "salla");
    assert.equal(rowA.raw_data.platform, "salla");
    assert.equal(JSON.stringify(rowA.raw_data).includes("access-salla"), false);

    productPages = {
      1: listPayload(
        [sampleProduct({ name: "Serum 30ml updated", quantity: 0, status: "out" })],
        { page: 1, totalPages: 1 },
      ),
    };
    const repeat = await request(
      "POST",
      `/api/products/sync?integrationId=${storeA.id}`,
      { token: employeeToken() },
    );
    assert.equal(repeat.json.data.updated >= 1, true);
    const after = fake.__db.products.find((row) => row.id === rowA.id);
    assert.equal(after.id, rowA.id);
    assert.equal(after.name, "Serum 30ml updated");
    assert.equal(after.is_active, true);

    productPages = {
      1: listPayload([sampleProduct({ status: "hidden" })], { page: 1, totalPages: 1 }),
    };
    await request("POST", `/api/products/sync?integrationId=${storeA.id}`, {
      token: employeeToken(),
    });
    assert.equal(fake.__db.products.find((row) => row.id === rowA.id).is_active, false);

    productPages = {
      1: listPayload([sampleProduct()], { page: 1, totalPages: 1 }),
    };
    await request("POST", `/api/products/sync?integrationId=${storeB.id}`, {
      token: employeeToken(),
    });
    const rowB = fake.__db.products.find(
      (row) => row.source_integration_id === storeB.id && row.easyorder_id === "632910392",
    );
    assert.ok(rowB);
    assert.notEqual(rowB.id, rowA.id);
    assert.notEqual(rowB.id, "shop-prod-123");

    productPages = {
      1: listPayload(
        [
          sampleProduct({
            id: 55,
            sku_count: 5,
            skus: [sampleSku({ id: 1 })],
          }),
        ],
        { page: 1, totalPages: 1 },
      ),
    };
    axios.get = async (url) => {
      const href = String(url || "");
      productGets.push(href);
      if (href.includes("per_page=")) {
        return { status: 200, data: productPages[1], headers: {} };
      }
      if (/\/products\/55/.test(href)) {
        return {
          status: 200,
          data: { data: sampleProduct({ id: 55, sku_count: 5, skus: [sampleSku({ id: 1 })] }) },
          headers: {},
        };
      }
      return { status: 200, data: {}, headers: {} };
    };
    const truncated = await request(
      "POST",
      `/api/products/sync?integrationId=${storeA.id}`,
      { token: employeeToken() },
    );
    assert.equal(truncated.status, 200);
    assert.equal(
      truncated.json.data.errors.some((error) => error.code === "SALLA_PRODUCT_VARIANTS_TRUNCATED"),
      true,
    );
    assert.equal(
      fake.__db.products.some((row) => row.easyorder_id === "55"),
      false,
    );

    const integration = rowById(storeA.id);
    const [left, right] = await Promise.all([
      runWithTenantContext({ companyId: ENAYA_ID, integration }, () =>
        persistSallaProduct({
          sourceIntegrationId: storeA.id,
          normalized: {
            easyorder_id: "88",
            name: "Race",
            sku: "R-88",
            is_active: true,
            raw_data: { provider: "salla", variants: [] },
          },
        }),
      ),
      runWithTenantContext({ companyId: ENAYA_ID, integration }, () =>
        persistSallaProduct({
          sourceIntegrationId: storeA.id,
          normalized: {
            easyorder_id: "88",
            name: "Race",
            sku: "R-88",
            is_active: true,
            raw_data: { provider: "salla", variants: [] },
          },
        }),
      ),
    ]);
    assert.equal(left.id, right.id);
    assert.equal(fake.__db.products.filter((row) => row.easyorder_id === "88").length, 1);
  });

  it("36-45. missing pages do not delete; relink is source-scoped and bounded", async () => {
    const token = await loginPlatform();
    const storeA = await createConnectedSalla(token, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(token, { name: "Store B", merchantId: MERCHANT_B });
    await request("POST", `/api/products/sync?integrationId=${storeA.id}`, {
      token: employeeToken(),
    });
    const keptId = fake.__db.products.find((row) => row.easyorder_id === "632910392").id;
    productPages = {
      1: listPayload([sampleProduct({ id: 77, name: "Other", skus: [sampleSku({ id: 2 })] })], {
        page: 1,
        totalPages: 1,
      }),
    };
    await request("POST", `/api/products/sync?integrationId=${storeA.id}`, {
      token: employeeToken(),
    });
    assert.equal(fake.__db.products.some((row) => row.id === keptId), true);

    const catalogA = fake.__db.products.find(
      (row) => row.source_integration_id === storeA.id && row.easyorder_id === "632910392",
    );
    fake.__db.orders.push(
      {
        id: "ord-salla-a",
        company_id: ENAYA_ID,
        order_id: "203948534",
        source_integration_id: storeA.id,
        ingestion_source: "salla",
        status: "new",
        created_at: new Date().toISOString(),
        raw_data: {
          provider: "salla",
          cart_items: [{ product_id: "632910392", variant_id: "99001", name: "Serum", quantity: 1 }],
        },
      },
      {
        id: "ord-salla-b",
        company_id: ENAYA_ID,
        order_id: "203948534",
        source_integration_id: storeB.id,
        ingestion_source: "salla",
        status: "new",
        created_at: new Date().toISOString(),
        raw_data: {
          provider: "salla",
          cart_items: [{ product_id: "632910392", variant_id: "99001", name: "Serum B", quantity: 1 }],
        },
      },
      {
        id: "ord-shopify",
        company_id: ENAYA_ID,
        order_id: "632910392",
        source_integration_id: storeA.id,
        ingestion_source: "shopify",
        status: "new",
        created_at: new Date().toISOString(),
        raw_data: {
          provider: "shopify",
          cart_items: [{ product_id: "632910392", name: "Shopify" }],
        },
      },
      {
        id: "ord-eo",
        company_id: ENAYA_ID,
        order_id: "eo-1",
        source_integration_id: storeA.id,
        ingestion_source: "easyorders",
        status: "new",
        created_at: new Date().toISOString(),
        raw_data: {
          provider: "easyorders",
          cart_items: [{ product_id: "632910392", name: "EO" }],
        },
      },
    );
    for (let i = 0; i < 501; i += 1) {
      fake.__db.orders.push({
        id: `ord-fill-${i}`,
        company_id: ENAYA_ID,
        order_id: `fill-${i}`,
        source_integration_id: storeA.id,
        ingestion_source: "salla",
        status: "new",
        created_at: new Date().toISOString(),
        raw_data: { provider: "salla", cart_items: [] },
      });
    }
    productPages = {
      1: listPayload([sampleProduct()], { page: 1, totalPages: 1 }),
    };
    const relinked = await request(
      "POST",
      `/api/products/sync?integrationId=${storeA.id}`,
      { token: employeeToken() },
    );
    assert.equal(relinked.json.data.relinkHasMore, true);
    const orderA = fake.__db.orders.find((row) => row.id === "ord-salla-a");
    assert.equal(orderA.raw_data.cart_items[0].catalogProductId, catalogA.id);
    assert.equal(
      fake.__db.orders.find((row) => row.id === "ord-salla-b").raw_data.cart_items[0]
        .catalogProductId,
      undefined,
    );
    assert.equal(
      fake.__db.orders.find((row) => row.id === "ord-shopify").raw_data.cart_items[0]
        .catalogProductId,
      undefined,
    );
    assert.equal(
      fake.__db.orders.find((row) => row.id === "ord-eo").raw_data.cart_items[0].catalogProductId,
      undefined,
    );

    const line = orderA.raw_data.cart_items[0];
    const catalog = await runWithTenantContext({ companyId: ENAYA_ID }, () =>
      resolveLineCatalogProduct(line, storeA.id),
    );
    assert.equal(catalog.id, catalogA.id);
    assert.equal(line.product_id, catalogA.easyorder_id);
    assert.equal(line.variant_id, catalogA.raw_data.variants[0].id);
  });

  it("54-60. OAuth, webhook, Shopify/EO/Bosta regressions, no leakage", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const accepted = await request(
      "POST",
      `/api/products/sync?integrationId=${store.id}`,
      { token: employeeToken() },
    );
    assert.equal(JSON.stringify(accepted.json).includes("access-salla"), false);
    assert.equal(JSON.stringify(accepted.json).includes("salla-client-secret"), false);

    const connect = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/salla/connect`,
      { token },
    );
    assert.equal(connect.status, 200);
    markConnected(store.id, {
      tokenExpiresAt: new Date(Date.now() + 10 * 1000).toISOString(),
    });
    axios.post = async () => ({
      status: 200,
      data: { access_token: "access-refreshed", refresh_token: "refresh-rotated", expires_in: 3600 },
    });
    await ensureSallaAccessToken(rowById(store.id), { allowDisabled: true });
    assert.equal(decryptJson(rowById(store.id).credentials).refreshToken, "refresh-rotated");
    mockSallaCatalog();

    const envelope = JSON.stringify({
      event: "order.created",
      merchant: Number(MERCHANT_A),
      data: {
        id: 203948534,
        currency: "SAR",
        amounts: { total: { amount: 10, currency: "SAR" } },
        items: [{ product: { id: 632910392 }, product_sku_id: 99001, quantity: 1, name: "Serum" }],
      },
    });
    const hook = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(store.webhookUrl)}/orders`,
      {
        raw: envelope,
        headers: {
          "Content-Type": "application/json",
          "X-Salla-Security-Strategy": "Signature",
          "X-Salla-Signature": sallaSignature(envelope),
        },
      },
    );
    assert.equal(hook.status, 200);
    assert.equal(hook.json.code, "SALLA_WEBHOOK_ACCEPTED");

    const shopify = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify",
      credentials: {
        accessToken: "shpat-x",
        webhookSecret: "whsec",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    const shopSync = await request(
      "POST",
      `/api/products/sync?integrationId=${shopify.id}`,
      { token: employeeToken() },
    );
    assert.notEqual(shopSync.json?.code, "SALLA_INTEGRATION_REQUIRED");

    const easy = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-key" },
    });
    const originalGet = axios.get;
    axios.get = async (url, config = {}) => {
      if (String(url).includes("easy-orders") || String(url).includes("/products")) {
        return { status: 200, data: [{ id: "eo-1", name: "EO" }], headers: {}, config };
      }
      return originalGet(url, config);
    };
    const eoSync = await request(
      "POST",
      `/api/products/sync?integrationId=${easy.id}`,
      { token: employeeToken() },
    );
    assert.equal(eoSync.status, 200);
    axios.get = originalGet;

    const bosta = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta",
      credentials: { apiKey: "bosta-secret" },
    });
    fake.__db.orders.push({
      id: "ord-bosta-prod-salla",
      company_id: ENAYA_ID,
      order_id: "ALIAS-SALLA-PROD",
      status: "Shipped",
      shipping_integration_id: bosta.id,
      created_at: new Date().toISOString(),
      raw_data: { bosta_order_alias: "ALIAS-SALLA-PROD" },
    });
    const bostaHook = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-SALLA-PROD", status: "Delivered" } },
    );
    assert.equal(bostaHook.status, 200);
    void persistSallaOrder;
  });
});
