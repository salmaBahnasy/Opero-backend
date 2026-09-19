process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.EASYORDER_API_KEY = "GLOBAL_EASYORDERS_SHOULD_NOT_BE_USED";
process.env.EASYORDER_API_BASE_URL =
  "https://api.easy-orders.net/api/v1/external-apps";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const fs = require("node:fs");
const path = require("node:path");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const {
  signEmployeeToken,
  signPlatformAdminToken,
} = require("../src/config/jwt");
const { encryptJson } = require("../src/config/integrationSecrets");
const { PROVIDERS, CATEGORIES } = require("../src/integrations/catalog");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EO_A_ID = "e1111111-1111-4111-8111-111111111111";
const EO_B_ID = "e2222222-2222-4222-8222-222222222222";
const SHOPIFY_ID = "s1111111-1111-4111-8111-111111111111";
const OTHER_EO_ID = "e3333333-3333-4333-8333-333333333333";
const FEATURE_WHATSAPP = "f5555555-5555-4555-8555-555555555555";
const FEATURE_ORDERS = "f1111111-1111-4111-8111-111111111111";
const DEV_PASSWORD = "DevPassword123!";
const NOW = new Date().toISOString();

let passwordHash;
let server;
let baseUrl;
let fake;
let capturedHttp = [];
const originalAxiosGet = axios.get;

function employeeToken(companyId, employeeId, email) {
  return signEmployeeToken({
    employeeId,
    companyId,
    role: "company_admin",
    email,
  });
}

const enayaToken = () =>
  employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
