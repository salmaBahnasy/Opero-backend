process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-07";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { decryptJson } = require("../src/config/integrationSecrets");
const {
  shopifyGraphql,
  testShopifyConnection,
  assertShopifyIntegration,
} = require("../src/services/shopify.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "shopify-hmac-secret-value";
const ACCESS_TOKEN = "shpat-adapter-test-token";
const SHOP = "enaya-eg.myshopify.com";

let passwordHash;
let server;
let baseUrl;
let fake;
let capturedHttp = [];
const originalAxiosPost = axios.post;

function tokenFromWebhookUrl(url) {
  const parts = String(url || "").split("/");
  const idx = parts.indexOf("webhooks");
  return idx >= 0 ? decodeURIComponent(parts[idx + 2] || "") : "";
}

function hmacFor(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
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

async function createShopifyStore(token, name = "Shopify Egypt") {
  return createConnection(token, ENAYA_ID, {
    category: "commerce",
    provider: "shopify",
    name,
    credentials: {
      accessToken: ACCESS_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      shopDomain: SHOP,
    },
  });
}

async function signedShopifyWebhook(webhookUrl, { topic, json, raw, shop, secret } = {}) {
  const token = tokenFromWebhookUrl(webhookUrl);
  const rawBody =
    raw != null ? raw : Buffer.from(JSON.stringify(json || { id: 1001 }));
  return request("POST", `/webhooks/shopify/${token}/orders`, {
    raw: rawBody,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-SHA256": hmacFor(rawBody, secret || WEBHOOK_SECRET),
      "X-Shopify-Shop-Domain": shop || SHOP,
      "X-Shopify-Topic": topic || "orders/create",
    },
  });
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
  axios.post = async (url, body, config = {}) => {
    capturedHttp.push({
      method: "POST",
      url,
      headers: config.headers || {},
      body,
    });
    const handler = axios.post.__impl;
    if (typeof handler === "function") {
      return handler(url, body, config);
    }
    return {
      status: 200,
      headers: {},
      data: {
        data: { shop: { name: "Enaya EG", myshopifyDomain: SHOP } },
      },
    };
  };
});

