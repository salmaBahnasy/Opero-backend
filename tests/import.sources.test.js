process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const bcrypt = require("bcryptjs");
const { readFileSync } = require("fs");
const { join } = require("path");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const {
  signEmployeeToken,
  signPlatformAdminToken,
} = require("../src/config/jwt");
const { decryptJson } = require("../src/config/integrationSecrets");
const {
  PROVIDERS,
  isIngestionOnlyProvider,
  isRemoteProductSyncProvider,
  isHistoricalApiImportProvider,
} = require("../src/integrations/catalog");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENAYA_STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FEATURE_ORDERS = "f1111111-1111-4111-8111-111111111111";
const FEATURE_PRODUCTS = "f2222222-2222-4222-8222-222222222222";
const FEATURE_EMPLOYEES = "f3333333-3333-4333-8333-333333333333";
const FEATURE_ANALYTICS = "f4444444-4444-4444-8444-444444444444";
const FEATURE_IMPORTS = "f5555555-5555-4555-8555-555555555555";
const DEV_PASSWORD = "DevPassword123!";

let passwordHash;
let server;
let baseUrl;
let fake;

function enayaAdminToken() {
  return signEmployeeToken({
    employeeId: ENAYA_ADMIN_ID,
    companyId: ENAYA_ID,
    role: "company_admin",
    email: "admin@enaya.local",
  });
}

function enayaStaffToken() {
  return signEmployeeToken({
    employeeId: ENAYA_STAFF_ID,
    companyId: ENAYA_ID,
    role: "employee",
    email: "staff@enaya.local",
  });
}

function otherAdminToken() {
  return signEmployeeToken({
    employeeId: OTHER_ADMIN_ID,
    companyId: OTHER_ID,
    role: "company_admin",
    email: "admin@other.local",
  });
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

async function loginPlatform() {
  const { status, json } = await request("POST", "/api/platform/auth/login", {
    body: { email: "platform@saas.local", password: DEV_PASSWORD },
  });
  assert.equal(status, 200);
  return json.token;
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
    features: [
      { id: FEATURE_ORDERS, key: "orders", is_active: true },
      { id: FEATURE_PRODUCTS, key: "products", is_active: true },
      { id: FEATURE_EMPLOYEES, key: "employees", is_active: true },
      { id: FEATURE_ANALYTICS, key: "analytics", is_active: true },
      { id: FEATURE_IMPORTS, key: "imports", is_active: true },
    ],
    company_features: [
      { company_id: ENAYA_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_PRODUCTS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_EMPLOYEES, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_ANALYTICS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_IMPORTS, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_PRODUCTS, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_IMPORTS, is_enabled: true },
    ],
    company_integrations: [
      {
        id: "int-enaya-eo",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "easyorders",
        name: "EasyOrders Egypt",
        is_enabled: true,
        credentials: encryptPlaceholder({ apiKey: "enaya-easy-secret" }),
        settings: {},
      },
    ],
    orders: [],
    products: [],
  });
}