const otherToken = () =>
  employeeToken(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");

async function request(method, pathName, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathName}`, {
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
    features: [
      { id: FEATURE_ORDERS, key: "orders", is_active: true },
      { id: FEATURE_WHATSAPP, key: "whatsapp", is_active: true },
    ],
    company_features: [
      { company_id: ENAYA_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_WHATSAPP, is_enabled: true },
      { company_id: OTHER_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
    ],
    company_integrations: [
      {
        id: EO_A_ID,
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "easyorders",
        name: "EasyOrders Egypt",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "enaya-eo-a-key" }),
        settings: {},
      },
      {
        id: EO_B_ID,
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "easyorders",
        name: "EasyOrders KSA",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "enaya-eo-b-key" }),
        settings: {},
      },
      {
        id: SHOPIFY_ID,
        company_id: ENAYA_ID,
        category: "commerce",
        provider: "shopify",
        name: "Shopify Egypt",
        is_enabled: true,
        credentials: encryptJson({ accessToken: "shpat-enaya" }),
        settings: { shopDomain: "enaya.myshopify.com" },
      },
      {
        id: OTHER_EO_ID,
        company_id: OTHER_ID,
        category: "commerce",
        provider: "easyorders",
        name: "Other EasyOrders",
        is_enabled: true,
        credentials: encryptJson({ apiKey: "other-eo-key" }),
        settings: {},
      },
    ],
    orders: [
      {
        id: "ord-eo-a",
        company_id: ENAYA_ID,
        order_id: "easyorders-a-order",
        status: "new",
        source_integration_id: EO_A_ID,
        raw_data: {
          full_name: "EO A Customer",
          customer_status: "pending",
          customerStatus: "pending",
        },
        created_at: NOW,
      },
      {
        id: "ord-null-source",
        company_id: ENAYA_ID,
        order_id: "legacy-null-source",
        status: "new",
        source_integration_id: null,
        raw_data: {
          full_name: "Legacy Customer",
          customer_status: "pending",
          customerStatus: "pending",
        },
        created_at: NOW,
      },
      {
        id: "ord-manual",
        company_id: ENAYA_ID,
        order_id: "manual-order",
        status: "new",
        source_integration_id: null,
        raw_data: {
          is_manual: true,
          isManual: true,
          customer_status: "confirmed",
          customerStatus: "confirmed",
        },
        created_at: NOW,
      },
      {
        id: "ord-shopify",
        company_id: ENAYA_ID,
        order_id: "shopify-order",
        status: "new",
        source_integration_id: SHOPIFY_ID,
        raw_data: {
          full_name: "Shopify Customer",
          customer_status: "pending",
          customerStatus: "pending",
        },
        created_at: NOW,
      },
      {
        id: "ord-other",
        company_id: OTHER_ID,
        order_id: "other-eo-order",
        status: "new",
        source_integration_id: OTHER_EO_ID,
        raw_data: {
          full_name: "Other Company Customer",
          customer_status: "pending",
          customerStatus: "pending",
        },
        created_at: NOW,
      },
      {
        id: "ord-other-null",
        company_id: OTHER_ID,
        order_id: "other-null-source",
        status: "new",
        source_integration_id: null,
        raw_data: {
          full_name: "Other Legacy",
          customer_status: "pending",
          customerStatus: "pending",
        },
        created_at: NOW,
      },
      {
        id: "ord-cross-source",
        company_id: ENAYA_ID,
        order_id: "enaya-with-foreign-source",
        status: "new",
        source_integration_id: OTHER_EO_ID,
        raw_data: {
          full_name: "Foreign source",
          customer_status: "pending",
          customerStatus: "pending",
        },
        created_at: NOW,
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
  axios.get = async (url, config = {}) => {
    capturedHttp.push({ method: "GET", url, headers: config.headers || {} });
    const orderId = String(url || "").split("/orders/")[1] || "";
    return {
      status: 200,
      data: {
        id: orderId,
        short_id: "1001",
        status: "confirmed",
      },
    };
  };
});

afterEach(() => {
  axios.get = originalAxiosGet;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("EasyConfirm uses order source_integration_id", () => {
  it("refreshes through the order's EasyOrders connection", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/easyorders-a-order/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.customerStatus, "confirmed");
    assert.equal(capturedHttp.length, 1);
    assert.match(capturedHttp[0].url, /\/orders\/easyorders-a-order$/);
    assert.equal(capturedHttp[0].headers["Api-Key"], "enaya-eo-a-key");
    assert.equal(capturedHttp[0].headers["Api-Key"] === "enaya-eo-b-key", false);
    assert.equal(
      capturedHttp[0].headers["Api-Key"] === "GLOBAL_EASYORDERS_SHOULD_NOT_BE_USED",
      false,
    );
  });

  it("never falls back to the first EasyOrders connection when two exist", async () => {
    const { status } = await request(
      "POST",
      "/api/orders/easyorders-a-order/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 200);
    assert.equal(capturedHttp.length, 1);
    assert.equal(capturedHttp[0].headers["Api-Key"], "enaya-eo-a-key");
    assert.notEqual(capturedHttp[0].headers["Api-Key"], "enaya-eo-b-key");
  });

  it("does not guess a connection for a NULL-source order even if EasyOrders exists", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/legacy-null-source/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 409);
    assert.equal(json.code, "EASYCONFIRM_SOURCE_REQUIRED");
    assert.equal(capturedHttp.length, 0);
  });

  it("does not guess the single EasyOrders connection for another company's NULL-source order", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/other-null-source/refresh-customer-status",
      { token: otherToken() },
    );
    assert.equal(status, 409);
    assert.equal(json.code, "EASYCONFIRM_SOURCE_REQUIRED");
    assert.equal(capturedHttp.length, 0);
  });

  it("does not call EasyOrders for a non-EasyOrders source", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/shopify-order/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 409);
    assert.equal(json.code, "EASYCONFIRM_NOT_EASYORDERS");
    assert.equal(capturedHttp.length, 0);
  });

  it("rejects manual orders without calling EasyOrders", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/manual-order/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 400);
    assert.equal(json.code, "MANUAL_ORDER_NO_REFRESH");
    assert.equal(capturedHttp.length, 0);
  });

  it("GET local order details uses stored customer_status and does not call EasyOrders", async () => {
    const sourced = await request("GET", "/api/orders/easyorders-a-order", {
      token: enayaToken(),
    });
    assert.equal(sourced.status, 200);
    assert.equal(capturedHttp.length, 0);

    capturedHttp = [];
    const nullSource = await request("GET", "/api/orders/legacy-null-source", {
      token: enayaToken(),
    });
    assert.equal(nullSource.status, 200);
    assert.equal(capturedHttp.length, 0);

    const shopify = await request("GET", "/api/orders/shopify-order", {
      token: enayaToken(),
    });
    assert.equal(shopify.status, 200);
    assert.equal(capturedHttp.length, 0);
  });
});

describe("EasyConfirm tenant isolation", () => {
  it("ignores companyId injection in the request body", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/easyorders-a-order/refresh-customer-status",
      {
        token: enayaToken(),
        body: { companyId: OTHER_ID, company_id: OTHER_ID },
      },
    );
    assert.equal(status, 200);
    assert.equal(json.data.customerStatus, "confirmed");
    assert.equal(capturedHttp[0].headers["Api-Key"], "enaya-eo-a-key");
    assert.notEqual(capturedHttp[0].headers["Api-Key"], "other-eo-key");
  });

  it("does not let Company A refresh Company B orders", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/other-eo-order/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 404);
    assert.equal(capturedHttp.length, 0);
    assert.equal(JSON.stringify(json).includes("Other Company Customer"), false);
  });

  it("does not use another company's EasyOrders connection as source", async () => {
    const { status, json } = await request(
      "POST",
      "/api/orders/enaya-with-foreign-source/refresh-customer-status",
      { token: enayaToken() },
    );
    assert.equal(status, 404);
    assert.equal(json.code, "INTEGRATION_NOT_FOUND");
    assert.equal(capturedHttp.length, 0);
  });

  it("rejects a platform JWT", async () => {
    const token = signPlatformAdminToken({
      platformAdminId: PLATFORM_ADMIN_ID,
      email: "platform@saas.local",
    });
    const { status, json } = await request(
      "POST",
      "/api/orders/easyorders-a-order/refresh-customer-status",
      { token },
    );
    assert.equal(status, 403);
    assert.equal(json.code, "JWT_WRONG_SCOPE");
    assert.equal(capturedHttp.length, 0);
  });
});

describe("current WhatsApp product has no messaging API", () => {
  it("does not expose a WhatsApp send endpoint", async () => {
    const missing = await request("POST", "/api/whatsapp/send", {
      token: enayaToken(),
      body: { phone: "01012345678", text: "hi" },
    });
    assert.equal(missing.status, 404);
  });

  it("does not register a WhatsApp provider or communication category", () => {
    assert.equal(PROVIDERS.whatsapp, undefined);
    assert.equal(CATEGORIES.includes("communication"), false);
  });

  it("does not put WhatsApp/Meta secrets into company bootstrap", async () => {
    const { status, json } = await request("GET", "/api/company/bootstrap", {
      token: enayaToken(),
    });
    assert.equal(status, 200);
    assert.equal(json.data.features.whatsapp, true);
    const blob = JSON.stringify(json);
    for (const needle of [
      "enaya-eo-a-key",
      "enaya-eo-b-key",
      "other-eo-key",
      "shpat-enaya",
      "GLOBAL_EASYORDERS_SHOULD_NOT_BE_USED",
      "waba_id",
      "WABA",
      "phone_number_id",
      "whatsapp_access_token",
      "verify_token",
    ]) {
      assert.equal(blob.includes(needle), false, needle);
    }
    const integrations = [
      ...json.data.integrations.commerce,
      ...json.data.integrations.shipping,
    ];
    assert.equal(
      integrations.some((row) => row.provider === "whatsapp"),
      false,
    );
  });

  it("keeps order_source=whatsapp as a marketing label in code, not an integration", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../src/services/webhookOrders.service.js"),
      "utf8",
    );
    assert.match(source, /value:\s*"whatsapp"/);
    const catalog = fs.readFileSync(
      path.join(__dirname, "../src/integrations/catalog.js"),
      "utf8",
    );
    assert.equal(/\bwhatsapp\s*:/.test(catalog), false);
  });
});
