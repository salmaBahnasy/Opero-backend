process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SALLA_OAUTH_CLIENT_ID = "salla-client-id";
process.env.SALLA_OAUTH_CLIENT_SECRET = "salla-client-secret";
process.env.SALLA_OAUTH_REDIRECT_URI =
  "https://api.example.test/api/integrations/salla/oauth/callback";
process.env.SALLA_OAUTH_STATE_SECRET = "salla-oauth-state-secret-test";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-07";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken, signPlatformAdminToken } = require("../src/config/jwt");
const { decryptJson } = require("../src/config/integrationSecrets");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENAYA_STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DEV_PASSWORD = "DevPassword123!";
const SHOP = "phase-demo.myshopify.com";
const SHOPIFY_TOKEN = "shpat-company-self-service-token";
const EASY_KEY = "easyorders-company-secret-aaaa";

let passwordHash;
let server;
let baseUrl;
let fake;
const originalAxiosPost = axios.post;
const originalAxiosGet = axios.get;

async function request(method, pathname, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
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

function platformToken() {
  return signPlatformAdminToken({
    platformAdminId: PLATFORM_ADMIN_ID,
    email: "platform@saas.local",
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
  });
}

function storedSecrets(integrationId) {
  const row = fake.__db.company_integrations.find((item) => item.id === integrationId);
  return decryptJson(row.credentials);
}

function collectKeys(value, keys = new Set()) {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return keys;
  }
  Object.keys(value).forEach((key) => {
    keys.add(key);
    collectKeys(value[key], keys);
  });
  return keys;
}

function assertNoSecretFields(payload) {
  const keys = collectKeys(payload);
  for (const key of [
    "accessToken",
    "apiKey",
    "webhookSecret",
    "refreshToken",
    "credentials",
    "webhook_token_encrypted",
  ]) {
    assert.equal(keys.has(key), false, `leaked field ${key}`);
  }
}