function encryptPlaceholder(secrets) {
  const { encryptJson } = require("../src/config/integrationSecrets");
  return encryptJson(secrets);
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
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("historical spreadsheet import sources", () => {
  it("registers spreadsheet as a commerce ingestion-only catalog provider", () => {
    assert.equal(PROVIDERS.spreadsheet.provider, "spreadsheet");
    assert.equal(PROVIDERS.spreadsheet.category, "commerce");
    assert.equal(PROVIDERS.spreadsheet.ingestionOnly, true);
    assert.equal(PROVIDERS.spreadsheet.webhookSuffix, null);
    assert.deepEqual(PROVIDERS.spreadsheet.secretKeys, []);
    assert.equal(isIngestionOnlyProvider("spreadsheet"), true);
    assert.equal(isRemoteProductSyncProvider("spreadsheet"), false);
    assert.equal(isHistoricalApiImportProvider("spreadsheet"), false);
    assert.equal(isIngestionOnlyProvider("shopify"), false);
    assert.equal(isIngestionOnlyProvider("salla"), false);
    assert.equal(isIngestionOnlyProvider("easyorders"), false);
    assert.equal(isIngestionOnlyProvider("bosta"), false);
  });

  it("lets company_admin list, create, rename, and disable own spreadsheet sources", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: {
        name: "Old ERP",
        provider: "shopify",
        category: "shipping",
        company_id: OTHER_ID,
        companyId: OTHER_ID,
        credentials: { apiKey: "should-not-store", accessToken: "nope" },
        providerAccountId: "acct-1",
        webhookToken: "fake-webhook",
      },
    });
    assert.equal(created.status, 201, created.json?.message);
    assert.equal(created.json.data.provider, "spreadsheet");
    assert.equal(created.json.data.category, "commerce");
    assert.equal(created.json.data.name, "Old ERP");
    assert.equal(created.json.data.isEnabled, true);
    assert.equal(created.json.data.webhookUrl, undefined);
    assert.equal(created.json.data.credentials, undefined);
    assert.equal(JSON.stringify(created.json).includes("should-not-store"), false);
    assert.equal(JSON.stringify(created.json).includes("nope"), false);

    const stored = fake.__db.company_integrations.find((row) => row.id === created.json.data.id);
    assert.equal(stored.company_id, ENAYA_ID);
    assert.equal(stored.provider, "spreadsheet");
    assert.equal(stored.category, "commerce");
    assert.equal(stored.provider_account_id, null);
    assert.equal(stored.webhook_token_hash, undefined);
    assert.equal(stored.webhook_token_encrypted, undefined);
    assert.deepEqual(decryptJson(stored.credentials), {});

    const listed = await request("GET", "/api/import-sources", {
      token: enayaAdminToken(),
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.length, 1);
    assert.equal(listed.json.data[0].id, created.json.data.id);
    assert.equal(listed.json.data[0].provider, "spreadsheet");

    const renamed = await request("PATCH", `/api/import-sources/${created.json.data.id}`, {
      token: enayaAdminToken(),
      body: {
        name: "النظام القديم",
        provider: "salla",
        category: "shipping",
        company_id: OTHER_ID,
        credentials: { apiKey: "still-no" },
        isEnabled: false,
      },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.data.name, "النظام القديم");
    assert.equal(renamed.json.data.provider, "spreadsheet");
    assert.equal(renamed.json.data.category, "commerce");
    assert.equal(renamed.json.data.isEnabled, false);

    const after = fake.__db.company_integrations.find((row) => row.id === created.json.data.id);
    assert.equal(after.provider, "spreadsheet");
    assert.equal(after.category, "commerce");
    assert.equal(after.is_enabled, false);
    assert.deepEqual(decryptJson(after.credentials), {});
  });

  it("rejects employee create/update and platform JWT", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaStaffToken(),
      body: { name: "Staff ERP" },
    });
    assert.equal(created.status, 403);

    const adminCreated = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: { name: "Admin ERP" },
    });
    assert.equal(adminCreated.status, 201);

    const staffUpdate = await request(
      "PATCH",
      `/api/import-sources/${adminCreated.json.data.id}`,
      { token: enayaStaffToken(), body: { name: "Hacked" } },
    );
    assert.equal(staffUpdate.status, 403);

    const platform = signPlatformAdminToken({
      platformAdminId: PLATFORM_ADMIN_ID,
      email: "platform@saas.local",
    });
    const platformList = await request("GET", "/api/import-sources", { token: platform });
    assert.equal(platformList.status, 403);
  });

  it("blocks cross-company read and update", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: { name: "Enaya Old ERP" },
    });
    assert.equal(created.status, 201);

    const otherList = await request("GET", "/api/import-sources", {
      token: otherAdminToken(),
    });
    assert.equal(otherList.status, 200);
    assert.equal(otherList.json.data.some((row) => row.id === created.json.data.id), false);

    const otherGet = await request(
      "GET",
      `/api/import-sources/${created.json.data.id}`,
      { token: otherAdminToken() },
    );
    assert.equal(otherGet.status, 404);
    assert.equal(otherGet.json.code, "IMPORT_SOURCE_NOT_FOUND");
    assert.equal(JSON.stringify(otherGet.json).includes("Enaya Old ERP"), false);

    const otherPatch = await request(
      "PATCH",
      `/api/import-sources/${created.json.data.id}`,
      { token: otherAdminToken(), body: { name: "Stolen" } },
    );
    assert.equal(otherPatch.status, 404);
    const stored = fake.__db.company_integrations.find((row) => row.id === created.json.data.id);
    assert.equal(stored.name, "Enaya Old ERP");
  });

  it("requires the imports feature for source management but keeps bootstrap labels", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: { name: "Excel Migration 2026" },
    });
    assert.equal(created.status, 201);

    const featureRow = fake.__db.company_features.find(
      (row) => row.company_id === ENAYA_ID && row.feature_id === FEATURE_IMPORTS,
    );
    featureRow.is_enabled = false;

    const listed = await request("GET", "/api/import-sources", {
      token: enayaAdminToken(),
    });
    assert.equal(listed.status, 403);
    assert.equal(listed.json.code, "FEATURE_REQUIRED");

    const patched = await request("PATCH", `/api/import-sources/${created.json.data.id}`, {
      token: enayaAdminToken(),
      body: { name: "Should not rename" },
    });
    assert.equal(patched.status, 403);

    const bootstrap = await request("GET", "/api/company/bootstrap", {
      token: enayaAdminToken(),
    });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.json.data.features.imports, false);
    const sourceNames = bootstrap.json.data.integrations.sources.map((row) => row.name);
    assert.equal(sourceNames.includes("Excel Migration 2026"), true);
    assert.equal(
      bootstrap.json.data.integrations.commerce.some((row) => row.name === "Excel Migration 2026"),
      false,
    );
  });

  it("excludes spreadsheet from remote product sync and Shopify/Salla API import", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: { name: "Offline Store" },
    });
    assert.equal(created.status, 201);
    const sourceId = created.json.data.id;

    const syncByProvider = await request("POST", "/api/products/sync?provider=spreadsheet", {
      token: enayaAdminToken(),
    });
    assert.equal(syncByProvider.status, 409);
    assert.equal(syncByProvider.json.code, "SPREADSHEET_SYNC_UNSUPPORTED");

    const syncById = await request("POST", "/api/products/sync", {
      token: enayaAdminToken(),
      body: { integrationId: sourceId },
    });
    assert.equal(syncById.status, 409);
    assert.equal(syncById.json.code, "SPREADSHEET_SYNC_UNSUPPORTED");

    const imported = await request("POST", "/api/orders/import", {
      token: enayaAdminToken(),
      body: { integrationId: sourceId },
    });
    assert.equal(imported.status, 409);
    assert.equal(imported.json.code, "SPREADSHEET_HISTORICAL_API_IMPORT_UNSUPPORTED");
  });

  it("lets Super Admin see spreadsheet rows without credential or webhook actions", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: { name: "Previous Store" },
    });
    assert.equal(created.status, 201);
    const platform = await loginPlatform();

    const listed = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token: platform },
    );
    assert.equal(listed.status, 200);
    const row = listed.json.data.find((item) => item.id === created.json.data.id);
    assert.equal(row.provider, "spreadsheet");
    assert.equal(row.name, "Previous Store");
    assert.equal(row.enabled, true);
    assert.equal(row.configured, true);
    assert.equal(row.webhookUrl, null);
    assert.equal(row.webhookConfigured, false);
    assert.equal(row.apiKeyMasked, null);
    assert.equal(JSON.stringify(row).includes("enaya-easy-secret"), false);

    const tested = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${row.id}/test`,
      { token: platform },
    );
    assert.equal(tested.status, 409);
    assert.equal(tested.json.code, "SPREADSHEET_REMOTE_TEST_UNSUPPORTED");

    const rotated = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${row.id}/rotate-webhook`,
      { token: platform },
    );
    assert.equal(rotated.status, 409);
    assert.equal(rotated.json.code, "SPREADSHEET_WEBHOOK_UNSUPPORTED");
  });

  it("keeps INTEGRATION_IN_USE protection for attributed spreadsheet sources", async () => {
    const created = await request("POST", "/api/import-sources", {
      token: enayaAdminToken(),
      body: { name: "Old ERP" },
    });
    assert.equal(created.status, 201);
    fake.__db.orders.push({
      id: "ord-hist-1",
      company_id: ENAYA_ID,
      order_id: "hist-1",
      source_integration_id: created.json.data.id,
      status: "new",
    });
    const platform = await loginPlatform();
    const deleted = await request(
      "DELETE",
      `/api/platform/companies/${ENAYA_ID}/integrations/${created.json.data.id}`,
      { token: platform },
    );
    assert.equal(deleted.status, 409);
    assert.equal(deleted.json.code, "INTEGRATION_IN_USE");
  });

  it("does not change Shopify, Salla, EasyOrders, or Bosta connection creation", async () => {
    const platform = await loginPlatform();
    const shopify = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      {
        token: platform,
        body: {
          category: "commerce",
          provider: "shopify",
          name: "Shopify Egypt",
          credentials: {
            accessToken: "shpat-enaya",
            webhookSecret: "shop-secret",
          },
          settings: { shopDomain: "enaya-eg.myshopify.com" },
        },
      },
    );
    assert.equal(shopify.status, 201);
    assert.equal(shopify.json.data.provider, "shopify");
    assert.match(String(shopify.json.data.webhookUrl || ""), /\/webhooks\/shopify\//);

    const salla = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      {
        token: platform,
        body: {
          category: "commerce",
          provider: "salla",
          name: "Salla Egypt",
        },
      },
    );
    assert.equal(salla.status, 201);
    assert.equal(salla.json.data.provider, "salla");
    assert.match(String(salla.json.data.webhookUrl || ""), /\/webhooks\/salla\//);

    const easy = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      {
        token: platform,
        body: {
          category: "commerce",
          provider: "easyorders",
          name: "EasyOrders KSA",
          credentials: { apiKey: "eo-key" },
        },
      },
    );
    assert.equal(easy.status, 201);
    assert.equal(easy.json.data.provider, "easyorders");
    assert.match(String(easy.json.data.webhookUrl || ""), /\/webhooks\/easyorders\//);

    const bosta = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      {
        token: platform,
        body: {
          category: "shipping",
          provider: "bosta",
          name: "Bosta Egypt",
          credentials: { apiKey: "bosta-key" },
        },
      },
    );
    assert.equal(bosta.status, 201);
    assert.equal(bosta.json.data.provider, "bosta");
    assert.match(String(bosta.json.data.webhookUrl || ""), /\/webhooks\/bosta\//);
  });

  it("does not expose batch upload or parser routes in B2", () => {
    const app = readFileSync(join(__dirname, "../src/app.js"), "utf8");
    const importRoutes = readFileSync(
      join(__dirname, "../src/routes/importSources.routes.js"),
      "utf8",
    );
    assert.match(app, /\/api\/import-sources/);
    assert.equal(app.includes("/api/import-batches"), false);
    assert.equal(importRoutes.includes("preview"), false);
    assert.equal(importRoutes.includes("commit"), false);
    assert.equal(importRoutes.includes("multipart"), false);
  });
});