afterEach(() => {
  axios.post = originalAxiosPost;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("Shopify Admin API client", () => {
  it("uses the exact integration shop domain and never auto-picks a store", async () => {
    const egypt = {
      id: "int-egypt",
      provider: "shopify",
      category: "commerce",
      is_enabled: true,
      settings: { shopDomain: "egypt-store.myshopify.com" },
    };
    const saudi = {
      id: "int-saudi",
      provider: "shopify",
      category: "commerce",
      is_enabled: true,
      settings: { shopDomain: "saudi-store.myshopify.com" },
    };
    await shopifyGraphql({
      integration: egypt,
      secrets: { accessToken: "token-egypt" },
      query: "{ shop { name } }",
    });
    await shopifyGraphql({
      integration: saudi,
      secrets: { accessToken: "token-saudi" },
      query: "{ shop { name } }",
    });
    assert.equal(capturedHttp.length, 2);
    assert.match(capturedHttp[0].url, /egypt-store\.myshopify\.com/);
    assert.match(capturedHttp[1].url, /saudi-store\.myshopify\.com/);
    assert.equal(capturedHttp[0].headers["X-Shopify-Access-Token"], "token-egypt");
    assert.equal(capturedHttp[1].headers["X-Shopify-Access-Token"], "token-saudi");
    assert.equal(capturedHttp[0].url.includes("saudi-store"), false);
    assert.throws(
      () => assertShopifyIntegration(null, { accessToken: "x" }),
      (error) => error.code === "SHOPIFY_INTEGRATION_REQUIRED",
    );
    const clientSource = readFileSync(
      join(__dirname, "../src/services/shopify.service.js"),
      "utf8",
    );
    assert.equal(clientSource.includes("resolveOwnedConnection"), false);
    assert.equal(clientSource.includes("rows[0]"), false);
  });

  it("live connection test returns safe metadata", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const tested = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/test`,
      { token },
    );
    assert.equal(tested.status, 200);
    assert.equal(tested.json.data.connected, true);
    assert.equal(tested.json.data.shopName, "Enaya EG");
    assert.equal(tested.json.data.shopDomain, SHOP);
    const blob = JSON.stringify(tested.json);
    assert.equal(blob.includes(ACCESS_TOKEN), false);
    assert.equal(blob.includes(WEBHOOK_SECRET), false);
  });

  it("revoked token returns a stable safe error without retry", async () => {
    let calls = 0;
    axios.post.__impl = async () => {
      calls += 1;
      return { status: 401, headers: {}, data: { errors: "Unauthorized" } };
    };
    await assert.rejects(
      () =>
        testShopifyConnection({
          integration: {
            id: "int-1",
            provider: "shopify",
            category: "commerce",
            is_enabled: true,
            settings: { shopDomain: SHOP },
          },
          secrets: { accessToken: "revoked" },
        }),
      (error) => error.code === "SHOPIFY_CREDENTIALS_INVALID",
    );
    assert.equal(calls, 1);
  });

  it("retries 429 then 5xx with a bound, and normalizes GraphQL errors", async () => {
    let limited = 0;
    axios.post.__impl = async (_url, _body, config) => {
      limited += 1;
      if (limited === 1) {
        return { status: 429, headers: { "retry-after": "0" }, data: {} };
      }
      return {
        status: 200,
        headers: {},
        data: { data: { shop: { name: "Ok", myshopifyDomain: SHOP } } },
      };
    };
    const ok = await shopifyGraphql({
      integration: {
        id: "int-1",
        provider: "shopify",
        category: "commerce",
        is_enabled: true,
        settings: { shopDomain: SHOP },
      },
      secrets: { accessToken: ACCESS_TOKEN },
      query: "{ shop { name } }",
    });
    assert.equal(ok.data.shop.name, "Ok");
    assert.equal(limited, 2);

    let unavailable = 0;
    axios.post.__impl = async () => {
      unavailable += 1;
      return { status: 503, headers: { "retry-after": "0" }, data: {} };
    };
    await assert.rejects(
      () =>
        shopifyGraphql({
          integration: {
            id: "int-1",
            provider: "shopify",
            category: "commerce",
            is_enabled: true,
            settings: { shopDomain: SHOP },
          },
          secrets: { accessToken: ACCESS_TOKEN },
          query: "{ shop { name } }",
        }),
      (error) => error.code === "SHOPIFY_PROVIDER_UNAVAILABLE",
    );
    assert.equal(unavailable, 4);

    axios.post.__impl = async () => ({
      status: 200,
      headers: {},
      data: { errors: [{ message: "boom" }] },
    });
    await assert.rejects(
      () =>
        shopifyGraphql({
          integration: {
            id: "int-1",
            provider: "shopify",
            category: "commerce",
            is_enabled: true,
            settings: { shopDomain: SHOP },
          },
          secrets: { accessToken: ACCESS_TOKEN },
          query: "{ shop { name } }",
        }),
      (error) => error.code === "SHOPIFY_GRAPHQL_ERROR",
    );
  });
});

describe("Shopify webhook security", () => {
  it("rejects invalid token, missing secret, missing HMAC, and invalid HMAC", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const webhookToken = tokenFromWebhookUrl(store.webhookUrl);

    const unknown = await request("POST", "/webhooks/shopify/not-a-token/orders", {
      body: { id: 1 },
    });
    assert.equal(unknown.status, 401);

    const missingSecretStore = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "No HMAC secret",
      credentials: { accessToken: ACCESS_TOKEN, shopDomain: SHOP },
    });
    const noSecret = await signedShopifyWebhook(missingSecretStore.webhookUrl);
    assert.equal(noSecret.status, 401);
    assert.equal(noSecret.json.code, "SHOPIFY_WEBHOOK_SECRET_MISSING");

    const missingHmac = await request(
      "POST",
      `/webhooks/shopify/${webhookToken}/orders`,
      {
        raw: Buffer.from(JSON.stringify({ id: 1 })),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Shop-Domain": SHOP,
          "X-Shopify-Topic": "orders/create",
        },
      },
    );
    assert.equal(missingHmac.status, 401);
    assert.equal(missingHmac.json.code, "SHOPIFY_WEBHOOK_HMAC_INVALID");

    const invalid = await signedShopifyWebhook(store.webhookUrl, {
      secret: "wrong-secret",
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.json.code, "SHOPIFY_WEBHOOK_HMAC_INVALID");
    assert.equal(fake.__db.orders.length, 0);
  });

  it("accepts a valid HMAC over the exact raw bytes and ignores body company_id", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const raw = Buffer.from(
      `{\n  "id": 1001,\n  "company_id": "${OTHER_ID}",\n  "email": "a@b.test"\n}`,
    );
    const verified = await signedShopifyWebhook(store.webhookUrl, { raw });
    assert.equal(verified.status, 200);
    assert.equal(verified.json.code, "SHOPIFY_WEBHOOK_ACCEPTED");
    assert.equal(verified.json.data.integrationId || verified.json.data.source_integration_id, store.id);
    assert.equal(verified.json.data.companyId || fake.__db.orders[0].company_id, ENAYA_ID);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].company_id, ENAYA_ID);
    assert.equal(fake.__db.orders[0].order_id, "1001");
    assert.equal(fake.__db.orders[0].source_integration_id, store.id);

    const mismatch = await signedShopifyWebhook(store.webhookUrl, {
      shop: "other-store.myshopify.com",
    });
    assert.equal(mismatch.status, 401);
    assert.equal(mismatch.json.code, "SHOPIFY_SHOP_DOMAIN_MISMATCH");
  });

  it("ignores unsupported topics and does not persist Shopify payloads", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const ignored = await signedShopifyWebhook(store.webhookUrl, {
      topic: "products/create",
      json: { id: 55, title: "Should not persist" },
    });
    assert.equal(ignored.status, 200);
    assert.equal(ignored.json.code, "SHOPIFY_TOPIC_IGNORED");
    assert.equal(fake.__db.orders.length, 0);
    assert.equal(fake.__db.products.length, 0);
  });
});

describe("Shopify secret exposure and webhook regressions", () => {
  it("does not expose secrets in platform responses or company bootstrap", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const listed = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token },
    );
    const row = listed.json.data.find((item) => item.id === store.id);
    const blob = JSON.stringify(listed.json);
    assert.equal(row.shopDomain, SHOP);
    assert.equal(row.webhookSecretConfigured, true);
    assert.equal(blob.includes(ACCESS_TOKEN), false);
    assert.equal(blob.includes(WEBHOOK_SECRET), false);
    assert.equal(blob.includes("ciphertext"), false);
    const stored = fake.__db.company_integrations.find((item) => item.id === store.id);
    const secrets = decryptJson(stored.credentials);
    assert.equal(secrets.accessToken, ACCESS_TOKEN);
    assert.equal(secrets.webhookSecret, WEBHOOK_SECRET);
    assert.equal(secrets.shopDomain, undefined);

    const { signEmployeeToken } = require("../src/config/jwt");
    const companyToken = signEmployeeToken({
      employeeId: ENAYA_ADMIN_ID,
      companyId: ENAYA_ID,
      role: "company_admin",
      email: "admin@enaya.local",
    });
    const bootstrap = await request("GET", "/api/company/bootstrap", {
      token: companyToken,
    });
    assert.equal(bootstrap.status, 200);
    const bootBlob = JSON.stringify(bootstrap.json);
    assert.equal(bootBlob.includes(ACCESS_TOKEN), false);
    assert.equal(bootBlob.includes(WEBHOOK_SECRET), false);
    assert.equal(bootBlob.includes("shopDomain"), false);
    assert.equal(bootBlob.includes("webhookSecret"), false);
  });

  it("keeps JSON API routes and EasyOrders/Salla/Bosta webhooks working", async () => {
    const token = await loginPlatform();
    const login = await request("POST", "/api/platform/auth/login", {
      body: { email: "platform@saas.local", password: DEV_PASSWORD },
    });
    assert.equal(login.status, 200);

    const easy = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-key" },
    });
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Salla",
      credentials: { accessToken: "salla-token" },
    });
    const bosta = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta",
      credentials: { apiKey: "boost_aaaa" },
    });
    fake.__db.orders.push({
      id: "ord-bosta-reg",
      company_id: ENAYA_ID,
      order_id: "ALIAS-REG",
      status: "Shipped",
      shipping_integration_id: bosta.id,
      created_at: new Date().toISOString(),
      raw_data: { bosta_order_alias: "ALIAS-REG", full_name: "Ship me" },
    });

    const eoHook = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(easy.webhookUrl)}/order-created`,
      { body: { id: "eo-reg-1", full_name: "EO customer" } },
    );
    const sallaHook = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(salla.webhookUrl)}/orders`,
      { body: { id: "salla-reg-1", full_name: "Salla customer" } },
    );
    const bostaHook = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-REG", status: "Delivered" } },
    );
    assert.equal(eoHook.status, 200);
    assert.equal(sallaHook.status, 401);
    assert.match(String(sallaHook.json.code || ""), /^SALLA_WEBHOOK_/);
    assert.equal(bostaHook.status, 200);
    assert.equal(
      fake.__db.orders.some((row) => row.order_id === "eo-reg-1"),
      true,
    );
    assert.equal(
      fake.__db.orders.some((row) => row.order_id === "salla-reg-1"),
      false,
    );
  });
});
