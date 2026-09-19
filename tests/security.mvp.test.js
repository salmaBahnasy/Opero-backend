process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com,https://admin.example.com";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken, signPlatformAdminToken } = require("../src/config/jwt");
const { decryptJson } = require("../src/config/integrationSecrets");
const { getTrustedEasyOrdersApiBaseUrl } = require("../src/config/easyorders");
const { isOriginAllowed } = require("../src/config/httpSecurity");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENAYA_ADMIN_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ENAYA_STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DEV_PASSWORD = "DevPassword123!";
const FEATURE = {
  orders: "f1111111-1111-4111-8111-111111111111",
  products: "f2222222-2222-4222-8222-222222222222",
  employees: "f3333333-3333-4333-8333-333333333333",
  analytics: "f4444444-4444-4444-8444-444444444444",
  bosta: "f5555555-5555-4555-8555-555555555555",
  imports: "f6666666-6666-4666-8666-666666666666",
};

let passwordHash;
let server;
let baseUrl;
let fake;

function tokenFromWebhookUrl(url) {
  const match = String(url || "").match(/\/webhooks\/[^/]+\/([^/]+)\//);
  return match ? match[1] : "";
}

async function request(method, pathname, { token, body, headers = {}, raw } = {}) {
  const nextHeaders = { ...headers };
  if (token) nextHeaders.Authorization = `Bearer ${token}`;
  let payload;
  if (raw != null) {
    payload = raw;
  } else if (body !== undefined) {
    nextHeaders["Content-Type"] = nextHeaders["Content-Type"] || "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
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
  return { status: response.status, json, headers: response.headers, text };
}

function adminToken(overrides = {}) {
  return signEmployeeToken({
    employeeId: ENAYA_ADMIN_ID,
    companyId: ENAYA_ID,
    role: "company_admin",
    email: "admin@enaya.local",
    ...overrides,
  });
}

function staffToken(overrides = {}) {
  return signEmployeeToken({
    employeeId: ENAYA_STAFF_ID,
    companyId: ENAYA_ID,
    role: "employee",
    email: "staff@enaya.local",
    ...overrides,
  });
}

function platformToken() {
  return signPlatformAdminToken({
    platformAdminId: PLATFORM_ADMIN_ID,
    email: "platform@saas.local",
  });
}

function employeeRow(id, companyId, email, role, extra = {}) {
  return {
    id,
    company_id: companyId,
    name: email,
    email,
    password: passwordHash,
    role,
    is_active: true,
    ...extra,
  };
}

function seedClient(overrides = {}) {
  return createFakeSupabase({
    companies: [
      { id: ENAYA_ID, name: "Enaya", slug: "enaya", is_active: true, deleted_at: null },
      { id: OTHER_ID, name: "Other Co", slug: "other", is_active: true, deleted_at: null },
    ],
    employees: [
      employeeRow(ENAYA_ADMIN_ID, ENAYA_ID, "admin@enaya.local", "company_admin"),
      employeeRow(ENAYA_ADMIN_2, ENAYA_ID, "admin2@enaya.local", "company_admin"),
      employeeRow(ENAYA_STAFF_ID, ENAYA_ID, "staff@enaya.local", "employee"),
      employeeRow(OTHER_ADMIN_ID, OTHER_ID, "admin@other.local", "company_admin"),
    ],
    platform_admins: [
      {
        id: PLATFORM_ADMIN_ID,
        name: "Platform",
        email: "platform@saas.local",
        password: passwordHash,
        is_active: true,
      },
    ],
    ...overrides,
  });
}

function featureCatalog() {
  return Object.entries(FEATURE).map(([key, id]) => ({
    id,
    key,
    is_active: true,
  }));
}

function enableFeatures(companyId, keys) {
  return keys.map((key) => ({
    company_id: companyId,
    feature_id: FEATURE[key],
    is_enabled: true,
  }));
}

describe("security MVP", () => {
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

  it("ignores submitted EasyOrders apiBaseUrl and never sends Axios to attacker hosts", async () => {
    const captured = [];
    const originalGet = axios.get;
    axios.get = async (url) => {
      captured.push(String(url));
      return { data: [] };
    };
    try {
      const created = await request("POST", "/api/company/integrations", {
        token: adminToken(),
        body: {
          provider: "easyorders",
          name: "EO",
          credentials: {
            apiKey: "easy-secret-key",
            apiBaseUrl: "http://127.0.0.1",
          },
        },
      });
      assert.equal(created.status, 201, created.json?.message);
      const secrets = decryptJson(
        fake.__db.company_integrations.find((row) => row.id === created.json.data.id)
          .credentials,
      );
      assert.equal(secrets.apiBaseUrl, undefined);
      assert.equal(secrets.api_base_url, undefined);

      const sync = await request("POST", "/api/products/sync", {
        token: adminToken(),
        body: { integrationId: created.json.data.id },
      });
      assert.equal(sync.status < 500, true, sync.json?.message);
      const trusted = getTrustedEasyOrdersApiBaseUrl();
      assert.equal(captured.length > 0, true);
      for (const url of captured) {
        assert.equal(url.startsWith(trusted), true, url);
        assert.equal(url.includes("127.0.0.1"), false);
        assert.equal(url.includes("localhost"), false);
        assert.equal(url.includes("169.254.169.254"), false);
        assert.equal(url.includes("10.0.0.1"), false);
        assert.equal(url.includes("attacker.example"), false);
      }
    } finally {
      axios.get = originalGet;
    }
  });

  it("rejects EasyOrders apiBaseUrl overrides for localhost, metadata, private, and attacker hosts", async () => {
    const hosts = [
      "http://127.0.0.1",
      "http://localhost",
      "http://169.254.169.254",
      "http://10.0.0.1",
      "https://attacker.example",
    ];
    for (const apiBaseUrl of hosts) {
      const created = await request("POST", "/api/company/integrations", {
        token: adminToken(),
        body: {
          provider: "easyorders",
          name: `EO ${apiBaseUrl}`,
          credentials: { apiKey: "easy-secret-key", apiBaseUrl },
        },
      });
      assert.equal(created.status, 201, created.json?.message);
      const secrets = decryptJson(
        fake.__db.company_integrations.find((row) => row.id === created.json.data.id)
          .credentials,
      );
      assert.equal(secrets.apiBaseUrl, undefined);
    }
  });

  it("allows an active company and employee JWT", async () => {
    const res = await request("GET", "/api/orders", { token: adminToken() });
    assert.equal(res.status, 200, res.json?.message);
  });

  it("rejects company JWT after company deactivation", async () => {
    const token = adminToken();
    fake.__db.companies.find((row) => row.id === ENAYA_ID).is_active = false;
    const res = await request("GET", "/api/orders", { token });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, "SESSION_INVALID");
  });

  it("rejects company JWT after company soft-delete", async () => {
    const token = adminToken();
    fake.__db.companies.find((row) => row.id === ENAYA_ID).deleted_at =
      new Date().toISOString();
    const res = await request("GET", "/api/orders", { token });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, "SESSION_INVALID");
  });

  it("rejects employee JWT after employee deactivation", async () => {
    const token = staffToken();
    fake.__db.employees.find((row) => row.id === ENAYA_STAFF_ID).is_active = false;
    const res = await request("GET", "/api/orders", { token });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, "SESSION_INVALID");
  });

  it("demotion immediately removes admin APIs while employee APIs still work", async () => {
    const token = adminToken({ role: "company_admin" });
    fake.__db.employees.find((row) => row.id === ENAYA_ADMIN_ID).role = "employee";
    const adminApi = await request("GET", "/api/employees", { token });
    assert.equal(adminApi.status, 403);
    const orders = await request("GET", "/api/orders", { token });
    assert.equal(orders.status, 200, orders.json?.message);
  });

  it("does not let a company A employee revalidate into company B", async () => {
    const stolen = adminToken({ companyId: OTHER_ID });
    const res = await request("GET", "/api/orders", { token: stolen });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, "SESSION_INVALID");
  });

  it("enforces feature flags for orders, products, employees, analytics, bosta, and imports", async () => {
    fake = seedClient({
      features: featureCatalog(),
      company_features: [
        ...enableFeatures(ENAYA_ID, []),
        ...enableFeatures(OTHER_ID, Object.keys(FEATURE)),
      ],
    });
    supabase.__setClientForTests(fake);
    const token = adminToken();
    const orders = await request("GET", "/api/orders", { token });
    assert.equal(orders.status, 403);
    assert.equal(orders.json.code, "FEATURE_REQUIRED");
    const products = await request("GET", "/api/products", { token });
    assert.equal(products.status, 403);
    const employees = await request("GET", "/api/employees", { token });
    assert.equal(employees.status, 403);
    const stats = await request("GET", "/api/orders/stats", { token });
    assert.equal(stats.status, 403);
    const easyStats = await request("GET", "/api/easyorder/stats", { token });
    assert.equal(easyStats.status, 403);
    const bosta = await request("GET", "/api/bosta/sku-mappings", { token });
    assert.equal(bosta.status, 403);
    const cities = await request("GET", "/api/bosta/cities", { token });
    assert.equal(cities.status, 403);
    const imports = await request("GET", "/api/import-sources", { token });
    assert.equal(imports.status, 403);
    const historical = await request("POST", "/api/orders/import", {
      token,
      body: { integrationId: "11111111-1111-4111-8111-111111111110" },
    });
    assert.equal(historical.status, 403);
  });

  it("keeps bootstrap available when operational features are off", async () => {
    fake = seedClient({
      features: featureCatalog(),
      company_features: [],
    });
    supabase.__setClientForTests(fake);
    const res = await request("GET", "/api/company/bootstrap", { token: adminToken() });
    assert.equal(res.status, 200, res.json?.message);
  });

  it("requires company_admin plus imports feature for historical import", async () => {
    fake = seedClient({
      features: featureCatalog(),
      company_features: enableFeatures(ENAYA_ID, Object.keys(FEATURE)),
    });
    supabase.__setClientForTests(fake);
    const staff = await request("POST", "/api/orders/import", {
      token: staffToken(),
      body: { integrationId: "11111111-1111-4111-8111-111111111110" },
    });
    assert.equal(staff.status, 403);
    fake.__db.company_features = enableFeatures(ENAYA_ID, [
      "orders",
      "products",
      "employees",
      "analytics",
      "bosta",
    ]);
    const noImports = await request("POST", "/api/orders/import", {
      token: adminToken(),
      body: { integrationId: "11111111-1111-4111-8111-111111111110" },
    });
    assert.equal(noImports.status, 403);
    assert.equal(noImports.json.code, "FEATURE_REQUIRED");
  });

  it("prevents deleting, deactivating, or demoting the last active company admin", async () => {
    fake.__db.employees = fake.__db.employees.filter(
      (row) => row.id !== ENAYA_ADMIN_2,
    );
    const token = adminToken();
    const del = await request("DELETE", `/api/employees/${ENAYA_ADMIN_ID}`, { token });
    assert.equal(del.status, 409);
    assert.equal(del.json.code, "LAST_ADMIN_REQUIRED");
    const deactivate = await request("PATCH", `/api/employees/${ENAYA_ADMIN_ID}/active`, {
      token,
      body: { is_active: false },
    });
    assert.equal(deactivate.status, 409);
    const demote = await request("PATCH", `/api/employees/${ENAYA_ADMIN_ID}`, {
      token,
      body: { role: "employee" },
    });
    assert.equal(demote.status, 409);
  });

  it("allows changing one of two active admins", async () => {
    const token = adminToken();
    const demote = await request("PATCH", `/api/employees/${ENAYA_ADMIN_2}`, {
      token,
      body: { role: "employee" },
    });
    assert.equal(demote.status, 200, demote.json?.message);
    const staffDenied = await request("DELETE", `/api/employees/${ENAYA_ADMIN_2}`, {
      token: staffToken(),
    });
    assert.equal(staffDenied.status, 403);
  });

  it("rejects passwords shorter than 8 characters or longer than 72 UTF-8 bytes", async () => {
    const token = adminToken();
    const short = await request("POST", "/api/employees", {
      token,
      body: { name: "Short", email: "short@enaya.local", password: "1234567" },
    });
    assert.equal(short.status, 400);
    const long = await request("POST", "/api/employees", {
      token,
      body: {
        name: "Long",
        email: "long@enaya.local",
        password: `${"é".repeat(37)}!`,
      },
    });
    assert.equal(long.status, 400);
    assert.equal(Buffer.byteLength(`${"é".repeat(37)}!`, "utf8") > 72, true);
    const signupShort = await request("POST", "/api/public/signup", {
      body: {
        name: "Owner",
        email: "owner@new.local",
        password: "short",
        companyName: "New Co",
        slug: "new-co-sec",
      },
    });
    assert.equal(signupShort.status, 400);
    const ok = await request("POST", "/api/employees", {
      token,
      body: {
        name: "Ok",
        email: "okpass@enaya.local",
        password: "password1",
      },
    });
    assert.equal(ok.status, 201, ok.json?.message);
  });

  it("hides live webhook tokens on GET and reveals a new URL only on rotate", async () => {
    const created = await request("POST", "/api/company/integrations", {
      token: adminToken(),
      body: {
        provider: "easyorders",
        name: "EO WH",
        credentials: { apiKey: "easy-secret-key" },
      },
    });
    assert.equal(created.status, 201);
    assert.match(created.json.data.webhookUrl, /\/webhooks\/easyorders\//);
    const token = tokenFromWebhookUrl(created.json.data.webhookUrl);
    const listed = await request("GET", "/api/company/integrations", {
      token: adminToken(),
    });
    const row = listed.json.data.find((item) => item.id === created.json.data.id);
    assert.equal(row.webhookUrl, null);
    assert.equal(row.webhookConfigured, true);
    assert.equal(JSON.stringify(listed.json).includes(token), false);

    const platformGet = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations`,
      { token: platformToken() },
    );
    const platformRow = (platformGet.json.data || []).find(
      (item) => item.id === created.json.data.id,
    );
    assert.equal(platformRow.webhookUrl, null);
    assert.equal(JSON.stringify(platformGet.json).includes(token), false);

    const rotated = await request(
      "POST",
      `/api/company/integrations/${created.json.data.id}/rotate-webhook`,
      { token: adminToken() },
    );
    assert.equal(rotated.status, 200);
    assert.match(rotated.json.data.webhookUrl, /\/webhooks\/easyorders\//);
    const newToken = tokenFromWebhookUrl(rotated.json.data.webhookUrl);
    assert.notEqual(newToken, token);

    const oldHook = await request(
      "POST",
      `/webhooks/easyorders/${token}/order-created`,
      { body: { id: "eo-old", full_name: "Old" } },
    );
    assert.equal(oldHook.status, 401);
    const unknown = await request(
      "POST",
      "/webhooks/easyorders/not-a-real-token/order-created",
      { body: { id: "x" } },
    );
    assert.equal(unknown.status, 401);

    const okHook = await request(
      "POST",
      `/webhooks/easyorders/${newToken}/order-created`,
      { body: { id: "eo-new", full_name: "New" } },
    );
    assert.equal(okHook.status, 200);
    assert.equal(okHook.json.ok, true);
    assert.equal(okHook.json.data?.raw_data, undefined);
    assert.equal(JSON.stringify(okHook.json).includes("raw_data"), false);
    assert.equal(JSON.stringify(okHook.json).includes("full_name"), false);
  });

  it("rejects disabled integrations, inactive companies, and oversized webhook bodies", async () => {
    const created = await request("POST", "/api/company/integrations", {
      token: adminToken(),
      body: {
        provider: "bosta",
        name: "Bosta WH",
        credentials: { apiKey: "boost-secret" },
      },
    });
    const hookToken = tokenFromWebhookUrl(created.json.data.webhookUrl);
    await request("PATCH", `/api/company/integrations/${created.json.data.id}`, {
      token: adminToken(),
      body: { enabled: false },
    });
    const disabled = await request(
      "POST",
      `/webhooks/bosta/${hookToken}/order-status`,
      { body: { orderAlias: "A1" } },
    );
    assert.equal(disabled.status, 401);

    await request("PATCH", `/api/company/integrations/${created.json.data.id}`, {
      token: adminToken(),
      body: { enabled: true },
    });
    fake.__db.companies.find((row) => row.id === ENAYA_ID).is_active = false;
    const inactive = await request(
      "POST",
      `/webhooks/bosta/${hookToken}/order-status`,
      { body: { orderAlias: "A1" } },
    );
    assert.equal(inactive.status, 401);

    fake.__db.companies.find((row) => row.id === ENAYA_ID).is_active = true;
    const oversized = await request(
      "POST",
      `/webhooks/easyorders/${hookToken}/order-created`,
      {
        raw: `{"id":"${"x".repeat(1024 * 1024)}}`,
        headers: { "Content-Type": "application/json" },
      },
    );
    assert.equal(oversized.status, 413);
  });

  it("hides SQL/provider details from production clients", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      fake.__db.__selectError = 'relation "orders" does not exist';
      fake.__db.__selectErrors = {
        products: 'duplicate key value violates unique constraint "products_pkey"',
        bosta_sku_mappings: "Supabase stack trace SECRET_VALUE",
        companies: 'column companies.secret does not exist',
      };
      const orders = await request("GET", "/api/orders", { token: adminToken() });
      assert.equal(orders.status, 500);
      const blob = JSON.stringify(orders.json).toLowerCase();
      assert.equal(blob.includes("does not exist"), false);
      assert.equal(blob.includes("relation"), false);
      const products = await request("GET", "/api/products", { token: adminToken() });
      assert.equal(JSON.stringify(products.json).includes("products_pkey"), false);
      const mappings = await request("GET", "/api/bosta/sku-mappings", {
        token: adminToken(),
      });
      assert.equal(JSON.stringify(mappings.json).includes("SECRET_VALUE"), false);
      const branding = await request("GET", "/api/public/companies/enaya/branding");
      assert.equal(JSON.stringify(branding.json).includes("column companies.secret"), false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("sends security headers and honors CORS allowlists", async () => {
    const allowed = await request("GET", "/", {
      headers: { Origin: "https://app.example.com" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.ok(allowed.headers.get("x-content-type-options"));
    assert.ok(allowed.headers.get("x-frame-options") || allowed.headers.get("content-security-policy") === null);
    assert.ok(allowed.headers.get("referrer-policy"));
    const denied = await request("GET", "/", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const noOrigin = await request("GET", "/");
    assert.equal(noOrigin.status, 200);
  });

  it("treats missing Origin as allowed and restricts unknown production origins", () => {
    assert.equal(isOriginAllowed(undefined), true);
    assert.equal(isOriginAllowed("https://app.example.com"), true);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(isOriginAllowed("https://evil.example"), false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("security MVP rate limits", () => {
  let rateServer;
  let rateBase;
  let previousLogin;
  let previousSignup;
  let previousPlatform;

  before(async () => {
    previousLogin = process.env.LOGIN_RATE_MAX;
    previousSignup = process.env.SIGNUP_RATE_MAX;
    previousPlatform = process.env.PLATFORM_LOGIN_RATE_MAX;
    process.env.LOGIN_RATE_MAX = "3";
    process.env.SIGNUP_RATE_MAX = "3";
    process.env.PLATFORM_LOGIN_RATE_MAX = "3";
    passwordHash = passwordHash || (await bcrypt.hash(DEV_PASSWORD, 10));
    const { createApp: createRateApp } = require("../src/app");
    const app = createRateApp();
    rateServer = http.createServer(app);
    await new Promise((resolve) => rateServer.listen(0, "127.0.0.1", resolve));
    rateBase = `http://127.0.0.1:${rateServer.address().port}`;
    fake = seedClient();
    supabase.__setClientForTests(fake);
  });

  after(async () => {
    if (previousLogin == null) delete process.env.LOGIN_RATE_MAX;
    else process.env.LOGIN_RATE_MAX = previousLogin;
    if (previousSignup == null) delete process.env.SIGNUP_RATE_MAX;
    else process.env.SIGNUP_RATE_MAX = previousSignup;
    if (previousPlatform == null) delete process.env.PLATFORM_LOGIN_RATE_MAX;
    else process.env.PLATFORM_LOGIN_RATE_MAX = previousPlatform;
    if (rateServer) {
      await new Promise((resolve, reject) => {
        rateServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  async function post(pathname, body) {
    const response = await fetch(`${rateBase}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, json };
  }

  it("rate-limits employee login aliases and platform login while allowing the first attempt", async () => {
    const first = await post("/api/employees/login", {
      companySlug: "enaya",
      email: "admin@enaya.local",
      password: DEV_PASSWORD,
    });
    assert.equal(first.status, 200, first.json?.message);
    await post("/api/employees/login-senior", {
      companySlug: "enaya",
      email: "nobody@enaya.local",
      password: "wrong",
    });
    await post("/api/easyorder/auth/login", {
      companySlug: "enaya",
      email: "nobody@enaya.local",
      password: "wrong",
    });
    const last = await post("/api/employees/login", {
      companySlug: "enaya",
      email: "nobody@enaya.local",
      password: "wrong",
    });
    assert.equal(last.status, 429);
    assert.equal(last.json.message.includes("@"), false);

    const platformFirst = await post("/api/platform/auth/login", {
      email: "platform@saas.local",
      password: DEV_PASSWORD,
    });
    assert.equal(platformFirst.status, 200, platformFirst.json?.message);
    await post("/api/platform/auth/login", { email: "x@y.z", password: "wrong" });
    await post("/api/platform/auth/login", { email: "x@y.z", password: "wrong" });
    const platformLast = await post("/api/platform/auth/login", {
      email: "x@y.z",
      password: "wrong",
    });
    assert.equal(platformLast.status, 429);
  });

  it("rate-limits public signup", async () => {
    const body = {
      name: "Owner",
      email: "rate@signup.local",
      password: "password1",
      companyName: "Rate Co",
      slug: "rate-co-1",
    };
    const first = await post("/api/public/signup", body);
    assert.equal([201, 400, 409].includes(first.status), true, first.json?.message);
    await post("/api/public/signup", { ...body, slug: "rate-co-2" });
    await post("/api/public/signup", { ...body, slug: "rate-co-3" });
    const last = await post("/api/public/signup", { ...body, slug: "rate-co-4" });
    assert.equal(last.status, 429);
  });
});