describe("company-admin self-service integrations", () => {
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
    axios.post = async () => ({
      status: 200,
      headers: {},
      data: { data: { shop: { name: "Phase Demo", myshopifyDomain: SHOP } } },
    });
    axios.get = async () => ({ status: 200, data: {} });
  });

  afterEach(() => {
    axios.post = originalAxiosPost;
    axios.get = originalAxiosGet;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("company_admin can list, create, update, test, and rotate own integrations", async () => {
    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const created = await request("POST", "/api/company/integrations", {
      token,
      body: {
        companyId: OTHER_ID,
        category: "commerce",
        provider: "shopify",
        name: "Shopify Egypt",
        shopDomain: SHOP,
        credentials: { accessToken: SHOPIFY_TOKEN, webhookSecret: "hmac-secret" },
      },
    });
    assert.equal(created.status, 201, created.json?.message);
    const row = created.json.data;
    assert.equal(row.provider, "shopify");
    assert.equal(row.companyId, ENAYA_ID);
    assert.equal(row.shopDomain, SHOP);
    assert.equal(row.configured, true);
    assert.equal(Boolean(row.webhookUrl), true);
    assert.match(row.webhookUrl, /\/webhooks\/shopify\/.+\/orders$/);
    assertNoSecretFields(created.json);
    const blob = JSON.stringify(created.json);
    assert.equal(blob.includes(SHOPIFY_TOKEN), false);
    assert.equal(blob.includes("hmac-secret"), false);
    assert.equal(storedSecrets(row.id).accessToken, SHOPIFY_TOKEN);

    const listed = await request("GET", "/api/company/integrations", { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.some((item) => item.id === row.id), true);
    const listedRow = listed.json.data.find((item) => item.id === row.id);
    assert.equal(listedRow.webhookUrl, null);
    assert.equal(listedRow.webhookConfigured, true);
    assertNoSecretFields(listed.json);

    const patched = await request("PATCH", `/api/company/integrations/${row.id}`, {
      token,
      body: { name: "Shopify Egypt Live", enabled: true },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.data.name, "Shopify Egypt Live");
    assert.equal(patched.json.data.webhookUrl, null);
    assert.equal(patched.json.data.webhookConfigured, true);
    assert.equal(JSON.stringify(patched.json).includes(SHOPIFY_TOKEN), false);

    const tested = await request("POST", `/api/company/integrations/${row.id}/test`, {
      token,
    });
    assert.equal(tested.status, 200, tested.json?.message);
    assert.equal(tested.json.data.connected, true);
    assert.equal(tested.json.data.shopDomain, SHOP);
    assertNoSecretFields(tested.json);
    assert.equal(JSON.stringify(tested.json).includes(SHOPIFY_TOKEN), false);

    const rotated = await request(
      "POST",
      `/api/company/integrations/${row.id}/rotate-webhook`,
      { token },
    );
    assert.equal(rotated.status, 200);
    assert.equal(Boolean(rotated.json.data.webhookUrl), true);
    assert.notEqual(rotated.json.data.webhookUrl, row.webhookUrl);
  });

  it("employee cannot create/update/test/rotate/list company integrations", async () => {
    const admin = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const staff = employeeToken(ENAYA_ID, ENAYA_STAFF_ID, "staff@enaya.local", "employee");
    const created = await request("POST", "/api/company/integrations", {
      token: admin,
      body: {
        provider: "easyorders",
        name: "EasyOrders Egypt",
        credentials: { apiKey: EASY_KEY },
      },
    });
    assert.equal(created.status, 201);
    const id = created.json.data.id;
    assert.match(created.json.data.webhookUrl, /\/webhooks\/easyorders\/.+\/order-created$/);
    assert.equal(JSON.stringify(created.json).includes(EASY_KEY), false);

    const list = await request("GET", "/api/company/integrations", { token: staff });
    assert.equal(list.status, 403);
    const create = await request("POST", "/api/company/integrations", {
      token: staff,
      body: { provider: "bosta", name: "Bosta", credentials: { apiKey: "nope" } },
    });
    assert.equal(create.status, 403);
    const patch = await request("PATCH", `/api/company/integrations/${id}`, {
      token: staff,
      body: { enabled: false },
    });
    assert.equal(patch.status, 403);
    const test = await request("POST", `/api/company/integrations/${id}/test`, {
      token: staff,
    });
    assert.equal(test.status, 403);
    const rotate = await request(
      "POST",
      `/api/company/integrations/${id}/rotate-webhook`,
      { token: staff },
    );
    assert.equal(rotate.status, 403);
    const connect = await request(
      "POST",
      `/api/company/integrations/${id}/salla/connect`,
      { token: staff },
    );
    assert.equal(connect.status, 403);
  });

  it("Company A admin cannot read/update/test Company B integrations", async () => {
    const a = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const b = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    const created = await request("POST", "/api/company/integrations", {
      token: a,
      body: {
        provider: "bosta",
        name: "Enaya Bosta",
        credentials: { apiKey: "boost_enaya_self" },
      },
    });
    assert.equal(created.status, 201);
    const id = created.json.data.id;
    assert.match(created.json.data.webhookUrl, /\/webhooks\/bosta\/.+\/order-status$/);

    const get = await request("GET", `/api/company/integrations/${id}`, { token: b });
    assert.equal(get.status, 404);
    const patch = await request("PATCH", `/api/company/integrations/${id}`, {
      token: b,
      body: { name: "Stolen" },
    });
    assert.equal(patch.status, 404);
    const test = await request("POST", `/api/company/integrations/${id}/test`, {
      token: b,
    });
    assert.equal(test.status, 404);
    const rotate = await request(
      "POST",
      `/api/company/integrations/${id}/rotate-webhook`,
      { token: b },
    );
    assert.equal(rotate.status, 404);
    const listB = await request("GET", "/api/company/integrations", { token: b });
    assert.equal(listB.status, 200);
    assert.equal((listB.json.data || []).some((row) => row.id === id), false);
  });

  it("rejects unsupported providers and keeps platform endpoints platform-only", async () => {
    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const mylerz = await request("POST", "/api/company/integrations", {
      token,
      body: { provider: "mylerz", name: "Mylerz", credentials: { apiKey: "x" } },
    });
    assert.equal(mylerz.status, 400);
    const sheet = await request("POST", "/api/company/integrations", {
      token,
      body: { provider: "spreadsheet", name: "Excel", category: "commerce" },
    });
    assert.equal(sheet.status, 400);

    const platformList = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token },
    );
    assert.equal(platformList.status, 403);

    const platform = platformToken();
    const stillWorks = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token: platform },
    );
    assert.equal(stillWorks.status, 200);
  });

  it("Salla connect uses existing OAuth and does not accept pasted tokens from company UI contract", async () => {
    const token = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const created = await request("POST", "/api/company/integrations", {
      token,
      body: { provider: "salla", name: "Salla Store" },
    });
    assert.equal(created.status, 201, created.json?.message);
    assert.equal(created.json.data.authorizationStatus, "pending");
    const connected = await request(
      "POST",
      `/api/company/integrations/${created.json.data.id}/salla/connect`,
      { token },
    );
    assert.equal(connected.status, 200, connected.json?.message);
    assert.equal(connected.json.data.provider, "salla");
    assert.match(connected.json.data.authorizationUrl, /accounts\.salla\.sa/);
    assert.equal(JSON.stringify(connected.json).includes("salla-client-secret"), false);

    const other = employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");
    const stolen = await request(
      "POST",
      `/api/company/integrations/${created.json.data.id}/salla/connect`,
      { token: other },
    );
    assert.equal(stolen.status === 403 || stolen.status === 404, true);
  });

  it("does not add dual-write, catalog RPC, or /api/platform usage to company self-service files", () => {
    const controller = fs.readFileSync(
      path.join(__dirname, "../src/controllers/companyIntegrations.controller.js"),
      "utf8",
    );
    const routes = fs.readFileSync(
      path.join(__dirname, "../src/routes/company.routes.js"),
      "utf8",
    );
    assert.equal(controller.includes("writeCatalogProductPlan"), false);
    assert.equal(controller.includes("apply_catalog_product_plan"), false);
    assert.equal(controller.includes("CATALOG_DUAL_WRITE"), false);
    assert.equal(routes.includes("/api/platform"), false);
    assert.match(routes, /requireCompanyAdmin/);
  });
});
