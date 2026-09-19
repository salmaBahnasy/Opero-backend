process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DEV_PASSWORD = "DevPassword123!";
const FEATURES = [
  ["orders", "Orders", "core"],
  ["products", "Products", "core"],
  ["employees", "Employees", "core"],
  ["analytics", "Analytics", "core"],
  ["bosta", "Bosta", "operational"],
  ["whatsapp", "WhatsApp", "operational"],
  ["easyorders", "EasyOrders", "legacy"],
  ["salla", "Salla", "legacy"],
  ["shopify", "Shopify", "legacy"],
  ["ai", "AI", "other"],
];

let passwordHash;
let server;
let baseUrl;
let fake;

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

function featureId(key) {
  return `feat-${key}`;
}

function seed() {
  return createFakeSupabase({
    companies: [
      {
        id: COMPANY_A,
        name: "Alpha Co",
        slug: "alpha",
        is_active: true,
        deleted_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        subscription_status: "none",
      },
      {
        id: COMPANY_B,
        name: "Beta Co",
        slug: "beta",
        is_active: true,
        deleted_at: null,
        created_at: "2026-08-01T00:00:00.000Z",
        subscription_status: "trial",
      },
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
        id: ADMIN_A,
        company_id: COMPANY_A,
        name: "Alpha Admin",
        email: "admin@alpha.test",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
      {
        id: STAFF_A,
        company_id: COMPANY_A,
        name: "Alpha Staff",
        email: "staff@alpha.test",
        password: passwordHash,
        role: "employee",
        is_active: true,
      },
      {
        id: ADMIN_B,
        company_id: COMPANY_B,
        name: "Beta Admin",
        email: "admin@beta.test",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
    ],
    products: [
      { id: "prod-a1", company_id: COMPANY_A, name: "A1" },
      { id: "prod-a2", company_id: COMPANY_A, name: "A2" },
      { id: "prod-b1", company_id: COMPANY_B, name: "B1" },
    ],
    orders: [
      { id: "ord-a1", company_id: COMPANY_A, order_id: "1" },
      { id: "ord-b1", company_id: COMPANY_B, order_id: "1" },
      { id: "ord-b2", company_id: COMPANY_B, order_id: "2" },
    ],
    company_integrations: [
      {
        id: "int-a-shopify-1",
        company_id: COMPANY_A,
        provider: "shopify",
        category: "commerce",
        name: "Store A1",
        is_enabled: true,
        credentials: { shouldNeverAppear: "shpat-live-secret" },
      },
      {
        id: "int-a-shopify-2",
        company_id: COMPANY_A,
        provider: "shopify",
        category: "commerce",
        name: "Store A2",
        is_enabled: true,
      },
      {
        id: "int-b-salla",
        company_id: COMPANY_B,
        provider: "salla",
        category: "commerce",
        name: "Salla B",
        is_enabled: true,
      },
    ],
    features: FEATURES.map(([key, name]) => ({
      id: featureId(key),
      key,
      name,
      is_active: true,
    })),
    company_features: [
      { company_id: COMPANY_A, feature_id: featureId("orders"), is_enabled: true },
      { company_id: COMPANY_A, feature_id: featureId("bosta"), is_enabled: false },
      { company_id: COMPANY_B, feature_id: featureId("orders"), is_enabled: true },
      { company_id: COMPANY_B, feature_id: featureId("bosta"), is_enabled: true },
    ],
  });
}

describe("platform Super Admin company operations", () => {
  before(async () => {
    passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    fake = seed();
    supabase.__setClientForTests(fake);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  async function loginPlatform() {
    const { status, json } = await request("POST", "/api/platform/auth/login", {
      body: { email: "platform@saas.local", password: DEV_PASSWORD },
    });
    assert.equal(status, 200);
    return json.token;
  }

  it("lists companies newest first with integration counts and no N+1 employee rows", async () => {
    const token = await loginPlatform();
    const listed = await request("GET", "/api/platform/companies", { token });
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.json.data.map((row) => row.slug),
      ["beta", "alpha"],
    );
    const alpha = listed.json.data.find((row) => row.slug === "alpha");
    assert.equal(alpha.integrationsCount, 2);
    assert.equal("usage" in alpha, false);
  });

  it("returns company-scoped counts, subscription status, and credential-free integration summary", async () => {
    const token = await loginPlatform();
    const details = await request("GET", `/api/platform/companies/${COMPANY_A}`, {
      token,
    });
    assert.equal(details.status, 200);
    assert.equal(details.json.data.subscription_status, "none");
    assert.deepEqual(details.json.data.usage, {
      employees: 2,
      products: 2,
      orders: 1,
      integrations: 2,
    });
    const shopify = details.json.data.integrationsSummary.find(
      (row) => row.provider === "shopify",
    );
    assert.equal(shopify.connections, 2);
    assert.equal(shopify.connected, true);
    const blob = JSON.stringify(details.json);
    assert.equal(blob.includes("shpat-live-secret"), false);
    assert.equal(blob.includes("password"), false);
  });

  it("counts stay scoped to the requested company", async () => {
    const token = await loginPlatform();
    const details = await request("GET", `/api/platform/companies/${COMPANY_B}`, {
      token,
    });
    assert.equal(details.json.data.usage.employees, 1);
    assert.equal(details.json.data.usage.products, 1);
    assert.equal(details.json.data.usage.orders, 2);
    assert.equal(details.json.data.usage.integrations, 1);
    assert.equal(details.json.data.subscription_status, "trial");
  });

  it("platform admin can read safe employees and never receives password hashes", async () => {
    const token = await loginPlatform();
    const listed = await request(
      "GET",
      `/api/platform/companies/${COMPANY_A}/employees`,
      { token },
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data[0].role, "company_admin");
    assert.equal(listed.json.data[0].isCompanyAdmin, true);
    const blob = JSON.stringify(listed.json);
    assert.equal(blob.includes("password"), false);
    assert.equal(blob.includes(passwordHash), false);
    assert.equal(blob.includes("$2"), false);
  });

  it("company JWTs cannot access platform employee or feature endpoints", async () => {
    const token = employeeToken(COMPANY_A, ADMIN_A, "admin@alpha.test");
    const employees = await request(
      "GET",
      `/api/platform/companies/${COMPANY_A}/employees`,
      { token },
    );
    const features = await request(
      "GET",
      `/api/platform/companies/${COMPANY_A}/features`,
      { token },
    );
    const toggle = await request(
      "PATCH",
      `/api/platform/companies/${COMPANY_A}/features/bosta`,
      { token, body: { is_enabled: true } },
    );
    assert.equal(employees.status, 403);
    assert.equal(features.status, 403);
    assert.equal(toggle.status, 403);
  });

  it("platform admin can list and toggle catalog features without touching another company", async () => {
    const token = await loginPlatform();
    const listed = await request(
      "GET",
      `/api/platform/companies/${COMPANY_A}/features`,
      { token },
    );
    assert.equal(listed.status, 200);
    const bosta = listed.json.data.find((row) => row.key === "bosta");
    assert.equal(bosta.is_enabled, false);
    assert.equal(bosta.group, "operational");

    const enabled = await request(
      "PATCH",
      `/api/platform/companies/${COMPANY_A}/features/bosta`,
      { token, body: { is_enabled: true } },
    );
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.data.is_enabled, true);

    const disabled = await request(
      "PATCH",
      `/api/platform/companies/${COMPANY_A}/features/bosta`,
      { token, body: { is_enabled: false } },
    );
    assert.equal(disabled.status, 200);
    const afterA = await request(
      "GET",
      `/api/platform/companies/${COMPANY_A}/features`,
      { token },
    );
    const afterB = await request(
      "GET",
      `/api/platform/companies/${COMPANY_B}/features`,
      { token },
    );
    assert.equal(afterA.json.data.find((row) => row.key === "bosta").is_enabled, false);
    assert.equal(afterB.json.data.find((row) => row.key === "bosta").is_enabled, true);
  });

  it("rejects unknown features and non-boolean toggle values", async () => {
    const token = await loginPlatform();
    const unknown = await request(
      "PATCH",
      `/api/platform/companies/${COMPANY_A}/features/not-a-feature`,
      { token, body: { is_enabled: true } },
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, "INVALID_FEATURE");

    const invalid = await request(
      "PATCH",
      `/api/platform/companies/${COMPANY_A}/features/bosta`,
      { token, body: { is_enabled: "yes" } },
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_FEATURE_VALUE");
  });

  it("does not leak raw database messages from unexpected platform company errors", async () => {
    const token = await loginPlatform();
    const originalFrom = fake.from.bind(fake);
    fake.from = (table) => {
      if (table === "companies") {
        throw new Error('duplicate key value violates unique constraint "secret_idx"');
      }
      return originalFrom(table);
    };
    const listed = await request("GET", "/api/platform/companies", { token });
    assert.equal(listed.status, 500);
    assert.equal(listed.json.message, "Failed to list companies");
    const blob = JSON.stringify(listed.json);
    assert.equal(blob.includes("duplicate key"), false);
    assert.equal(blob.includes("secret_idx"), false);
    assert.equal("error" in listed.json, false);
  });
});
