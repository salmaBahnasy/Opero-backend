process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-07";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");
const { runWithTenantContext } = require("../src/utils/tenantScope");
const { resolveLineCatalogProduct } = require("../src/services/bostaShipping.service");
const {
  normalizeShopifyOrder,
  numericShopifyId,
} = require("../src/services/shopifyOrders.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRODUCT_A_ID = "c1111111-aaaa-4111-8111-111111111111";
const PRODUCT_B_ID = "c2222222-bbbb-4222-8222-222222222222";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "shopify-hmac-secret-value";
const ACCESS_TOKEN = "shpat-orders-test-token";
const SHOP_A = "enaya-eg.myshopify.com";
const SHOP_B = "enaya-sa.myshopify.com";
const RANGE = "from=2020-01-01&to=2030-12-31";

let passwordHash;
let server;
let baseUrl;
let fake;

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

function otherToken() {
  return signEmployeeToken({
    employeeId: OTHER_ADMIN_ID,
    companyId: OTHER_ID,
    role: "company_admin",
    email: "admin@other.local",
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

async function createShopifyStore(
  token,
  {
    companyId = ENAYA_ID,
    name = "Shopify Egypt",
    shopDomain = SHOP_A,
    webhookSecret = WEBHOOK_SECRET,
    accessToken = ACCESS_TOKEN,
  } = {},
) {
  return createConnection(token, companyId, {
    category: "commerce",
    provider: "shopify",
    name,
    credentials: { accessToken, webhookSecret, shopDomain },
  });
}

function sampleOrder(overrides = {}) {
  return {
    id: "820982911946154508",
    email: "guest@example.com",
    created_at: "2026-09-18T10:00:00-04:00",
    updated_at: "2026-09-18T10:05:00-04:00",
    total_price: "403.00",
    subtotal_price: "393.00",
    total_tax: "0.00",
    total_discounts: "5.00",
    currency: "SAR",
    financial_status: "paid",
    fulfillment_status: "fulfilled",
    name: "#1001",
    order_number: 1001,
    cancelled_at: null,
    cancel_reason: null,
    tags: "vip, wholesale",
    note: "Leave at door",
    phone: null,
    contact_email: "contact@example.com",
    gateway: "cod",
    total_shipping_price_set: {
      shop_money: { amount: "15.00", currency_code: "SAR" },
    },
    shipping_address: {
      name: "Noura Al Saud",
      first_name: "Noura",
      last_name: "Al Saud",
      phone: "+966501234567",
      address1: "King Fahd Rd",
      address2: "Apt 8",
      city: "Riyadh",
      province: "Riyadh Region",
      province_code: "SA-01",
      country: "Saudi Arabia",
      country_code: "SA",
      zip: "12271",
    },
    billing_address: {
      name: "Billing Name",
      phone: "+966509999999",
      address1: "Billing St",
      city: "Jeddah",
      province: "Makkah",
      country: "Saudi Arabia",
      country_code: "SA",
      zip: "21577",
    },
    customer: {
      id: 115310627,
      email: "noura@example.com",
      first_name: "Noura",
      last_name: "Customer",
      phone: "+966500000000",
    },
    line_items: [
      {
        id: 487946274,
        variant_id: 39072856,
        title: "Serum 30ml",
        quantity: 2,
        sku: "SERUM-30",
        variant_title: "Default",
        product_id: 632910392,
        name: "Serum 30ml - Default",
        price: "199.00",
        total_discount: "5.00",
        admin_graphql_api_id: "gid://shopify/LineItem/487946274",
      },
    ],
    ...overrides,
  };
}

async function signedShopifyWebhook(
  webhookUrl,
  { topic, json, raw, shop, secret, webhookId } = {},
) {
  const token = tokenFromWebhookUrl(webhookUrl);
  const rawBody =
    raw != null ? raw : Buffer.from(JSON.stringify(json || sampleOrder()));
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-SHA256": hmacFor(rawBody, secret || WEBHOOK_SECRET),
    "X-Shopify-Shop-Domain": shop || SHOP_A,
    "X-Shopify-Topic": topic || "orders/create",
  };
  if (webhookId) headers["X-Shopify-Webhook-Id"] = webhookId;
  return request("POST", `/webhooks/shopify/${token}/orders`, {
    raw: rawBody,
    headers,
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

describe("Shopify order normalizer", () => {
  it("maps customer, guest checkout, phone, email, address, totals, and cart ids", async () => {
    const guest = await normalizeShopifyOrder({
      companyId: ENAYA_ID,
      sourceIntegrationId: "int-shop-a",
      topic: "orders/create",
      shopDomain: SHOP_A,
      catalogMap: new Map(),
      payload: {
        id: 55,
        email: "",
        contact_email: "guest@shop.test",
        name: "#55",
        phone: null,
        total_price: "10.00",
        subtotal_price: "8.00",
        total_discounts: "0.00",
        total_tax: "0.50",
        currency: "SAR",
        financial_status: "paid",
        customer: null,
        shipping_address: {
          name: "Guest Ship",
          phone: "+966511111111",
          address1: "Olaya St",
          city: "Riyadh",
          province: "Riyadh Region",
          country: "Saudi Arabia",
          country_code: "SA",
          zip: "12345",
        },
        line_items: [
          {
            product_id: 99,
            variant_id: 77,
            sku: "G-1",
            title: "Guest SKU",
            quantity: 1,
            price: "8.00",
            admin_graphql_api_id: "gid://shopify/LineItem/1",
          },
        ],
      },
    });
    assert.equal(guest.raw_data.full_name, "Guest Ship");
    assert.equal(guest.raw_data.phone, "+966511111111");
    assert.equal(guest.raw_data.email, "guest@shop.test");
    assert.equal(guest.raw_data.address.includes("Olaya St"), true);
    assert.equal(guest.raw_data.city, "Riyadh");
    assert.equal(guest.raw_data.total_cost, "10.00");
    assert.equal(guest.raw_data.cost, "8.00");
    assert.equal(guest.raw_data.currency, "SAR");
    assert.equal(guest.raw_data.cart_items[0].product_id, "99");
    assert.equal(guest.raw_data.cart_items[0].variant_id, "77");
    assert.equal(guest.raw_data.ingestion_source, "shopify");
    assert.equal(guest.status, "new");
    assert.equal(guest.raw_data.shopify.financial_status, "paid");

    const billed = await normalizeShopifyOrder({
      companyId: ENAYA_ID,
      sourceIntegrationId: "int-shop-a",
      topic: "orders/create",
      shopDomain: SHOP_A,
      catalogMap: new Map(),
      payload: {
        id: 56,
        email: "only@mail.test",
        shipping_address: null,
        billing_address: { name: "Bill Person", phone: "0555555555", city: "Jeddah" },
        customer: null,
        line_items: [],
      },
    });
    assert.equal(billed.raw_data.full_name, "Bill Person");
    assert.equal(billed.raw_data.phone, "0555555555");
    assert.equal(billed.raw_data.email, "only@mail.test");

    const fromCustomer = await normalizeShopifyOrder({
      companyId: ENAYA_ID,
      sourceIntegrationId: "int-shop-a",
      topic: "orders/create",
      shopDomain: SHOP_A,
      catalogMap: new Map(),
      payload: {
        id: 57,
        shipping_address: {},
        billing_address: {},
        customer: { first_name: "Ada", last_name: "Lovelace", phone: "123", email: "ada@x.test" },
        line_items: [],
      },
    });
    assert.equal(fromCustomer.raw_data.full_name, "Ada Lovelace");
    assert.equal(fromCustomer.raw_data.phone, "123");
  });

  it("uses numeric Shopify ids, not GraphQL GIDs, as cart identity", async () => {
    const normalized = await normalizeShopifyOrder({
      companyId: ENAYA_ID,
      sourceIntegrationId: "int-shop-a",
      topic: "orders/create",
      shopDomain: SHOP_A,
      catalogMap: new Map([["632910392", PRODUCT_A_ID]]),
      payload: sampleOrder({
        line_items: [
          {
            product_id: "gid://shopify/Product/632910392",
            variant_id: "gid://shopify/ProductVariant/39072856",
            sku: "SERUM-30",
            title: "Serum",
            quantity: 1,
            price: "10.00",
            admin_graphql_api_id: "gid://shopify/LineItem/9",
          },
        ],
      }),
    });
    assert.equal(numericShopifyId("gid://shopify/Product/632910392"), "632910392");
    assert.equal(normalized.raw_data.cart_items[0].product_id, "632910392");
    assert.equal(normalized.raw_data.cart_items[0].variant_id, "39072856");
    assert.equal(normalized.raw_data.cart_items[0].catalogProductId, PRODUCT_A_ID);
    assert.equal(
      normalized.raw_data.cart_items[0].shopify.admin_graphql_api_id,
      "gid://shopify/LineItem/9",
    );
  });
});

describe("Shopify webhook order persistence", () => {
  it("creates a normalized Shopify order with source identity and ignores payload tenant fields", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const payload = sampleOrder({
      company_id: OTHER_ID,
      companyId: OTHER_ID,
      source_integration_id: "should-not-win",
      sourceIntegrationId: "should-not-win",
    });
    const created = await signedShopifyWebhook(store.webhookUrl, {
      json: payload,
      webhookId: "wh-1",
    });
    assert.equal(created.status, 200, created.json?.message);
    assert.equal(created.json.code, "SHOPIFY_WEBHOOK_ACCEPTED");
    const row = fake.__db.orders[0];
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(row.company_id, ENAYA_ID);
    assert.equal(row.source_integration_id, store.id);
    assert.equal(row.order_id, "820982911946154508");
    assert.match(String(row.id), /^[0-9a-f-]{36}$/i);
    assert.equal(row.ingestion_source, "shopify");
    assert.equal(row.status, "new");
    assert.equal(row.raw_data.full_name, "Noura Al Saud");
    assert.equal(row.raw_data.phone, "+966501234567");
    assert.equal(row.raw_data.email, "guest@example.com");
    assert.equal(row.raw_data.city, "Riyadh");
    assert.equal(row.raw_data.address.includes("King Fahd Rd"), true);
    assert.equal(row.raw_data.total_cost, "403.00");
    assert.equal(row.raw_data.cost, "393.00");
    assert.equal(row.raw_data.shipping_cost, "15.00");
    assert.equal(row.raw_data.currency, "SAR");
    assert.equal(row.raw_data.cart_items[0].product_id, "632910392");
    assert.equal(row.raw_data.cart_items[0].variant_id, "39072856");
    assert.equal(row.raw_data.cart_items[0].sku, "SERUM-30");
    assert.equal(row.raw_data.cart_items[0].quantity, 2);
    assert.equal(row.raw_data.provider, "shopify");
    assert.equal(row.raw_data.platform, "shopify");
    assert.equal(row.raw_data.shopify.order_number, "1001");
    assert.equal(row.raw_data.shopify.name, "#1001");
    assert.equal(row.raw_data.shopify.financial_status, "paid");
    assert.equal(row.raw_data.shopify.fulfillment_status, "fulfilled");
    assert.equal(row.raw_data.shopify.tags, "vip, wholesale");
    assert.equal(row.raw_data.shopify.note, "Leave at door");
    assert.equal(row.order_reference >= 1001, true);

    const largeRaw = Buffer.from(
      `{"id":820982911946154508,"email":"large@test.com","updated_at":"2026-09-18T18:00:00-04:00","line_items":[]}`,
    );
    const large = await signedShopifyWebhook(store.webhookUrl, { raw: largeRaw });
    assert.equal(large.status, 200, large.json?.message);
    assert.equal(fake.__db.orders[0].order_id, "820982911946154508");
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(JSON.stringify(row).includes("should-not-win"), false);
    assert.equal(JSON.stringify(created.json).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(created.json).includes(WEBHOOK_SECRET), false);
    assert.equal(JSON.stringify(created.json).includes("selectedSystem"), false);
  });

  it("replays the same webhook onto one local UUID and preserves order_reference", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const first = await signedShopifyWebhook(store.webhookUrl, {
      json: sampleOrder({ email: "one@test.com" }),
    });
    const localId = first.json.data.id;
    const reference = fake.__db.orders[0].order_reference;
    const replay = await signedShopifyWebhook(store.webhookUrl, {
      json: sampleOrder({
        email: "two@test.com",
        updated_at: "2026-09-18T11:00:00-04:00",
      }),
    });
    assert.equal(replay.status, 200);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(replay.json.data.id, localId);
    assert.equal(fake.__db.orders[0].order_reference, reference);
    assert.equal(fake.__db.orders[0].raw_data.email, "two@test.com");
  });

  it("isolates the same Shopify order id across stores and companies", async () => {
    const token = await loginPlatform();
    const storeA = await createShopifyStore(token, { name: "Store A", shopDomain: SHOP_A });
    const storeB = await createShopifyStore(token, {
      name: "Store B",
      shopDomain: SHOP_B,
    });
    const otherStore = await createShopifyStore(token, {
      companyId: OTHER_ID,
      name: "Other Shopify",
      shopDomain: "other-co.myshopify.com",
    });
    const payload = sampleOrder({ id: 1001 });
    const a = await signedShopifyWebhook(storeA.webhookUrl, {
      json: payload,
      shop: SHOP_A,
    });
    const b = await signedShopifyWebhook(storeB.webhookUrl, {
      json: payload,
      shop: SHOP_B,
    });
    const other = await signedShopifyWebhook(otherStore.webhookUrl, {
      json: payload,
      shop: "other-co.myshopify.com",
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(other.status, 200);
    assert.notEqual(a.json.data.id, b.json.data.id);
    assert.notEqual(a.json.data.id, other.json.data.id);
    const rows = fake.__db.orders.filter((row) => row.order_id === "1001");
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.company_id === ENAYA_ID).length, 2);
    assert.equal(rows.filter((row) => row.company_id === OTHER_ID).length, 1);
  });

  it("links catalogProductId only for the same source and still ingests without a local product", async () => {
    const token = await loginPlatform();
    const storeA = await createShopifyStore(token, { name: "Store A", shopDomain: SHOP_A });
    const storeB = await createShopifyStore(token, {
      name: "Store B",
      shopDomain: SHOP_B,
    });
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
    const created = await signedShopifyWebhook(storeA.webhookUrl, {
      json: sampleOrder(),
      shop: SHOP_A,
    });
    assert.equal(created.status, 200);
    const line = fake.__db.orders[0].raw_data.cart_items[0];
    assert.equal(line.catalogProductId, PRODUCT_A_ID);
    assert.notEqual(line.catalogProductId, PRODUCT_B_ID);
    const catalog = await runWithTenantContext(
      { companyId: ENAYA_ID },
      () => resolveLineCatalogProduct(line, storeA.id),
    );
    assert.equal(catalog.id, PRODUCT_A_ID);

    const missing = await signedShopifyWebhook(storeB.webhookUrl, {
      json: sampleOrder({
        id: 9001,
        line_items: [{ product_id: 111, variant_id: 222, title: "Unknown", quantity: 1, price: "1.00" }],
      }),
      shop: SHOP_B,
    });
    assert.equal(missing.status, 200);
    const missingLine = fake.__db.orders.find((row) => row.order_id === "9001")
      .raw_data.cart_items[0];
    assert.equal(missingLine.catalogProductId, undefined);
    assert.equal(missingLine.product_id, "111");
  });

  it("does not map paid/fulfilled to Confirmed/Shipped and preserves operator status except cancel", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const created = await signedShopifyWebhook(store.webhookUrl, {
      json: sampleOrder({ financial_status: "paid", fulfillment_status: "fulfilled" }),
    });
    const localId = created.json.data.id;
    assert.equal(fake.__db.orders[0].status, "new");

    const confirmed = await request("PATCH", `/api/orders/${localId}/status`, {
      token: enayaToken(),
      body: { status: "Confirmed" },
    });
    assert.equal(confirmed.status, 200);
    await signedShopifyWebhook(store.webhookUrl, {
      topic: "orders/updated",
      json: sampleOrder({
        financial_status: "paid",
        fulfillment_status: "fulfilled",
        email: "updated@test.com",
        updated_at: "2026-09-18T12:00:00-04:00",
      }),
    });
    assert.equal(fake.__db.orders[0].status, "Confirmed");
    assert.equal(fake.__db.orders[0].raw_data.email, "updated@test.com");

    await request("PATCH", `/api/orders/${localId}/status`, {
      token: enayaToken(),
      body: { status: "Shipped" },
    });
    await signedShopifyWebhook(store.webhookUrl, {
      topic: "orders/updated",
      json: sampleOrder({
        fulfillment_status: "fulfilled",
        updated_at: "2026-09-18T13:00:00-04:00",
      }),
    });
    assert.equal(fake.__db.orders[0].status, "Shipped");

    const cancelled = await signedShopifyWebhook(store.webhookUrl, {
      topic: "orders/cancelled",
      json: sampleOrder({
        cancelled_at: "2026-09-18T14:00:00-04:00",
        cancel_reason: "customer",
        updated_at: "2026-09-18T14:00:00-04:00",
      }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].status, "canceled");
    assert.equal(fake.__db.orders[0].raw_data.shopify.cancel_reason, "customer");
  });

  it("partial updates and older webhooks do not erase useful customer/cart data", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    await signedShopifyWebhook(store.webhookUrl, { json: sampleOrder() });
    const partial = await signedShopifyWebhook(store.webhookUrl, {
      topic: "orders/updated",
      json: {
        id: "820982911946154508",
        updated_at: "2026-09-18T16:00:00-04:00",
        financial_status: "partially_refunded",
      },
    });
    assert.equal(partial.status, 200);
    const row = fake.__db.orders[0];
    assert.equal(row.raw_data.full_name, "Noura Al Saud");
    assert.equal(row.raw_data.cart_items[0].sku, "SERUM-30");
    assert.equal(row.raw_data.shopify.financial_status, "partially_refunded");

    const older = await signedShopifyWebhook(store.webhookUrl, {
      topic: "orders/updated",
      json: sampleOrder({
        email: "stale@test.com",
        full_name: "Stale Name",
        updated_at: "2026-09-18T09:00:00-04:00",
        financial_status: "pending",
      }),
    });
    assert.equal(older.status, 200);
    assert.equal(fake.__db.orders[0].raw_data.email, "guest@example.com");
    assert.equal(fake.__db.orders[0].raw_data.shopify.financial_status, "partially_refunded");
  });

  it("rejects invalid HMAC and unsupported topics without writing", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const invalid = await signedShopifyWebhook(store.webhookUrl, {
      secret: "wrong",
      json: sampleOrder({ id: 1 }),
    });
    assert.equal(invalid.status, 401);
    assert.equal(fake.__db.orders.length, 0);

    const ignored = await signedShopifyWebhook(store.webhookUrl, {
      topic: "products/create",
      json: sampleOrder({ id: 2 }),
    });
    assert.equal(ignored.status, 200);
    assert.equal(ignored.json.code, "SHOPIFY_TOPIC_IGNORED");
    assert.equal(fake.__db.orders.length, 0);
  });

  it("lists Shopify orders, details by UUID, and source-filters Store A/B", async () => {
    const token = await loginPlatform();
    const storeA = await createShopifyStore(token, { name: "Store A", shopDomain: SHOP_A });
    const storeB = await createShopifyStore(token, { name: "Store B", shopDomain: SHOP_B });
    const a = await signedShopifyWebhook(storeA.webhookUrl, {
      json: sampleOrder({ id: 11, email: "a@test.com" }),
      shop: SHOP_A,
    });
    const b = await signedShopifyWebhook(storeB.webhookUrl, {
      json: sampleOrder({ id: 22, email: "b@test.com" }),
      shop: SHOP_B,
    });
    const list = await request("GET", `/api/orders?${RANGE}`, { token: enayaToken() });
    assert.equal(list.status, 200);
    const ids = (list.json.data || []).map((row) => row.id);
    assert.equal(ids.includes(a.json.data.id), true);
    assert.equal(ids.includes(b.json.data.id), true);

    const details = await request("GET", `/api/orders/${a.json.data.id}`, {
      token: enayaToken(),
    });
    assert.equal(details.status, 200);
    assert.equal(details.json.data.id, a.json.data.id);
    assert.equal(details.json.data.customer.fullName, "Noura Al Saud");
    assert.equal(details.json.data.customer.phone, "+966501234567");
    assert.equal(String(details.json.data.totals.total), "403.00");
    assert.equal(details.json.data.source_integration_id, storeA.id);

    const onlyA = await request(
      "GET",
      `/api/orders?${RANGE}&source_integration_id=${storeA.id}`,
      { token: enayaToken() },
    );
    assert.equal(onlyA.status, 200);
    assert.equal(onlyA.json.data.length, 1);
    assert.equal(onlyA.json.data[0].id, a.json.data.id);

    const statsA = await request(
      "GET",
      `/api/orders/stats?${RANGE}&source_integration_id=${storeA.id}`,
      { token: enayaToken() },
    );
    assert.equal(statsA.status, 200);
    assert.equal(statsA.json.stats.totalOrders, 1);
  });

  it("rejects EasyConfirm for Shopify orders", async () => {
    const token = await loginPlatform();
    const store = await createShopifyStore(token);
    const created = await signedShopifyWebhook(store.webhookUrl, {
      json: sampleOrder({ id: 77 }),
    });
    const refresh = await request(
      "POST",
      `/api/orders/${created.json.data.id}/refresh-customer-status`,
      { token: enayaToken() },
    );
    assert.equal(refresh.status, 409);
    assert.equal(refresh.json.code, "EASYCONFIRM_NOT_EASYORDERS");
  });

  it("keeps EasyOrders, Salla, and Bosta webhooks working", async () => {
    const token = await loginPlatform();
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
      id: "ord-bosta-shopify-reg",
      company_id: ENAYA_ID,
      order_id: "ALIAS-SHOPIFY-REG",
      status: "Shipped",
      shipping_integration_id: bosta.id,
      created_at: new Date().toISOString(),
      raw_data: { bosta_order_alias: "ALIAS-SHOPIFY-REG", full_name: "Ship me" },
    });
    const eoHook = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(easy.webhookUrl)}/order-created`,
      { body: { id: "eo-shopify-reg", full_name: "EO customer" } },
    );
    const sallaHook = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(salla.webhookUrl)}/orders`,
      { body: { id: "salla-shopify-reg", full_name: "Salla customer" } },
    );
    const bostaHook = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-SHOPIFY-REG", status: "Delivered" } },
    );
    assert.equal(eoHook.status, 200);
    assert.equal(sallaHook.status, 401);
    assert.match(String(sallaHook.json.code || ""), /^SALLA_WEBHOOK_/);
    assert.equal(bostaHook.status, 200);
    assert.equal(
      fake.__db.orders.some((row) => row.order_id === "eo-shopify-reg"),
      true,
    );
    assert.equal(
      fake.__db.orders.some((row) => row.order_id === "salla-shopify-reg"),
      false,
    );
  });
});
