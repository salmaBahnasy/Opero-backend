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
const { encryptJson, decryptJson } = require("../src/config/integrationSecrets");
const { resetSallaRefreshLocksForTests } = require("../src/services/sallaClient.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_A_ID = "c1111111-aaaa-4111-8111-111111111111";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "salla-app-webhook-secret";
const MERCHANT_A = "1001";
const MERCHANT_B = "2002";
const RANGE = "from=2020-01-01&to=2030-12-31";

let passwordHash;
let server;
let baseUrl;
let fake;
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

async function request(method, pathName, { token, body, headers = {}, raw, redirect } = {}) {
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
    redirect: redirect === "manual" ? "manual" : "follow",
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return {
    status: response.status,
    json,
    text,
    location: response.headers.get("location") || "",
  };
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
    ],
    orders: [],
    products: [],
    bosta_sku_mappings: [],
    bosta_unmapped_products: [],
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

async function createConnectedSalla(token, extras = {}) {
  const created = await createConnection(token, extras.companyId || ENAYA_ID, {
    category: "commerce",
    provider: "salla",
    name: extras.name || "Enaya Salla",
    enabled: true,
  });
  markConnected(created.id, extras);
  return created;
}

function sampleOrderData(overrides = {}) {
  return {
    id: 203948534,
    reference_id: 554433,
    currency: "SAR",
    amounts: { total: { amount: 215, currency: "SAR" } },
    customer: { first_name: "Layla", last_name: "Hassan", mobile: "0551234567" },
    shipping: { address: { city: "Riyadh", shipping_address: "King Fahd Rd" } },
    items: [
      {
        name: "Serum",
        quantity: 1,
        product_sku_id: 99001,
        product: { id: 632910392 },
      },
    ],
    status: { slug: "in_progress" },
    ...overrides,
  };
}

function envelope({ event = "app.uninstalled", merchant = Number(MERCHANT_A), data } = {}) {
  return {
    event,
    merchant,
    created_at: "2026-09-18T10:05:00Z",
    company_id: OTHER_ID,
    data: data || { id: 1 },
  };
}

async function signedLifecycle(bodyObj, { secret, pathName = "/webhooks/salla/app" } = {}) {
  const raw = JSON.stringify(bodyObj);
  return request("POST", pathName, {
    raw,
    headers: {
      "Content-Type": "application/json",
      "X-Salla-Security-Strategy": "Signature",
      "X-Salla-Signature": sallaSignature(Buffer.from(raw), secret || WEBHOOK_SECRET),
    },
  });
}

async function signedOrderWebhook(webhookUrl, bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const token = tokenFromWebhookUrl(webhookUrl);
  return request("POST", `/webhooks/salla/${encodeURIComponent(token)}/orders`, {
    raw,
    headers: {
      "Content-Type": "application/json",
      "X-Salla-Security-Strategy": "Signature",
      "X-Salla-Signature": sallaSignature(Buffer.from(raw)),
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
  axios.get = async () => ({
    status: 200,
    data: { data: { merchant: { id: Number(MERCHANT_A), name: "Enaya Store" } } },
    headers: {},
  });
  axios.post = async (_url, body) => {
    const params = new URLSearchParams(String(body || ""));
    if (params.get("grant_type") === "authorization_code") {
      return {
        status: 200,
        data: {
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        },
        headers: {},
      };
    }
    return { status: 200, data: {}, headers: {} };
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

describe("PHASE 7I-B7 Salla final hardening", () => {
  it("1-10. signed uninstall revokes exact store without deleting history", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    fake.__db.orders.push({
      id: "ord-salla",
      company_id: ENAYA_ID,
      order_id: "203948534",
      source_integration_id: store.id,
      ingestion_source: "salla",
      status: "new",
    });
    fake.__db.products.push({
      id: PRODUCT_A_ID,
      company_id: ENAYA_ID,
      source_integration_id: store.id,
      easyorder_id: "632910392",
      name: "Serum",
    });

    const unsigned = await request("POST", "/webhooks/salla/app", {
      raw: JSON.stringify(envelope()),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.json.code, "SALLA_WEBHOOK_HMAC_INVALID");
    assert.equal(rowById(store.id).settings.authorizationStatus, "connected");

    const invalid = await signedLifecycle(envelope(), { secret: "wrong" });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.json.code, "SALLA_WEBHOOK_HMAC_INVALID");

    const unknown = await signedLifecycle(envelope({ merchant: 9999 }));
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.code, "SALLA_EVENT_IGNORED");
    assert.equal(rowById(store.id).settings.authorizationStatus, "connected");

    const authorize = await signedLifecycle(envelope({ event: "app.store.authorize" }));
    assert.equal(authorize.status, 200);
    assert.equal(authorize.json.code, "SALLA_EVENT_IGNORED");
    assert.equal(rowById(store.id).settings.authorizationStatus, "connected");

    const uninstalled = await signedLifecycle(envelope());
    assert.equal(uninstalled.status, 200);
    assert.equal(uninstalled.json.code, "SALLA_UNINSTALLED");
    assert.equal(uninstalled.json.integrationId, store.id);
    assert.equal(JSON.stringify(uninstalled.json).includes("access-salla"), false);
    assert.equal(JSON.stringify(uninstalled.json).includes(OTHER_ID), false);

    const row = rowById(store.id);
    assert.ok(row);
    assert.equal(row.settings.authorizationStatus, "revoked");
    assert.equal(row.provider_account_id, MERCHANT_A);
    assert.equal(row.settings.merchantName, "Enaya Store");
    const secrets = decryptJson(row.credentials);
    assert.equal(Boolean(secrets.accessToken), false);
    assert.equal(Boolean(secrets.refreshToken), false);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.products[0].source_integration_id, store.id);

    const jwt = employeeToken();
    const bootstrap = await request("GET", "/api/company/bootstrap", { token: jwt });
    const names = (bootstrap.json.data.integrations.commerce || []).map((item) => item.name);
    assert.equal(names.includes("Enaya Salla"), false);

    const sync = await request("POST", "/api/products/sync", {
      token: jwt,
      body: { integrationId: store.id, provider: "salla" },
    });
    assert.equal(sync.status, 401);
    assert.equal(sync.json.code, "SALLA_AUTHORIZATION_REVOKED");

    const imported = await request("POST", "/api/orders/import", {
      token: jwt,
      body: { integrationId: store.id, from: "2026-08-01", to: "2026-08-31" },
    });
    assert.equal(imported.status, 401);
    assert.equal(imported.json.code, "SALLA_AUTHORIZATION_REVOKED");
  });

  it("11-12. reconnect same merchant preserves UUID; different merchant is rejected", async () => {
    const platform = await loginPlatform();
    const store = await createConnectedSalla(platform);
    const localId = store.id;
    fake.__db.orders.push({
      id: "ord-keep",
      company_id: ENAYA_ID,
      order_id: "44",
      source_integration_id: store.id,
      ingestion_source: "salla",
      status: "new",
    });
    await signedLifecycle(envelope());
    assert.equal(rowById(store.id).settings.authorizationStatus, "revoked");

    const connect = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/salla/connect`,
      { token: platform },
    );
    assert.equal(connect.status, 200);
    const state = new URL(connect.json.data.authorizationUrl).searchParams.get("state");
    const callback = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    assert.match(callback.location, /salla=connected/);
    const after = rowById(localId);
    assert.equal(after.id, localId);
    assert.equal(after.settings.authorizationStatus, "connected");
    assert.equal(after.provider_account_id, MERCHANT_A);
    assert.equal(decryptJson(after.credentials).accessToken, "access-new");
    assert.equal(fake.__db.orders[0].source_integration_id, localId);

    await signedLifecycle(envelope());
    axios.get = async () => ({
      status: 200,
      data: { data: { merchant: { id: Number(MERCHANT_B), name: "Other" } } },
      headers: {},
    });
    const connect2 = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/salla/connect`,
      { token: platform },
    );
    const state2 = new URL(connect2.json.data.authorizationUrl).searchParams.get("state");
    const mismatch = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=auth-code&state=${encodeURIComponent(state2)}&company_id=${OTHER_ID}`,
      { redirect: "manual" },
    );
    assert.equal(mismatch.status, 302);
    assert.match(mismatch.location, /SALLA_MERCHANT_MISMATCH/);
    assert.equal(rowById(store.id).id, localId);
    assert.equal(rowById(store.id).provider_account_id, MERCHANT_A);
  });

  it("13-18. delete is blocked when orders or products exist; empty can delete; disable works", async () => {
    const platform = await loginPlatform();
    const withOrders = await createConnectedSalla(platform, { name: "With Orders" });
    fake.__db.orders.push({
      id: "ord-block",
      company_id: ENAYA_ID,
      order_id: "1",
      source_integration_id: withOrders.id,
      ingestion_source: "salla",
      status: "new",
    });
    const blockedOrders = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${withOrders.id}`,
      { token: platform },
    );
    assert.equal(blockedOrders.status, 409);
    assert.equal(blockedOrders.json.code, "INTEGRATION_IN_USE");
    assert.equal(Boolean(rowById(withOrders.id)), true);
    assert.equal(fake.__db.orders[0].source_integration_id, withOrders.id);

    const withProducts = await createConnectedSalla(platform, {
      name: "With Products",
      merchantId: MERCHANT_B,
    });
    fake.__db.products.push({
      id: PRODUCT_A_ID,
      company_id: ENAYA_ID,
      source_integration_id: withProducts.id,
      easyorder_id: "123",
      name: "Catalog",
    });
    const blockedProducts = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${withProducts.id}`,
      { token: platform },
    );
    assert.equal(blockedProducts.status, 409);
    assert.equal(blockedProducts.json.code, "INTEGRATION_IN_USE");
    assert.equal(fake.__db.products[0].source_integration_id, withProducts.id);

    const shopify = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Catalog",
      credentials: {
        accessToken: "shpat-x",
        webhookSecret: "whsec",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    fake.__db.products.push({
      id: "c3333333-cccc-4333-8333-333333333333",
      company_id: ENAYA_ID,
      source_integration_id: shopify.id,
      easyorder_id: "555",
      name: "Shopify product",
    });
    const blockedShopify = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${shopify.id}`,
      { token: platform },
    );
    assert.equal(blockedShopify.status, 409);
    assert.equal(blockedShopify.json.code, "INTEGRATION_IN_USE");

    const withBosta = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta mapping store",
      credentials: { apiKey: "bosta-key" },
    });
    fake.__db.bosta_sku_mappings.push({
      id: "map-1",
      company_id: ENAYA_ID,
      shipping_integration_id: withBosta.id,
      product_id: PRODUCT_A_ID,
    });
    const blockedBosta = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${withBosta.id}`,
      { token: platform },
    );
    assert.equal(blockedBosta.status, 409);
    assert.equal(blockedBosta.json.code, "INTEGRATION_IN_USE");
    assert.equal(fake.__db.bosta_sku_mappings[0].shipping_integration_id, withBosta.id);

    const empty = await createConnectedSalla(platform, {
      name: "Empty Salla",
      merchantId: "3003",
    });
    const deleted = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${empty.id}`,
      { token: platform },
    );
    assert.equal(deleted.status, 200);
    assert.equal(Boolean(rowById(empty.id)), false);

    const disable = await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${withProducts.id}`,
      { token: platform, body: { enabled: false } },
    );
    assert.equal(disable.status, 200);
    assert.equal(rowById(withProducts.id).is_enabled, false);
    assert.equal(fake.__db.products[0].source_integration_id, withProducts.id);
  });

  it("19-36. regressions, isolation, EasyConfirm, Bosta, no SQL", async () => {
    const platform = await loginPlatform();
    const storeA = await createConnectedSalla(platform, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(platform, { name: "Store B", merchantId: MERCHANT_B });
    const created = await signedOrderWebhook(storeA.webhookUrl, {
      event: "order.created",
      merchant: Number(MERCHANT_A),
      company_id: OTHER_ID,
      data: sampleOrderData(),
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.code, "SALLA_WEBHOOK_ACCEPTED");
    const localId = created.json.data.id;

    const sibling = await signedOrderWebhook(storeB.webhookUrl, {
      event: "order.created",
      merchant: Number(MERCHANT_B),
      data: sampleOrderData({ id: 203948534 }),
    });
    assert.notEqual(sibling.json.data.id, localId);
    assert.equal(fake.__db.orders.length, 2);

    const perConnUninstall = await signedOrderWebhook(storeA.webhookUrl, envelope());
    assert.equal(perConnUninstall.status, 200);
    assert.equal(perConnUninstall.json.code, "SALLA_UNINSTALLED");
    assert.equal(rowById(storeA.id).settings.authorizationStatus, "revoked");
    assert.equal(rowById(storeB.id).settings.authorizationStatus, "connected");
    assert.equal(fake.__db.orders.length, 2);

    const jwt = employeeToken();
    const easyConfirm = await request(
      "POST",
      `/api/orders/${localId}/refresh-customer-status`,
      { token: jwt },
    );
    assert.equal(easyConfirm.status, 409);
    assert.equal(easyConfirm.json.code, "EASYCONFIRM_NOT_EASYORDERS");
    assert.equal(
      fake.__db.orders.every((row) => !row.raw_data?.bosta_order_id && !row.raw_data?.sent_to_bosta),
      true,
    );

    const listed = await request("GET", `/api/orders?${RANGE}`, { token: jwt });
    assert.equal(listed.status, 200);

    const shopifyHook = await request("POST", "/webhooks/shopify/not-a-token/orders", {
      body: { id: 1 },
    });
    assert.notEqual(shopifyHook.json?.code, "SALLA_UNINSTALLED");

    const blob = JSON.stringify({
      webhook: created.json,
      uninstall: perConnUninstall.json,
    });
    assert.equal(blob.includes("access-salla"), false);
    assert.equal(blob.includes("refresh-salla"), false);
    assert.equal(blob.includes("salla-client-secret"), false);

    const migrations = fs.readdirSync(path.join(__dirname, "../supabase/migrations"));
    assert.equal(migrations.some((name) => name.startsWith("014_")), true);
    assert.equal(
      migrations.some(
        (name) => name.startsWith("015_") && name !== "015_atomic_company_signup.sql",
      ),
      false,
    );
  });
});
