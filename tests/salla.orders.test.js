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
const { runWithTenantContext } = require("../src/utils/tenantScope");
const { persistSallaOrder } = require("../src/services/sallaOrders.service");
const { ensureSallaAccessToken, resetSallaRefreshLocksForTests } = require("../src/services/sallaClient.service");
const { resolveLineCatalogProduct } = require("../src/services/bostaShipping.service");

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

function sampleOrderData(overrides = {}) {
  return {
    id: 203948534,
    reference_id: 554433,
    date: { date: "2026-09-18 10:00:00" },
    updated_at: { date: "2026-09-18 10:05:00" },
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
      mobile_code: "+966",
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

function sampleEnvelope({ event = "order.created", merchant = Number(MERCHANT_A), data, companyId } = {}) {
  return {
    event,
    merchant,
    created_at: "2026-09-18T10:05:00Z",
    company_id: companyId || OTHER_ID,
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

describe("PHASE 7I-B3 Salla webhook security + order persistence", () => {
  it("1-10. signature, token, strategy, merchant, and auth gates reject without writes", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const envelope = sampleEnvelope();

    const valid = await signedSallaWebhook(store.webhookUrl, { envelope });
    assert.equal(valid.status, 200);
    assert.equal(valid.json.code, "SALLA_WEBHOOK_ACCEPTED");
    assert.equal(valid.json.data.order_id, "203948534");
    assert.equal(JSON.stringify(valid.json).includes("0551234567"), false);

    const badToken = await signedSallaWebhook("https://api.example.test/webhooks/salla/not-real/orders", {
      envelope,
    });
    assert.equal(badToken.status, 401);

    const missingSig = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(store.webhookUrl)}/orders`,
      {
        raw: JSON.stringify(envelope),
        headers: {
          "Content-Type": "application/json",
          "X-Salla-Security-Strategy": "Signature",
        },
      },
    );
    assert.equal(missingSig.status, 401);
    assert.equal(missingSig.json.code, "SALLA_WEBHOOK_HMAC_INVALID");

    const invalidSig = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({ data: { id: 1 } }),
      secret: "wrong-secret",
    });
    assert.equal(invalidSig.status, 401);
    assert.equal(invalidSig.json.code, "SALLA_WEBHOOK_HMAC_INVALID");

    const wrongStrategy = await signedSallaWebhook(store.webhookUrl, {
      envelope,
      headers: { "X-Salla-Security-Strategy": "Token" },
    });
    assert.equal(wrongStrategy.status, 401);
    assert.equal(wrongStrategy.json.code, "SALLA_WEBHOOK_STRATEGY_INVALID");

    const raw =
      '{ "event": "order.created", "merchant": 1001, "data": { "id": 777, "reference_id": 12, "currency": "SAR", "amounts": { "total": { "amount": 9, "currency": "SAR" } }, "items": [{ "name": "Raw", "quantity": 1, "product": { "id": 77 } }] } }';
    const parsedDifferent = JSON.stringify(JSON.parse(raw));
    assert.notEqual(raw, parsedDifferent);
    const rawSigned = await signedSallaWebhook(store.webhookUrl, { raw });
    assert.equal(rawSigned.status, 200);
    assert.equal(rawSigned.json.code, "SALLA_WEBHOOK_ACCEPTED");

    const mismatch = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({ merchant: 9999, data: { id: 2 } }),
    });
    assert.equal(mismatch.status, 401);
    assert.equal(mismatch.json.code, "SALLA_MERCHANT_MISMATCH");

    const disabled = await createConnectedSalla(token, { name: "Disabled Salla" });
    markConnected(disabled.id, { enabled: false });
    const disabledHook = await signedSallaWebhook(disabled.webhookUrl, {
      envelope: sampleEnvelope({ data: { id: 3 } }),
    });
    assert.equal(disabledHook.status, 401);

    const pending = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Pending Salla",
    });
    const pendingHook = await signedSallaWebhook(pending.webhookUrl, {
      envelope: sampleEnvelope({ data: { id: 4 } }),
    });
    assert.equal(pendingHook.status, 409);
    assert.equal(pendingHook.json.code, "SALLA_AUTHORIZATION_PENDING");

    const revoked = await createConnectedSalla(token, { name: "Revoked Salla" });
    markConnected(revoked.id, { authorizationStatus: "revoked" });
    const revokedHook = await signedSallaWebhook(revoked.webhookUrl, {
      envelope: sampleEnvelope({ data: { id: 5 } }),
    });
    assert.equal(revokedHook.status, 401);
    assert.equal(revokedHook.json.code, "SALLA_AUTHORIZATION_REVOKED");

    assert.equal(
      fake.__db.orders.some((row) => ["1", "2", "3", "4", "5"].includes(String(row.order_id))),
      false,
    );
  });

  it("11-12. unknown and product events are ignored without writes", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const before = fake.__db.orders.length;
    const unknown = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({ event: "app.store.authorize", data: { id: 8 } }),
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.code, "SALLA_EVENT_IGNORED");
    const product = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({ event: "product.updated", data: { id: 9 } }),
    });
    assert.equal(product.status, 200);
    assert.equal(product.json.code, "SALLA_EVENT_IGNORED");
    assert.equal(fake.__db.orders.length, before);
  });

  it("13-23. created/updated/status/cancel/replay identity and ERP reference", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const created = await signedSallaWebhook(store.webhookUrl, { envelope: sampleEnvelope() });
    assert.equal(created.status, 200);
    const localId = created.json.data.id;
    assert.equal(fake.__db.orders[0].order_id, "203948534");
    assert.equal(fake.__db.orders[0].order_id, String(sampleOrderData().id));
    assert.notEqual(String(fake.__db.orders[0].order_id), "554433");
    assert.ok(fake.__db.orders[0].order_reference);

    const updated = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.updated",
        data: { email: "updated@example.com", updated_at: { date: "2026-09-18 11:00:00" } },
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.id, localId);
    assert.equal(fake.__db.orders.length, 1);
    const firstRef = fake.__db.orders[0].order_reference;

    const statusUpdated = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.status.updated",
        data: {
          id: 203948534,
          status: { slug: "in_progress" },
          updated_at: { date: "2026-09-18 11:30:00" },
        },
      }),
    });
    assert.equal(statusUpdated.json.data.id, localId);

    const cancelled = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.cancelled",
        data: {
          id: 203948534,
          status: { slug: "canceled" },
          updated_at: { date: "2026-09-18 12:00:00" },
        },
      }),
    });
    assert.equal(cancelled.json.data.id, localId);
    assert.equal(fake.__db.orders[0].status, "canceled");

    const replay = await signedSallaWebhook(store.webhookUrl, { envelope: sampleEnvelope() });
    assert.equal(replay.json.data.id, localId);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].order_reference, firstRef);
  });

  it("18-19. same Salla order id is isolated per store and body company_id is ignored", async () => {
    const token = await loginPlatform();
    const storeA = await createConnectedSalla(token, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(token, { name: "Store B", merchantId: MERCHANT_B });
    const a = await signedSallaWebhook(storeA.webhookUrl, {
      envelope: sampleEnvelope({ merchant: Number(MERCHANT_A), companyId: OTHER_ID }),
    });
    const b = await signedSallaWebhook(storeB.webhookUrl, {
      envelope: sampleEnvelope({
        merchant: Number(MERCHANT_B),
        companyId: OTHER_ID,
        data: { email: "b@example.com" },
      }),
    });
    assert.notEqual(a.json.data.id, b.json.data.id);
    assert.equal(fake.__db.orders.length, 2);
    assert.equal(
      fake.__db.orders.every((row) => row.company_id === ENAYA_ID),
      true,
    );
  });

  it("24-31. customer, guest, phone, address, totals, and cart ids", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    await signedSallaWebhook(store.webhookUrl, { envelope: sampleEnvelope() });
    const row = fake.__db.orders[0];
    assert.equal(row.raw_data.full_name, "Layla Hassan");
    assert.equal(row.raw_data.phone, "0551234567");
    assert.equal(row.raw_data.phone.startsWith("20"), false);
    assert.match(row.raw_data.address, /King Fahd Rd/);
    assert.equal(row.raw_data.city, "Riyadh");
    assert.equal(row.raw_data.country_code, "SA");
    assert.equal(row.raw_data.currency, "SAR");
    assert.equal(String(row.raw_data.total), "215");
    const line = row.raw_data.cart_items[0];
    assert.equal(line.product_id, "632910392");
    assert.equal(line.variant_id, "99001");
    assert.equal(line.sku, "SERUM-30");
    assert.equal(line.quantity, 2);

    const guest = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        data: {
          id: 44,
          customer: null,
          shipping: { address: { city: "Jeddah", country_code: "SA" } },
          items: [{ name: "Guest item", quantity: 1, product: { id: 12 } }],
          amounts: { total: { amount: 10, currency: "SAR" } },
        },
      }),
    });
    assert.equal(guest.status, 200);
    const guestRow = fake.__db.orders.find((item) => item.order_id === "44");
    assert.ok(guestRow);
    assert.equal(guestRow.raw_data.city, "Jeddah");
  });

  it("32-38. catalog linking, ingestion metadata, and no secret/envelope dump", async () => {
    const token = await loginPlatform();
    const storeA = await createConnectedSalla(token, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(token, { name: "Store B", merchantId: MERCHANT_B });
    fake.__db.products.push(
      {
        id: PRODUCT_A_ID,
        company_id: ENAYA_ID,
        easyorder_id: "632910392",
        source_integration_id: storeA.id,
        name: "Serum A",
        sku: "SERUM-A",
        raw_data: {},
      },
      {
        id: PRODUCT_B_ID,
        company_id: ENAYA_ID,
        easyorder_id: "632910392",
        source_integration_id: storeB.id,
        name: "Serum B",
        sku: "SERUM-B",
        raw_data: {},
      },
    );
    await signedSallaWebhook(storeA.webhookUrl, {
      envelope: sampleEnvelope({ merchant: Number(MERCHANT_A) }),
    });
    const line = fake.__db.orders[0].raw_data.cart_items[0];
    assert.equal(line.catalogProductId, PRODUCT_A_ID);
    assert.notEqual(line.catalogProductId, PRODUCT_B_ID);
    const catalog = await runWithTenantContext({ companyId: ENAYA_ID }, () =>
      resolveLineCatalogProduct(line, storeA.id),
    );
    assert.equal(catalog.id, PRODUCT_A_ID);

    await signedSallaWebhook(storeB.webhookUrl, {
      envelope: sampleEnvelope({
        merchant: Number(MERCHANT_B),
        data: { id: 54, email: "b@example.com" },
      }),
    });
    const sibling = fake.__db.orders.find((row) => row.order_id === "54").raw_data.cart_items[0];
    assert.equal(sibling.catalogProductId, PRODUCT_B_ID);
    assert.notEqual(sibling.catalogProductId, PRODUCT_A_ID);

    await signedSallaWebhook(storeB.webhookUrl, {
      envelope: sampleEnvelope({
        merchant: Number(MERCHANT_B),
        data: {
          id: 55,
          items: [{ product: { id: 111 }, name: "Unknown", quantity: 1 }],
          amounts: { total: { amount: 3, currency: "SAR" } },
        },
      }),
    });
    const missing = fake.__db.orders.find((row) => row.order_id === "55").raw_data.cart_items[0];
    assert.equal(missing.catalogProductId, undefined);
    assert.equal(missing.product_id, "111");

    const row = fake.__db.orders[0];
    assert.equal(row.ingestion_source, "salla");
    assert.equal(row.raw_data.provider, "salla");
    assert.equal(row.raw_data.platform, "salla");
    assert.equal(row.raw_data.event, undefined);
    assert.equal(row.raw_data.merchant, undefined);
    assert.equal(row.raw_data.data, undefined);
    const blob = JSON.stringify(row);
    assert.equal(blob.includes("salla-app-webhook-secret"), false);
    assert.equal(blob.includes("X-Salla-Signature"), false);
    assert.equal(blob.includes("access-salla"), false);
    assert.equal(row.raw_data.salla.reference_id, "554433");
    assert.equal(row.raw_data.salla.order_id, "203948534");
  });

  it("39-48. status, cancellation, operator preservation, and partial merge", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const canceledInsert = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.cancelled",
        data: { id: 70, status: { slug: "canceled" } },
      }),
    });
    assert.equal(fake.__db.orders.find((row) => row.order_id === "70").status, "canceled");

    const created = await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        data: { id: 71, status: { slug: "completed" }, payment_method: "paid" },
      }),
    });
    const localId = created.json.data.id;
    assert.equal(fake.__db.orders.find((row) => row.id === localId).status, "new");

    await request("PATCH", `/api/orders/${localId}/status`, {
      token: employeeToken(),
      body: { status: "Confirmed" },
    });
    await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.updated",
        data: {
          id: 71,
          status: { slug: "completed" },
          updated_at: { date: "2026-09-18 12:00:00" },
        },
      }),
    });
    assert.equal(fake.__db.orders.find((row) => row.id === localId).status, "Confirmed");

    await request("PATCH", `/api/orders/${localId}/status`, {
      token: employeeToken(),
      body: { status: "Shipped" },
    });
    await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.status.updated",
        data: { id: 71, status: { slug: "delivered" }, updated_at: { date: "2026-09-18 13:00:00" } },
      }),
    });
    assert.equal(fake.__db.orders.find((row) => row.id === localId).status, "Shipped");

    await request("PATCH", `/api/orders/${localId}/status`, {
      token: employeeToken(),
      body: { status: "follow up" },
    });
    await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.updated",
        data: { id: 71, status: { slug: "in_progress" }, updated_at: { date: "2026-09-18 14:00:00" } },
      }),
    });
    assert.equal(fake.__db.orders.find((row) => row.id === localId).status, "follow up");

    const partial = await signedSallaWebhook(store.webhookUrl, {
      envelope: {
        event: "order.status.updated",
        merchant: Number(MERCHANT_A),
        created_at: "2026-09-18T15:00:00Z",
        data: {
          id: 71,
          status: { slug: "in_progress" },
          updated_at: { date: "2026-09-18 15:00:00" },
        },
      },
    });
    assert.equal(partial.status, 200);
    const afterPartial = fake.__db.orders.find((row) => row.id === localId);
    assert.equal(afterPartial.raw_data.full_name, "Layla Hassan");
    assert.equal(afterPartial.raw_data.cart_items[0].sku, "SERUM-30");

    await signedSallaWebhook(store.webhookUrl, {
      envelope: {
        event: "order.cancelled",
        merchant: Number(MERCHANT_A),
        created_at: "2026-09-18T16:00:00Z",
        data: {
          id: 71,
          status: { slug: "canceled" },
          updated_at: { date: "2026-09-18 16:00:00" },
        },
      },
    });
    const afterCancel = fake.__db.orders.find((row) => row.id === localId);
    assert.equal(afterCancel.status, "canceled");
    assert.equal(afterCancel.raw_data.cart_items[0].sku, "SERUM-30");
    assert.equal(afterCancel.raw_data.full_name, "Layla Hassan");
    void canceledInsert;
  });

  it("49-50. older events do not overwrite newer useful data; 23505 converges", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    await signedSallaWebhook(store.webhookUrl, { envelope: sampleEnvelope() });
    await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.updated",
        data: { email: "new@example.com", updated_at: { date: "2026-09-18 18:00:00" } },
      }),
    });
    await signedSallaWebhook(store.webhookUrl, {
      envelope: sampleEnvelope({
        event: "order.updated",
        data: { email: "stale@example.com", updated_at: { date: "2026-09-18 09:00:00" } },
      }),
    });
    assert.equal(fake.__db.orders[0].raw_data.email, "new@example.com");

    const integration = rowById(store.id);
    const [first, second] = await Promise.all([
      runWithTenantContext({ companyId: ENAYA_ID, integration }, () =>
        persistSallaOrder({
          companyId: ENAYA_ID,
          sourceIntegrationId: store.id,
          integration,
          merchantId: MERCHANT_A,
          event: "order.created",
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
          data: sampleOrderData({ id: 88 }),
        }),
      ),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(fake.__db.orders.filter((row) => row.order_id === "88").length, 1);
  });

  it("51-58. list/detail/filters/dashboard/analytics/EasyConfirm/Bosta compatibility", async () => {
    const token = await loginPlatform();
    const storeA = await createConnectedSalla(token, { name: "Store A", merchantId: MERCHANT_A });
    const storeB = await createConnectedSalla(token, { name: "Store B", merchantId: MERCHANT_B });
    const created = await signedSallaWebhook(storeA.webhookUrl, {
      envelope: sampleEnvelope({ merchant: Number(MERCHANT_A) }),
    });
    await signedSallaWebhook(storeB.webhookUrl, {
      envelope: sampleEnvelope({ merchant: Number(MERCHANT_B), data: { id: 90 } }),
    });
    const jwt = employeeToken();
    const listed = await request("GET", `/api/orders?${RANGE}`, { token: jwt });
    assert.equal(listed.status, 200);
    assert.equal(
      listed.json.data.some((row) => row.id === created.json.data.id),
      true,
    );
    const detail = await request("GET", `/api/orders/${created.json.data.id}`, { token: jwt });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.customer.fullName, "Layla Hassan");
    assert.equal(detail.json.data.source_integration_id, storeA.id);
    assert.equal(String(detail.json.data.totals.total), "215");

    const onlyA = await request(
      "GET",
      `/api/orders?${RANGE}&source_integration_id=${storeA.id}`,
      { token: jwt },
    );
    assert.equal(onlyA.json.data.every((row) => row.source_integration_id === storeA.id), true);
    assert.equal(onlyA.json.data.some((row) => row.order_id === "90"), false);

    const stats = await request("GET", `/api/orders/stats?${RANGE}`, { token: jwt });
    assert.equal(stats.status, 200);
    const analytics = await request(
      "GET",
      `/api/orders/analytics?${RANGE}&product_id=${PRODUCT_A_ID}`,
      { token: jwt },
    );
    assert.notEqual(analytics.status, 500);

    const easyConfirm = await request(
      "POST",
      `/api/orders/${created.json.data.id}/refresh-customer-status`,
      { token: jwt },
    );
    assert.equal(easyConfirm.status, 409);
    assert.equal(easyConfirm.json.code, "EASYCONFIRM_NOT_EASYORDERS");

    const line = fake.__db.orders[0].raw_data.cart_items[0];
    await runWithTenantContext({ companyId: ENAYA_ID }, async () => {
      try {
        await resolveLineCatalogProduct(line, storeA.id);
      } catch (error) {
        assert.notEqual(error.code, "SALLA_WEBHOOK_NOT_READY");
      }
    });
    assert.equal(
      fake.__db.orders.every((row) => !row.raw_data.bosta_order_id && !row.raw_data.bosta_order_alias),
      true,
    );
  });

  it("59-67. generic writer retired, OAuth/refresh/Shopify/EO/Bosta regressions, no leakage", async () => {
    const token = await loginPlatform();
    const store = await createConnectedSalla(token);
    const accepted = await signedSallaWebhook(store.webhookUrl, { envelope: sampleEnvelope() });
    assert.equal(accepted.json.code, "SALLA_WEBHOOK_ACCEPTED");
    assert.equal(accepted.json.ok, true);
    assert.equal(JSON.stringify(accepted.json).includes("generic"), false);
    assert.equal(fake.__db.orders[0].ingestion_source, "salla");

    const connect = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/salla/connect`,
      { token },
    );
    assert.equal(connect.status, 200);
    assert.match(connect.json.data.authorizationUrl, /accounts\.salla\.sa/);

    markConnected(store.id, {
      tokenExpiresAt: new Date(Date.now() + 10 * 1000).toISOString(),
      refreshToken: "refresh-old",
    });
    axios.post = async () => ({
      status: 200,
      data: {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
      },
    });
    await ensureSallaAccessToken(rowById(store.id), { allowDisabled: true });
    assert.equal(decryptJson(rowById(store.id).credentials).refreshToken, "refresh-rotated");

    const shopify = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Shopify Egypt",
      credentials: {
        accessToken: "shpat-reg",
        webhookSecret: "whsec",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    const shopHook = await request(
      "POST",
      `/webhooks/shopify/${tokenFromWebhookUrl(shopify.webhookUrl)}/orders`,
      { body: { id: 1 }, headers: { "X-Shopify-Hmac-SHA256": "nope" } },
    );
    assert.notEqual(shopHook.json?.code, "SALLA_WEBHOOK_ACCEPTED");

    const easy = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-secret" },
    });
    const eoHook = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(easy.webhookUrl)}/order-created`,
      { body: { id: "eo-ok", full_name: "EO" } },
    );
    assert.equal(eoHook.status, 200);

    const bosta = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta",
      credentials: { apiKey: "bosta-secret" },
    });
    fake.__db.orders.push({
      id: "ord-bosta-salla",
      company_id: ENAYA_ID,
      order_id: "ALIAS-SALLA",
      status: "Shipped",
      shipping_integration_id: bosta.id,
      created_at: new Date().toISOString(),
      raw_data: { bosta_order_alias: "ALIAS-SALLA" },
    });
    const bostaHook = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-SALLA", status: "Delivered" } },
    );
    assert.equal(bostaHook.status, 200);

    const importCall = await request("POST", "/api/orders/import", {
      token: employeeToken(),
      body: {},
    });
    assert.notEqual(importCall.json?.code, "SALLA_WEBHOOK_NOT_READY");
    const sync = await request("POST", "/api/products/sync", {
      token: employeeToken(),
      body: { provider: "shopify" },
    });
    assert.notEqual(sync.json?.code, "SALLA_WEBHOOK_NOT_READY");

    const blob = JSON.stringify(accepted.json);
    assert.equal(blob.includes("0551234567"), false);
    assert.equal(blob.includes("access-salla"), false);
    assert.equal(
      fs
        .readdirSync(path.join(__dirname, "../supabase/migrations"))
        .some((name) => name.startsWith("015_") && name !== "015_atomic_company_signup.sql"),
      false,
    );
  });
});
