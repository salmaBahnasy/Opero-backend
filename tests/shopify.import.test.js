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
const { signEmployeeToken } = require("../src/config/jwt");
const { runWithTenantContext } = require("../src/utils/tenantScope");
const { resolveLineCatalogProduct } = require("../src/services/bostaShipping.service");
const {
  persistShopifyOrder,
  normalizeShopifyOrder,
} = require("../src/services/shopifyOrders.service");
const {
  graphqlOrderToWebhookPayload,
  MAX_ORDER_PAGES,
  MAX_LINE_PAGES,
  MAX_RANGE_DAYS,
} = require("../src/services/shopifyOrderImport.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRODUCT_A_ID = "c1111111-aaaa-4111-8111-111111111111";
const PRODUCT_B_ID = "c2222222-bbbb-4222-8222-222222222222";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "shopify-hmac-secret-value";
const ACCESS_TOKEN = "shpat-import-test-token";
const SHOP_A = "enaya-eg.myshopify.com";
const SHOP_B = "enaya-sa.myshopify.com";
const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-08-31T23:59:59.999Z";
const RANGE = "from=2020-01-01&to=2030-12-31";

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
  { companyId = ENAYA_ID, name = "Shopify Egypt", shopDomain = SHOP_A } = {},
) {
  return createConnection(token, companyId, {
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

function money(amount, currency = "SAR") {
  return { shopMoney: { amount, currencyCode: currency } };
}

function graphqlLine({
  id = 487946274,
  productId = 632910392,
  variantId = 39072856,
  sku = "SERUM-30",
  title = "Serum 30ml",
  quantity = 2,
} = {}) {
  return {
    id: `gid://shopify/LineItem/${id}`,
    sku,
    name: `${title} - Default`,
    title,
    variantTitle: "Default",
    quantity,
    originalUnitPriceSet: money("199.00"),
    discountedUnitPriceSet: money("199.00"),
    totalDiscountSet: money("5.00"),
    product: {
      id: `gid://shopify/Product/${productId}`,
      legacyResourceId: String(productId),
    },
    variant: {
      id: `gid://shopify/ProductVariant/${variantId}`,
      legacyResourceId: String(variantId),
      sku,
      title: "Default",
    },
  };
}

function graphqlOrder({
  id = "820982911946154508",
  name = "#1001",
  cancelled = false,
  financial = "PAID",
  fulfillment = "FULFILLED",
  lines = [graphqlLine()],
  hasMoreLines = false,
  updatedAt = "2026-08-18T10:05:00Z",
} = {}) {
  return {
    id: `gid://shopify/Order/${id}`,
    legacyResourceId: String(id),
    name,
    createdAt: "2026-08-18T10:00:00Z",
    updatedAt,
    processedAt: "2026-08-18T10:00:00Z",
    cancelledAt: cancelled ? "2026-08-18T12:00:00Z" : null,
    cancelReason: cancelled ? "CUSTOMER" : null,
    email: "guest@example.com",
    phone: null,
    note: "Leave at door",
    tags: ["vip", "wholesale"],
    displayFinancialStatus: financial,
    displayFulfillmentStatus: fulfillment,
    currencyCode: "SAR",
    paymentGatewayNames: ["cod"],
    currentSubtotalPriceSet: money("393.00"),
    currentTotalDiscountsSet: money("5.00"),
    currentTotalPriceSet: money("403.00"),
    currentTotalTaxSet: money("0.00"),
    totalShippingPriceSet: money("15.00"),
    customer: {
      id: "gid://shopify/Customer/115310627",
      legacyResourceId: "115310627",
      firstName: "Noura",
      lastName: "Customer",
      email: "noura@example.com",
      phone: "+966500000000",
    },
    shippingAddress: {
      name: "Noura Al Saud",
      firstName: "Noura",
      lastName: "Al Saud",
      phone: "+966501234567",
      address1: "King Fahd Rd",
      address2: "Apt 8",
      city: "Riyadh",
      province: "Riyadh Region",
      provinceCode: "SA-01",
      country: "Saudi Arabia",
      countryCodeV2: "SA",
      zip: "12271",
    },
    billingAddress: {
      name: "Billing Name",
      phone: "+966509999999",
      address1: "Billing St",
      city: "Jeddah",
      province: "Makkah",
      country: "Saudi Arabia",
      countryCodeV2: "SA",
      zip: "21577",
    },
    lineItems: {
      pageInfo: { hasNextPage: hasMoreLines, endCursor: hasMoreLines ? "line-1" : null },
      nodes: lines,
    },
  };
}

function ordersConnection(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return {
    status: 200,
    headers: {},
    data: {
      data: {
        orders: {
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  };
}

function queryName(body) {
  const text = String(body?.query || "");
  if (text.includes("ShopifyOrderLineItems")) return "lines";
  return "orders";
}

async function importOrders(store, body = {}, token = enayaToken()) {
  return request("POST", "/api/orders/import", {
    token,
    body: {
      integrationId: store.id,
      from: FROM,
      to: TO,
      ...body,
    },
  });
}

async function signedShopifyWebhook(webhookUrl, json, { topic, shop } = {}) {
  const rawBody = Buffer.from(JSON.stringify(json));
  return request("POST", `/webhooks/shopify/${tokenFromWebhookUrl(webhookUrl)}/orders`, {
    raw: rawBody,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-SHA256": hmacFor(rawBody, WEBHOOK_SECRET),
      "X-Shopify-Shop-Domain": shop || SHOP_A,
      "X-Shopify-Topic": topic || "orders/create",
    },
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
  supabase.__setClientForTests(fake);
  capturedHttp = [];
  axios.post = async (url, body, config = {}) => {
    capturedHttp.push({ url, body, headers: config.headers || {} });
    const handler = axios.post.__impl;
    if (typeof handler === "function") return handler(url, body, config);
    return ordersConnection([graphqlOrder()]);
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

describe("Shopify historical order import", () => {
  it("imports a bounded range through the A3 normalizer", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    fake.__db.products.push({
      id: PRODUCT_A_ID,
      company_id: ENAYA_ID,
      source_integration_id: store.id,
      easyorder_id: "632910392",
      name: "Serum",
    });
    const imported = await importOrders(store, { company_id: OTHER_ID });
    assert.equal(imported.status, 200);
    assert.equal(imported.json.data.provider, "shopify");
    assert.equal(imported.json.data.integrationId, store.id);
    assert.equal(imported.json.data.created, 1);
    assert.equal(imported.json.data.hasMore, false);
    const row = fake.__db.orders[0];
    assert.equal(row.order_id, "820982911946154508");
    assert.equal(row.source_integration_id, store.id);
    assert.equal(row.company_id, ENAYA_ID);
    assert.equal(row.status, "new");
    assert.equal(row.raw_data.full_name, "Noura Al Saud");
    assert.equal(row.raw_data.phone, "+966501234567");
    assert.equal(row.raw_data.currency, "SAR");
    assert.equal(row.raw_data.total, "403.00");
    assert.equal(row.raw_data.cart_items[0].product_id, "632910392");
    assert.equal(row.raw_data.cart_items[0].variant_id, "39072856");
    assert.equal(row.raw_data.cart_items[0].catalogProductId, PRODUCT_A_ID);
    assert.equal(row.raw_data.shopify.ingested_via, "historical_import");
    assert.equal(row.raw_data.shopify.admin_graphql_api_id.includes("gid://"), true);
    assert.equal(JSON.stringify(imported.json).includes(ACCESS_TOKEN), false);
    assert.match(capturedHttp[0].body.variables.query, /created_at:>=/);
    const catalog = await runWithTenantContext({ companyId: ENAYA_ID }, () =>
      resolveLineCatalogProduct(row.raw_data.cart_items[0], store.id),
    );
    assert.equal(catalog.id, PRODUCT_A_ID);
    assert.equal(fake.__db.orders.some((item) => item.raw_data?.sent_to_bosta), false);
  });

  it("requires integrationId and rejects cross-company, non-Shopify, disabled, and bad ranges", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    const other = await createShopifyStore(platform, {
      companyId: OTHER_ID,
      name: "Other Shopify",
      shopDomain: "other-co.myshopify.com",
    });
    const easy = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-key" },
    });

    const missing = await request("POST", "/api/orders/import", {
      token: enayaToken(),
      body: { from: FROM, to: TO },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "SHOPIFY_IMPORT_INTEGRATION_REQUIRED");

    const cross = await importOrders(other);
    assert.equal(cross.status, 403);
    assert.equal(cross.json.code, "INTEGRATION_NOT_OWNED");

    const notShopify = await request("POST", "/api/orders/import", {
      token: enayaToken(),
      body: { integrationId: easy.id, from: FROM, to: TO },
    });
    assert.equal(notShopify.status, 400);
    assert.equal(notShopify.json.code, "SHOPIFY_PROVIDER_MISMATCH");

    await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}`,
      { token: platform, body: { enabled: false } },
    );
    const disabled = await importOrders(store);
    assert.equal(disabled.status, 409);
    assert.equal(disabled.json.code, "INTEGRATION_DISABLED");

    await request(
      "PATCH",
      `/api/platform/companies/${ENAYA_ID}/integrations/${store.id}`,
      { token: platform, body: { enabled: true } },
    );

    const backwards = await request("POST", "/api/orders/import", {
      token: enayaToken(),
      body: { integrationId: store.id, from: TO, to: FROM },
    });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.json.code, "SHOPIFY_IMPORT_RANGE_INVALID");

    const huge = await request("POST", "/api/orders/import", {
      token: enayaToken(),
      body: {
        integrationId: store.id,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-03-15T00:00:00.000Z",
      },
    });
    assert.equal(huge.status, 400);
    assert.equal(huge.json.code, "SHOPIFY_IMPORT_RANGE_TOO_LARGE");

    const invalid = await request("POST", "/api/orders/import", {
      token: enayaToken(),
      body: { integrationId: store.id, from: "nope", to: TO },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "SHOPIFY_IMPORT_RANGE_INVALID");
    assert.equal(MAX_RANGE_DAYS, 31);
  });

  it("paginates with a bound and resumes the same range", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    let page = 0;
    axios.post.__impl = async (_url, body) => {
      page += 1;
      return ordersConnection([graphqlOrder({ id: 1000 + page, name: `#${1000 + page}` })], {
        hasNextPage: true,
        endCursor: `cursor-${page}`,
      });
    };
    const first = await importOrders(store);
    assert.equal(first.status, 200);
    assert.equal(first.json.data.hasMore, true);
    assert.equal(first.json.data.nextCursor, `cursor-${MAX_ORDER_PAGES}`);
    assert.equal(first.json.data.pagesFetched, MAX_ORDER_PAGES);
    assert.equal(page, MAX_ORDER_PAGES);

    const resume = await importOrders(store, { cursor: first.json.data.nextCursor });
    assert.equal(resume.status, 200);
    assert.equal(
      capturedHttp.some((item) => item.body?.variables?.after === first.json.data.nextCursor),
      true,
    );
  });

  it("skips missing numeric ids and truncated line items without aborting siblings", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "lines") {
        return {
          status: 200,
          headers: {},
          data: {
            data: {
              order: {
                id: "gid://shopify/Order/77",
                lineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "more" },
                  nodes: [graphqlLine({ id: 9 })],
                },
              },
            },
          },
        };
      }
      return ordersConnection([
        graphqlOrder({ id: 11, name: "#11" }),
        {
          ...graphqlOrder({ id: "", name: "#no-id" }),
          id: "gid://shopify/Order/not-numeric",
          legacyResourceId: null,
        },
        {
          ...graphqlOrder({ id: 88, name: "#gid-only" }),
          legacyResourceId: null,
        },
        graphqlOrder({ id: 77, name: "#77", hasMoreLines: true }),
      ]);
    };
    const imported = await importOrders(store);
    assert.equal(imported.status, 200);
    assert.equal(imported.json.data.created, 1);
    assert.equal(imported.json.data.skipped >= 3, true);
    assert.equal(
      imported.json.data.errors.some((row) => row.code === "SHOPIFY_ORDER_ID_REQUIRED"),
      true,
    );
    assert.equal(
      imported.json.data.errors.some((row) => row.code === "SHOPIFY_ORDER_LINES_TRUNCATED"),
      true,
    );
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].order_id, "11");
    assert.equal(MAX_LINE_PAGES, 10);
  });

  it("converges with webhooks, preserves operator status, and isolates stores", async () => {
    const platform = await loginPlatform();
    const storeA = await createShopifyStore(platform, { name: "Shopify Egypt", shopDomain: SHOP_A });
    const storeB = await createShopifyStore(platform, {
      name: "Shopify Saudi",
      shopDomain: SHOP_B,
    });
    fake.__db.products.push(
      {
        id: PRODUCT_A_ID,
        company_id: ENAYA_ID,
        source_integration_id: storeA.id,
        easyorder_id: "632910392",
      },
      {
        id: PRODUCT_B_ID,
        company_id: ENAYA_ID,
        source_integration_id: storeB.id,
        easyorder_id: "632910392",
      },
    );

    const imported = await importOrders(storeA);
    assert.equal(imported.status, 200);
    const localId = fake.__db.orders[0].id;
    const reference = fake.__db.orders[0].order_reference;
    fake.__db.orders[0].status = "Confirmed";
    fake.__db.orders[0].raw_data.status = "Confirmed";

    const hook = await signedShopifyWebhook(storeA.webhookUrl, {
      id: "820982911946154508",
      email: "guest@example.com",
      updated_at: "2026-08-18T11:00:00Z",
      created_at: "2026-08-18T10:00:00Z",
      total_price: "403.00",
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      name: "#1001",
      shipping_address: { name: "Noura Al Saud", phone: "+966501234567", city: "Riyadh" },
      line_items: [
        { product_id: 632910392, variant_id: 39072856, quantity: 2, title: "Serum 30ml" },
      ],
    });
    assert.equal(hook.status, 200);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].id, localId);
    assert.equal(fake.__db.orders[0].status, "Confirmed");
    assert.equal(fake.__db.orders[0].order_reference, reference);

    fake.__db.orders[0].status = "Shipped";
    fake.__db.orders[0].raw_data.status = "Shipped";
    await importOrders(storeA);
    assert.equal(fake.__db.orders[0].id, localId);
    assert.equal(fake.__db.orders[0].status, "Shipped");
    assert.equal(fake.__db.orders[0].order_reference, reference);

    axios.post.__impl = async () =>
      ordersConnection([graphqlOrder({ shopDomain: SHOP_B })]);
    await importOrders(storeB);
    assert.equal(fake.__db.orders.length, 2);
    const rowB = fake.__db.orders.find((row) => row.source_integration_id === storeB.id);
    assert.equal(rowB.order_id, "820982911946154508");
    assert.equal(rowB.raw_data.cart_items[0].catalogProductId, PRODUCT_B_ID);
    assert.notEqual(rowB.id, localId);

    const listedA = await request(
      "GET",
      `/api/orders?${RANGE}&source_integration_id=${storeA.id}`,
      { token: enayaToken() },
    );
    assert.equal(listedA.status, 200);
    const ids = (listedA.json.data || []).map((row) => row.id);
    assert.equal(ids.includes(localId), true);
    assert.equal(ids.includes(rowB.id), false);

    const stats = await request(
      "GET",
      `/api/orders/stats?${RANGE}&source_integration_id=${storeA.id}`,
      { token: enayaToken() },
    );
    assert.equal(stats.status, 200);
    assert.equal(Number(stats.json.stats?.totalOrders) >= 1, true);
  });

  it("does not let older import overwrite newer webhook data, and cancel still applies", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    await signedShopifyWebhook(store.webhookUrl, {
      id: "55",
      email: "new@example.com",
      updated_at: "2026-08-20T10:00:00Z",
      created_at: "2026-08-18T10:00:00Z",
      total_price: "50.00",
      financial_status: "paid",
      name: "#55",
      shipping_address: { name: "Webhook Newer", phone: "+966511111111", city: "Riyadh" },
      line_items: [{ product_id: 1, variant_id: 2, quantity: 1, title: "A" }],
    });
    axios.post.__impl = async () =>
      ordersConnection([
        graphqlOrder({
          id: 55,
          name: "#55",
          updatedAt: "2026-08-18T09:00:00Z",
        }),
      ]);
    await importOrders(store);
    assert.equal(fake.__db.orders.length, 1);
    assert.equal(fake.__db.orders[0].raw_data.full_name, "Webhook Newer");

    axios.post.__impl = async () =>
      ordersConnection([graphqlOrder({ id: 55, name: "#55", cancelled: true })]);
    await importOrders(store);
    assert.equal(fake.__db.orders[0].status, "canceled");
  });

  it("handles duplicate insert race and provider failures without deleting prior orders", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    const payload = graphqlOrderToWebhookPayload(graphqlOrder(), [graphqlLine()]);
    const [first, second] = await Promise.all([
      runWithTenantContext({ companyId: ENAYA_ID }, () =>
        persistShopifyOrder({
          companyId: ENAYA_ID,
          sourceIntegrationId: store.id,
          topic: "orders/create",
          shopDomain: SHOP_A,
          payload,
          ingestedVia: "historical_import",
        }),
      ),
      runWithTenantContext({ companyId: ENAYA_ID }, () =>
        persistShopifyOrder({
          companyId: ENAYA_ID,
          sourceIntegrationId: store.id,
          topic: "orders/create",
          shopDomain: SHOP_A,
          payload,
          ingestedVia: "webhook",
        }),
      ),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(fake.__db.orders.length, 1);

    axios.post.__impl = async () => ({ status: 401, headers: {}, data: { errors: "Unauthorized" } });
    const revoked = await importOrders(store);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, "SHOPIFY_CREDENTIALS_INVALID");
    assert.equal(fake.__db.orders.length, 1);

    axios.post.__impl = async () => ({ status: 429, headers: { "retry-after": "0" }, data: {} });
    const limited = await importOrders(store);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, "SHOPIFY_RATE_LIMITED");
    assert.equal(fake.__db.orders.length, 1);

    axios.post.__impl = async () => ({ status: 503, headers: { "retry-after": "0" }, data: {} });
    const down = await importOrders(store);
    assert.equal(down.status, 502);
    assert.equal(down.json.code, "SHOPIFY_PROVIDER_UNAVAILABLE");
    assert.equal(fake.__db.orders.length, 1);
  });

  it("maps GraphQL through the same A3 shape as webhooks and keeps regressions", async () => {
    const webhookLike = {
      id: "820982911946154508",
      email: "guest@example.com",
      created_at: "2026-08-18T10:00:00Z",
      updated_at: "2026-08-18T10:05:00Z",
      total_price: "403.00",
      subtotal_price: "393.00",
      total_tax: "0.00",
      total_discounts: "5.00",
      currency: "SAR",
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      name: "#1001",
      note: "Leave at door",
      tags: "vip, wholesale",
      shipping_address: {
        name: "Noura Al Saud",
        phone: "+966501234567",
        address1: "King Fahd Rd",
        city: "Riyadh",
        country_code: "SA",
      },
      customer: { first_name: "Noura", last_name: "Customer", email: "noura@example.com" },
      line_items: [
        {
          product_id: "632910392",
          variant_id: "39072856",
          sku: "SERUM-30",
          title: "Serum 30ml",
          quantity: 2,
          price: "199.00",
        },
      ],
    };
    const graphqlPayload = graphqlOrderToWebhookPayload(graphqlOrder(), [graphqlLine()]);
    const [fromGraphql, fromWebhook] = await Promise.all([
      normalizeShopifyOrder({
        companyId: ENAYA_ID,
        sourceIntegrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        payload: graphqlPayload,
        catalogMap: new Map(),
      }),
      normalizeShopifyOrder({
        companyId: ENAYA_ID,
        sourceIntegrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        payload: webhookLike,
        catalogMap: new Map(),
      }),
    ]);
    assert.equal(fromGraphql.externalOrderId, fromWebhook.externalOrderId);
    assert.equal(fromGraphql.externalOrderId, "820982911946154508");
    assert.equal(String(fromGraphql.raw_data.shopify.admin_graphql_api_id).startsWith("gid://"), true);
    assert.equal(fromGraphql.status, "new");
    assert.equal(fromWebhook.status, "new");
    assert.equal(fromGraphql.raw_data.cart_items[0].product_id, "632910392");

    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    const easy = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "EO",
      credentials: { apiKey: "eo-key" },
    });
    const salla = await createConnection(platform, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Salla",
      credentials: { accessToken: "salla-token" },
    });
    const bosta = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta",
      credentials: { apiKey: "boost_aaaa" },
    });
    fake.__db.orders.push({
      id: "ord-bosta-imp",
      company_id: ENAYA_ID,
      order_id: "ALIAS-IMP",
      status: "Shipped",
      shipping_integration_id: bosta.id,
      created_at: new Date().toISOString(),
      raw_data: { bosta_order_alias: "ALIAS-IMP" },
    });
    const eoHook = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(easy.webhookUrl)}/order-created`,
      { body: { id: "eo-imp-1", full_name: "EO" } },
    );
    const sallaHook = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(salla.webhookUrl)}/orders`,
      { body: { id: "salla-imp-1", full_name: "Salla" } },
    );
    const bostaHook = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-IMP", status: "Delivered" } },
    );
    assert.equal(eoHook.status, 200);
    assert.equal(sallaHook.status, 401);
    assert.match(String(sallaHook.json.code || ""), /^SALLA_WEBHOOK_/);
    assert.equal(bostaHook.status, 200);

    const sync = await request("POST", `/api/products/sync?integrationId=${store.id}`, {
      token: enayaToken(),
    });
    assert.equal(sync.status === 200 || sync.status === 502 || sync.status === 401, true);
  });
});
