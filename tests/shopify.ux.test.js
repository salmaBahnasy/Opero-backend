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
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { decryptJson } = require("../src/config/integrationSecrets");
const { signEmployeeToken } = require("../src/config/jwt");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "shopify-hmac-secret-value";
const ACCESS_TOKEN = "shpat-ux-test-token";
const SHOP_A = "enaya-eg.myshopify.com";
const SHOP_B = "enaya-sa.myshopify.com";

let passwordHash;
let server;
let baseUrl;
let fake;
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

function enayaToken() {
  return signEmployeeToken({
    employeeId: ENAYA_ADMIN_ID,
    companyId: ENAYA_ID,
    role: "company_admin",
    email: "admin@enaya.local",
  });
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

async function createShopifyStore(token, { name = "Shopify Egypt", shopDomain = SHOP_A } = {}) {
  return createConnection(token, ENAYA_ID, {
    category: "commerce",
    provider: "shopify",
    name,
    credentials: {
      accessToken: ACCESS_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      shopDomain,
    },
  });
}

function storedSecrets(integrationId) {
  const row = fake.__db.company_integrations.find((item) => item.id === integrationId);
  return decryptJson(row.credentials);
}

before(async () => {
  passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  fake = createFakeSupabase({
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
  supabase.__setClientForTests(fake);
  axios.post = async (_url, _body, config = {}) => {
    const handler = axios.post.__impl;
    if (typeof handler === "function") return handler(_url, _body, config);
    return {
      status: 200,
      headers: {},
      data: {
        data: { shop: { name: "Enaya EG", myshopifyDomain: SHOP_A } },
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

describe("Shopify connection UX gaps", () => {
  it("creates Shopify without apiKey and masks both secrets after save", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    assert.equal(store.apiKey, undefined);
    assert.equal(store.accessToken, undefined);
    assert.equal(store.webhookSecret, undefined);
    assert.equal(store.configured, true);
    assert.equal(store.webhookSecretConfigured, true);
    assert.equal(store.apiKeyMasked, "****oken");
    assert.equal(store.webhookSecretMasked, "****alue");
    assert.equal(store.shopDomain, SHOP_A);
    assert.equal(store.webhookUrl.includes("/webhooks/shopify/"), true);
    const secrets = storedSecrets(store.id);
    assert.equal(secrets.accessToken, ACCESS_TOKEN);
    assert.equal(secrets.webhookSecret, WEBHOOK_SECRET);
    assert.equal(secrets.apiKey, undefined);
  });

  it("preserves secrets on blank edit, replaces real values, and ignores masked placeholders", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);

    const blank = await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}`,
      {
        token,
        body: {
          name: "Shopify Egypt",
          credentials: { accessToken: "", webhookSecret: "" },
        },
      },
    );
    assert.equal(blank.status, 200);
    assert.equal(storedSecrets(store.id).accessToken, ACCESS_TOKEN);
    assert.equal(storedSecrets(store.id).webhookSecret, WEBHOOK_SECRET);

    const masked = await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}`,
      {
        token,
        body: {
          credentials: {
            accessToken: "****oken",
            webhookSecret: "**************",
          },
        },
      },
    );
    assert.equal(masked.status, 200);
    assert.equal(storedSecrets(store.id).accessToken, ACCESS_TOKEN);
    assert.equal(storedSecrets(store.id).webhookSecret, WEBHOOK_SECRET);

    const replaced = await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}`,
      {
        token,
        body: {
          credentials: {
            accessToken: "shpat-new-access",
            webhookSecret: "new-hmac-secret",
          },
        },
      },
    );
    assert.equal(replaced.status, 200);
    assert.equal(storedSecrets(store.id).accessToken, "shpat-new-access");
    assert.equal(storedSecrets(store.id).webhookSecret, "new-hmac-secret");
    assert.equal(replaced.json.data.apiKeyMasked, "****cess");
    assert.equal(replaced.json.data.webhookSecretMasked, "****cret");
    assert.equal(JSON.stringify(replaced.json).includes("shpat-new-access"), false);
    assert.equal(JSON.stringify(replaced.json).includes("new-hmac-secret"), false);
  });

  it("returns safe live-test metadata and credential/unavailable errors", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const ok = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/test`,
      { token },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.connected, true);
    assert.equal(ok.json.data.shopName, "Enaya EG");
    assert.equal(ok.json.data.shopDomain, SHOP_A);
    assert.equal(JSON.stringify(ok.json).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(ok.json).includes(WEBHOOK_SECRET), false);

    axios.post.__impl = async () => ({
      status: 401,
      headers: {},
      data: { errors: "Unauthorized" },
    });
    const revoked = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/test`,
      { token },
    );
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, "SHOPIFY_CREDENTIALS_INVALID");
    assert.equal(JSON.stringify(revoked.json).includes(ACCESS_TOKEN), false);

    axios.post.__impl = async () => ({
      status: 503,
      headers: { "retry-after": "0" },
      data: {},
    });
    const down = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/test`,
      { token },
    );
    assert.equal(down.status, 502);
    assert.equal(down.json.code, "SHOPIFY_PROVIDER_UNAVAILABLE");
  });

  it("rotates the webhook URL without changing the HMAC secret", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const oldToken = tokenFromWebhookUrl(store.webhookUrl);
    const rotated = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/rotate-webhook`,
      { token },
    );
    assert.equal(rotated.status, 200);
    const nextUrl = rotated.json.data.webhookUrl;
    assert.notEqual(nextUrl, store.webhookUrl);
    assert.equal(storedSecrets(store.id).webhookSecret, WEBHOOK_SECRET);
    assert.equal(rotated.json.data.webhookSecretConfigured, true);

    const oldHook = await request("POST", `/webhooks/shopify/${oldToken}/orders`, {
      raw: Buffer.from(JSON.stringify({ id: 1001 })),
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-SHA256": hmacFor(Buffer.from(JSON.stringify({ id: 1001 })), WEBHOOK_SECRET),
        "X-Shopify-Shop-Domain": SHOP_A,
        "X-Shopify-Topic": "orders/create",
      },
    });
    assert.equal(oldHook.status, 401);

    const newHook = await request(
      "POST",
      `/webhooks/shopify/${tokenFromWebhookUrl(nextUrl)}/orders`,
      {
        raw: Buffer.from(JSON.stringify({ id: 1001 })),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-SHA256": hmacFor(
            Buffer.from(JSON.stringify({ id: 1001 })),
            WEBHOOK_SECRET,
          ),
          "X-Shopify-Shop-Domain": SHOP_A,
          "X-Shopify-Topic": "orders/create",
        },
      },
    );
    assert.equal(newHook.status, 200);
  });

  it("disables Shopify webhook writes and product sync without deleting data", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    fake.__db.products.push({
      id: "prod-keep",
      company_id: ENAYA_ID,
      source_integration_id: store.id,
      easyorder_id: "123",
      name: "Serum",
    });
    const disabled = await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}`,
      { token, body: { enabled: false } },
    );
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.data.enabled, false);

    const hook = await request(
      "POST",
      `/webhooks/shopify/${tokenFromWebhookUrl(store.webhookUrl)}/orders`,
      {
        raw: Buffer.from(JSON.stringify({ id: 2002 })),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-SHA256": hmacFor(
            Buffer.from(JSON.stringify({ id: 2002 })),
            WEBHOOK_SECRET,
          ),
          "X-Shopify-Shop-Domain": SHOP_A,
          "X-Shopify-Topic": "orders/create",
        },
      },
    );
    assert.equal(hook.status, 401);
    assert.equal(fake.__db.orders.length, 0);

    const sync = await request(
      "POST",
      `/api/products/sync?integrationId=${store.id}`,
      { token: enayaToken() },
    );
    assert.equal(sync.status, 409);
    assert.equal(sync.json.code, "INTEGRATION_DISABLED");
    assert.equal(fake.__db.products.some((row) => row.id === "prod-keep"), true);

    const tested = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}/test`,
      { token },
    );
    assert.equal(tested.status, 200);
    assert.equal(tested.json.data.connected, true);
    assert.equal(tested.json.data.enabled, false);
  });

  it("lists two Shopify stores independently and blocks delete when orders exist", async () => {
    const token = await loginPlatform();
    const egypt = await createShopifyStore(token, { name: "Shopify Egypt", shopDomain: SHOP_A });
    axios.post.__impl = async () => ({
      status: 200,
      headers: {},
      data: { data: { shop: { name: "Enaya SA", myshopifyDomain: SHOP_B } } },
    });
    const saudi = await createShopifyStore(token, {
      name: "Shopify Saudi",
      shopDomain: SHOP_B,
    });
    const listed = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token },
    );
    const rows = listed.json.data.filter((row) => row.provider === "shopify");
    assert.equal(rows.length, 2);
    assert.equal(rows.some((row) => row.id === egypt.id && row.name === "Shopify Egypt"), true);
    assert.equal(rows.some((row) => row.id === saudi.id && row.name === "Shopify Saudi"), true);
    assert.equal(rows.find((row) => row.id === egypt.id).shopDomain, SHOP_A);
    assert.equal(rows.find((row) => row.id === saudi.id).shopDomain, SHOP_B);

    fake.__db.orders.push({
      id: "ord-in-use",
      company_id: ENAYA_ID,
      order_id: "1001",
      source_integration_id: egypt.id,
      ingestion_source: "shopify",
      status: "new",
    });
    const blocked = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${egypt.id}`,
      { token },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "INTEGRATION_IN_USE");
    assert.equal(
      fake.__db.company_integrations.some((row) => row.id === egypt.id),
      true,
    );
    assert.equal(fake.__db.orders[0].source_integration_id, egypt.id);
  });

  it("keeps company bootstrap secret-free and Shopify/EasyOrders regressions working", async () => {
    const token = await loginPlatform();
    const shopify = await createShopifyStore(token);
    const easy = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EasyOrders Egypt",
      credentials: { apiKey: "eo-key" },
    });
    const bootstrap = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    const bootBlob = JSON.stringify(bootstrap.json);
    assert.equal(bootstrap.status, 200);
    assert.equal(bootBlob.includes(ACCESS_TOKEN), false);
    assert.equal(bootBlob.includes(WEBHOOK_SECRET), false);
    assert.equal(bootBlob.includes("shopDomain"), false);
    assert.equal(bootBlob.includes("webhookSecret"), false);
    const commerce = bootstrap.json.data?.integrations?.commerce || [];
    assert.equal(
      commerce.some((row) => row.id === shopify.id && row.name === "Shopify Egypt"),
      true,
    );
    assert.equal(commerce.some((row) => row.id === easy.id), true);

    axios.post.__impl = async () => ({
      status: 200,
      headers: {},
      data: {
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/Product/123",
                legacyResourceId: "123",
                title: "Serum",
                handle: "serum",
                status: "ACTIVE",
                variants: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "gid://shopify/ProductVariant/456",
                      legacyResourceId: "456",
                      title: "S",
                      sku: "SERUM-S",
                      price: "10.00",
                      selectedOptions: [],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const sync = await request(
      "POST",
      `/api/products/sync?integrationId=${shopify.id}`,
      { token: enayaToken() },
    );
    assert.equal(sync.status, 200);
    assert.equal(sync.json.data.provider, "shopify");
    assert.equal(sync.json.data.integrationId, shopify.id);

    const hook = await request(
      "POST",
      `/webhooks/shopify/${tokenFromWebhookUrl(shopify.webhookUrl)}/orders`,
      {
        raw: Buffer.from(JSON.stringify({ id: 3003 })),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-SHA256": hmacFor(
            Buffer.from(JSON.stringify({ id: 3003 })),
            WEBHOOK_SECRET,
          ),
          "X-Shopify-Shop-Domain": SHOP_A,
          "X-Shopify-Topic": "orders/updated",
        },
      },
    );
    assert.equal(hook.status, 200);
  });
});
