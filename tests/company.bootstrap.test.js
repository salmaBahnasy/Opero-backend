process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const {
  signEmployeeToken,
  signPlatformAdminToken,
} = require("../src/config/jwt");
const { encryptJson } = require("../src/config/integrationSecrets");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const INACTIVE_ID = "33333333-3333-4333-8333-333333333333";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FEATURE_ORDERS = "f1111111-1111-4111-8111-111111111111";
const FEATURE_PRODUCTS = "f2222222-2222-4222-8222-222222222222";
const FEATURE_EMPLOYEES = "f3333333-3333-4333-8333-333333333333";
const FEATURE_ANALYTICS = "f4444444-4444-4444-8444-444444444444";
const DEV_PASSWORD = "DevPassword123!";

let passwordHash;
let server;
let baseUrl;
let fake;

function enayaToken() {
  return signEmployeeToken({
    employeeId: ENAYA_ADMIN_ID,
    companyId: ENAYA_ID,
    role: "company_admin",
    email: "admin@enaya.local",
  });
}

function otherToken() {
  return signEmployeeToken({
    employeeId: OTHER_ADMIN_ID,
    companyId: OTHER_ID,
    role: "company_admin",
    email: "admin@other.local",
  });
}

async function request(method, path, { token, body, headers = {} } = {}) {
  const nextHeaders = { "Content-Type": "application/json", ...headers };
  if (token) nextHeaders.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: nextHeaders,
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

function assertNoSecrets(payload) {
  const blob = JSON.stringify(payload);
  const forbidden = [
    "SHOULD_NEVER_APPEAR",
    "enaya-easy-secret",
    "other-easy-secret",
    "webhook-secret-token",
    "shpat-enaya",
    "accessToken",
    "apiKey",
    "credentials",
    "webhook_token",
    "webhookUrl",
    "webhook_token_hash",
    "webhook_token_encrypted",
    '"iv"',
    '"tag"',
    "login_image_url",
  ];
  for (const value of forbidden) {
    assert.equal(blob.includes(value), false, `bootstrap leaked ${value}`);
  }
}

function seedClient() {
  return createFakeSupabase({
    companies: [
      {
        id: ENAYA_ID,
        name: "Enaya",
        slug: "enaya",
        logo_url: "https://cdn.example.test/enaya/logo.png",
        login_image_url: "https://cdn.example.test/enaya/login.png",
        favicon_url: "https://cdn.example.test/enaya/favicon.ico",
        primary_color: "#0f6b57",
        secondary_color: "#14201b",
        is_active: true,
        deleted_at: null,
      },
      {
        id: OTHER_ID,
        name: "Other Co",
        slug: "other",
        logo_url: "https://cdn.example.test/other/logo.png",
        login_image_url: "https://cdn.example.test/other/login.png",
        favicon_url: "https://cdn.example.test/other/favicon.ico",
        primary_color: "#1d4ed8",
        secondary_color: "#0f172a",
        is_active: true,
        deleted_at: null,
      },
      {
        id: INACTIVE_ID,
        name: "Paused Co",
        slug: "paused",
        logo_url: "https://cdn.example.test/paused/logo.png",
        is_active: false,
        deleted_at: null,
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
    platform_admins: [
      {
        id: PLATFORM_ADMIN_ID,
        name: "Platform Super Admin",
        email: "platform@saas.local",
        password: passwordHash,
        is_active: true,
      },
    ],
    features: [
      { id: FEATURE_ORDERS, key: "orders", is_active: true },
      { id: FEATURE_PRODUCTS, key: "products", is_active: true },
      { id: FEATURE_EMPLOYEES, key: "employees", is_active: true },
      { id: FEATURE_ANALYTICS, key: "analytics", is_active: true },
    ],
    company_features: [
      { company_id: ENAYA_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_PRODUCTS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_EMPLOYEES, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_ANALYTICS, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_PRODUCTS, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_EMPLOYEES, is_enabled: false },
      { company_id: OTHER_ID, feature_id: FEATURE_ANALYTICS, is_enabled: false },
    ],
    company_integrations: [
      {
        id: "int-enaya-eo",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "easyorders",
        name: "EasyOrders Egypt",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "SHOULD_NEVER_APPEAR" }),
        settings: {},
        webhook_token_hash: "hash-enaya-eo",
        webhook_token_encrypted: encryptJson({ token: "webhook-secret-token" }),
      },
      {
        id: "int-enaya-shop-eg",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "shopify",
        name: "Shopify Egypt",
        is_enabled: true,
        credentials: encryptJson({ accessToken: "shpat-enaya" }),
        settings: { shopDomain: "enaya-eg.myshopify.com" },
      },
      {
        id: "int-enaya-shop-sa",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "shopify",
        name: "Shopify Saudi",
        is_enabled: true,
        credentials: encryptJson({ accessToken: "shpat-enaya-sa" }),
        settings: { shopDomain: "enaya-sa.myshopify.com" },
      },
      {
        id: "int-enaya-bosta",
        company_id: ENAYA_ID,
        category: "shipping",
        provider: "bosta",
        name: "Bosta Egypt",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "enaya-easy-secret" }),
      },
      {
        id: "int-enaya-mylerz-off",
        company_id: ENAYA_ID,
        category: "shipping",
        provider: "mylerz",
        name: "Mylerz Disabled",
        is_enabled: false,
        credentials: encryptJson({ apiKey: "SHOULD_NEVER_APPEAR" }),
      },
      {
        id: "int-enaya-old-erp",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "spreadsheet",
        name: "Old ERP",
        is_enabled: true,
        credentials: encryptJson({}),
        settings: {},
      },
      {
        id: "int-enaya-prev-store",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "spreadsheet",
        name: "Previous Store",
        is_enabled: false,
        credentials: encryptJson({}),
        settings: {},
      },
      {
        id: "int-enaya-shop-off",
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "shopify",
        name: "Shopify Disabled",
        is_enabled: false,
        credentials: encryptJson({ accessToken: "shpat-disabled" }),
        settings: { shopDomain: "enaya-off.myshopify.com" },
      },
      {
        id: "int-other-eo",
        company_id: OTHER_ID,
        category: "commerce",
        provider: "easyorders",
        name: "Other EasyOrders",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "other-easy-secret" }),
      },
      {
        id: "int-other-bosta",
        company_id: OTHER_ID,
        category: "shipping",
        provider: "bosta",
        name: "Other Bosta",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "other-bosta-secret" }),
      },
      {
        id: "int-other-shop",
        company_id: OTHER_ID,
        category: "commerce",
        provider: "shopify",
        name: "Other Shopify",
        is_enabled: true,
        credentials: encryptJson({ accessToken: "other-shop-token" }),
        settings: { shopDomain: "other.myshopify.com" },
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
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("company bootstrap and public branding", () => {
  it("returns Company A bootstrap for a Company A employee", async () => {
    const { status, json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    assert.equal(status, 200);
    assert.equal(json.data.company.id, ENAYA_ID);
    assert.equal(json.data.company.name, "Enaya");
    assert.equal(json.data.company.slug, "enaya");
    assert.equal(json.data.company.active, true);
    assert.equal(json.data.employee.id, ENAYA_ADMIN_ID);
    assert.equal(json.data.employee.role, "company_admin");
    assert.equal(json.data.branding.logoUrl, "https://cdn.example.test/enaya/logo.png");
    assert.equal(json.data.branding.loginImageUrl, "https://cdn.example.test/enaya/login.png");
    assert.equal(json.data.branding.faviconUrl, "https://cdn.example.test/enaya/favicon.ico");
    assert.equal(json.data.branding.primaryColor, "#0f6b57");
    assert.deepEqual(json.data.features, {
      orders: true,
      products: true,
      employees: true,
      analytics: true,
    });
    assertNoSecrets(json);
  });

  it("returns Company B bootstrap for a Company B employee", async () => {
    const { status, json } = await request("GET", "/api/company/bootstrap", {
      token: otherToken(),
    });
    assert.equal(status, 200);
    assert.equal(json.data.company.id, OTHER_ID);
    assert.equal(json.data.company.slug, "other");
    assert.equal(json.data.employee.id, OTHER_ADMIN_ID);
    assert.deepEqual(json.data.features, {
      orders: true,
      products: true,
      employees: false,
      analytics: false,
    });
    assert.equal(
      json.data.integrations.commerce.some((row) => row.name === "EasyOrders Egypt"),
      false,
    );
    assert.deepEqual(
      json.data.integrations.commerce.map((row) => row.name).sort(),
      ["Other EasyOrders", "Other Shopify"],
    );
    assertNoSecrets(json);
  });

  it("uses JWT companyId and ignores query, headers, and body overrides", async () => {
    const { status, json } = await request(
      "GET",
      `/api/company/bootstrap?companyId=${OTHER_ID}&company_id=${OTHER_ID}&slug=other`,
      {
        token: enayaToken(),
        headers: {
          "x-company-id": OTHER_ID,
          "x-company-slug": "other",
          "company-id": OTHER_ID,
        },
      },
    );
    assert.equal(status, 200);
    assert.equal(json.data.company.id, ENAYA_ID);
    assert.equal(json.data.company.slug, "enaya");
  });

  it("never returns Company B integrations to Company A", async () => {
    const { json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    const names = [
      ...json.data.integrations.commerce,
      ...json.data.integrations.shipping,
    ].map((row) => row.name);
    assert.equal(names.includes("Other EasyOrders"), false);
    assert.equal(names.includes("Other Bosta"), false);
    assert.equal(names.includes("Other Shopify"), false);
  });

  it("returns multiple commerce and shipping connections independently", async () => {
    const { json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    assert.deepEqual(
      json.data.integrations.commerce.map((row) => row.name).sort(),
      ["EasyOrders Egypt", "Shopify Egypt", "Shopify Saudi"],
    );
    assert.deepEqual(
      json.data.integrations.shipping.map((row) => row.name),
      ["Bosta Egypt"],
    );
    assert.equal(
      json.data.integrations.commerce.filter((row) => row.provider === "shopify").length,
      2,
    );
    for (const row of [
      ...json.data.integrations.commerce,
      ...json.data.integrations.shipping,
    ]) {
      assert.deepEqual(Object.keys(row).sort(), [
        "category",
        "enabled",
        "id",
        "name",
        "provider",
      ]);
      assert.equal(row.enabled, true);
    }
  });

  it("omits disabled integrations from bootstrap", async () => {
    const { json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    const names = [
      ...json.data.integrations.commerce,
      ...json.data.integrations.shipping,
    ].map((row) => row.name);
    assert.equal(names.includes("Mylerz Disabled"), false);
    assert.equal(names.includes("Shopify Disabled"), false);
    assert.equal(names.includes("Previous Store"), false);
  });

  it("keeps disabled and spreadsheet sources in label metadata without making them operational", async () => {
    const { json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    const commerceNames = json.data.integrations.commerce.map((row) => row.name);
    const sourceNames = json.data.integrations.sources.map((row) => row.name);
    assert.equal(commerceNames.includes("Old ERP"), false);
    assert.equal(commerceNames.includes("Previous Store"), false);
    assert.equal(commerceNames.includes("Shopify Disabled"), false);
    assert.equal(sourceNames.includes("Old ERP"), true);
    assert.equal(sourceNames.includes("Previous Store"), true);
    assert.equal(sourceNames.includes("Shopify Disabled"), true);
    assert.equal(sourceNames.includes("EasyOrders Egypt"), true);
    const oldErp = json.data.integrations.sources.find((row) => row.name === "Old ERP");
    const previous = json.data.integrations.sources.find((row) => row.name === "Previous Store");
    assert.equal(oldErp.provider, "spreadsheet");
    assert.equal(oldErp.enabled, true);
    assert.equal(previous.enabled, false);
    for (const row of json.data.integrations.sources) {
      assert.deepEqual(Object.keys(row).sort(), [
        "category",
        "enabled",
        "id",
        "name",
        "provider",
      ]);
    }
    assertNoSecrets(json);
  });

  it("does not expose credentials, tokens, webhook URLs, or shopDomain", async () => {
    const { json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    assertNoSecrets(json);
    const blob = JSON.stringify(json.data.integrations);
    assert.equal(blob.includes("shopDomain"), false);
    assert.equal(blob.includes("myshopify.com"), false);
    assert.equal(blob.includes("/webhooks/"), false);
  });

  it("rejects a platform admin JWT on company bootstrap", async () => {
    const token = signPlatformAdminToken({
      platformAdminId: PLATFORM_ADMIN_ID,
      email: "platform@saas.local",
    });
    const { status, json } = await request("GET", "/api/company/bootstrap", {
      token,
    });
    assert.equal(status, 403);
    assert.equal(json.code, "JWT_WRONG_SCOPE");
  });

  it("returns only public branding for an active company slug", async () => {
    const { status, json } = await request(
      "GET",
      "/api/public/companies/enaya/branding",
    );
    assert.equal(status, 200);
    assert.deepEqual(json.data, {
      name: "Enaya",
      slug: "enaya",
      logoUrl: "https://cdn.example.test/enaya/logo.png",
      loginImageUrl: "https://cdn.example.test/enaya/login.png",
      faviconUrl: "https://cdn.example.test/enaya/favicon.ico",
      primaryColor: "#0f6b57",
      secondaryColor: "#14201b",
    });
    assert.equal(json.data.id, undefined);
    const blob = JSON.stringify(json);
    assert.equal(blob.includes(ENAYA_ID), false);
    assert.equal(blob.includes("admin@enaya.local"), false);
    assert.equal(blob.includes("SHOULD_NEVER_APPEAR"), false);
    assert.equal(blob.includes("integrations"), false);
    assert.equal(blob.includes("employees"), false);
  });

  it("hides unknown and inactive company slugs the same way", async () => {
    const unknown = await request("GET", "/api/public/companies/nope/branding");
    const inactive = await request("GET", "/api/public/companies/paused/branding");
    assert.equal(unknown.status, 404);
    assert.equal(inactive.status, 404);
    assert.equal(unknown.json.message, "Company not found");
    assert.equal(inactive.json.message, "Company not found");
    assert.equal(JSON.stringify(inactive.json).includes("Paused Co"), false);
    assert.equal(JSON.stringify(inactive.json).includes("cdn.example.test/paused"), false);
  });
});
