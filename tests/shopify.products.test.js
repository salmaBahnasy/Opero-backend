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
  MAX_PRODUCT_PAGES,
  MAX_VARIANT_PAGES,
} = require("../src/services/shopifyProducts.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEV_PASSWORD = "DevPassword123!";
const WEBHOOK_SECRET = "shopify-hmac-secret-value";
const ACCESS_TOKEN = "shpat-products-test-token";
const SHOP_A = "enaya-eg.myshopify.com";
const SHOP_B = "enaya-sa.myshopify.com";

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
  {
    companyId = ENAYA_ID,
    name = "Shopify Egypt",
    shopDomain = SHOP_A,
  } = {},
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

function variantNode({ id, title = "Default Title", sku, price = "10.00" }) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    legacyResourceId: String(id),
    title,
    sku,
    price,
    inventoryQuantity: 4,
    selectedOptions: [{ name: "Size", value: title }],
    image: { url: "https://cdn.test/v.jpg" },
  };
}

function productNode({
  id,
  title = "Serum",
  status = "ACTIVE",
  variants = [variantNode({ id: `${id}1`, sku: "SERUM-S", title: "S" })],
  hasMoreVariants = false,
}) {
  return {
    id: `gid://shopify/Product/${id}`,
    legacyResourceId: String(id),
    title,
    handle: String(title).toLowerCase().replace(/\s+/g, "-"),
    status,
    vendor: "Enaya",
    productType: "Care",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    featuredMedia: { preview: { image: { url: "https://cdn.test/p.jpg" } } },
    variants: {
      pageInfo: {
        hasNextPage: Boolean(hasMoreVariants),
        endCursor: hasMoreVariants ? "variant-cursor-1" : null,
      },
      nodes: variants,
    },
  };
}

function productsConnection(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return {
    status: 200,
    headers: {},
    data: {
      data: {
        products: {
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  };
}

function queryName(body) {
  const text = String(body?.query || "");
  if (text.includes("ShopifyProductVariants")) return "variants";
  if (text.includes("ShopifyProducts")) return "products";
  return "other";
}

async function syncStore(store, { token, cursor, provider, companyId } = {}) {
  const params = new URLSearchParams();
  if (store?.id) params.set("integrationId", store.id);
  if (cursor) params.set("cursor", cursor);
  if (provider) params.set("provider", provider);
  return request("POST", `/api/products/sync?${params.toString()}`, {
    token: token || enayaToken(),
    body: { company_id: companyId, companyId },
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
  capturedHttp = [];
  axios.post = async (url, body, config = {}) => {
    capturedHttp.push({
      method: "POST",
      url,
      headers: config.headers || {},
      body,
      query: queryName(body),
    });
    const handler = axios.post.__impl;
    if (typeof handler === "function") {
      return handler(url, body, config);
    }
    return productsConnection([productNode({ id: 123 })]);
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

describe("Shopify product sync", () => {
  it("syncs one page of products and variants with numeric ids and GID metadata", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    const synced = await syncStore(store);
    assert.equal(synced.status, 200, synced.json?.message);
    assert.equal(synced.json.data.provider, "shopify");
    assert.equal(synced.json.data.integrationId, store.id);
    assert.equal(synced.json.data.created, 1);
    assert.equal(synced.json.data.hasMore, false);
    assert.equal(synced.json.data.nextCursor, null);
    assert.equal(JSON.stringify(synced.json).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(synced.json).includes(WEBHOOK_SECRET), false);

    const row = fake.__db.products[0];
    assert.equal(row.company_id, ENAYA_ID);
    assert.equal(row.source_integration_id, store.id);
    assert.equal(row.easyorder_id, "123");
    assert.equal(row.name, "Serum");
    assert.equal(row.sku, "SERUM-S");
    assert.equal(row.raw_data.provider, "shopify");
    assert.equal(row.raw_data.shopify.product_id, "123");
    assert.equal(row.raw_data.shopify.gid, "gid://shopify/Product/123");
    assert.equal(row.raw_data.shopify.variants_complete, true);
    assert.equal(row.raw_data.variants.length, 1);
    assert.equal(row.raw_data.variants[0].id, "1231");
    assert.equal(row.raw_data.variants[0].product_id, "123");
    assert.equal(row.raw_data.variants[0].gid, "gid://shopify/ProductVariant/1231");
    assert.equal(row.raw_data.image, "https://cdn.test/p.jpg");
    assert.equal(fake.__db.products.length, 1);
  });

  it("paginates with a bound and returns hasMore + nextCursor", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    let productCalls = 0;
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "products") {
        productCalls += 1;
        return productsConnection([productNode({ id: productCalls })], {
          hasNextPage: true,
          endCursor: `cursor-${productCalls}`,
        });
      }
      return productsConnection([]);
    };
    const first = await syncStore(store);
    assert.equal(first.status, 200);
    assert.equal(first.json.data.hasMore, true);
    assert.equal(first.json.data.nextCursor, `cursor-${MAX_PRODUCT_PAGES}`);
    assert.equal(productCalls, MAX_PRODUCT_PAGES);
    assert.equal(first.json.data.created, MAX_PRODUCT_PAGES);

    productCalls = 0;
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "products") {
        productCalls += 1;
        assert.equal(body.variables.after, "cursor-5");
        return productsConnection([productNode({ id: 999 })], {
          hasNextPage: false,
          endCursor: null,
        });
      }
      return productsConnection([]);
    };
    const second = await syncStore(store, { cursor: "cursor-5" });
    assert.equal(second.status, 200);
    assert.equal(second.json.data.hasMore, false);
    assert.equal(productCalls, 1);
  });

  it("follows variant pagination and reports truncation instead of silent cutoff", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "products") {
        return productsConnection([
          productNode({
            id: 55,
            variants: [variantNode({ id: 1, sku: "A", title: "A" })],
            hasMoreVariants: true,
          }),
        ]);
      }
      return {
        status: 200,
        headers: {},
        data: {
          data: {
            product: {
              id: "gid://shopify/Product/55",
              variants: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [variantNode({ id: 2, sku: "B", title: "B" })],
              },
            },
          },
        },
      };
    };
    const complete = await syncStore(store);
    assert.equal(complete.status, 200);
    assert.equal(fake.__db.products[0].raw_data.variants.map((v) => v.id).join(","), "1,2");
    assert.equal(fake.__db.products[0].raw_data.shopify.variants_complete, true);

    fake.__db.products = [];
    let variantPages = 0;
    axios.post.__impl = async (_url, body) => {
      if (queryName(body) === "products") {
        return productsConnection([
          productNode({
            id: 77,
            variants: [variantNode({ id: 10, sku: "X" })],
            hasMoreVariants: true,
          }),
        ]);
      }
      variantPages += 1;
      return {
        status: 200,
        headers: {},
        data: {
          data: {
            product: {
              variants: {
                pageInfo: { hasNextPage: true, endCursor: `v-${variantPages}` },
                nodes: [variantNode({ id: 10 + variantPages, sku: `X${variantPages}` })],
              },
            },
          },
        },
      };
    };
    const truncated = await syncStore(store);
    assert.equal(truncated.status, 200);
    assert.equal(variantPages, MAX_VARIANT_PAGES);
    assert.equal(fake.__db.products[0].raw_data.shopify.variants_complete, false);
    assert.equal(
      truncated.json.data.errors.some((row) => row.code === "SHOPIFY_VARIANTS_TRUNCATED"),
      true,
    );
  });

  it("preserves local UUID on re-sync and isolates Store A/B and companies", async () => {
    const platform = await loginPlatform();
    const storeA = await createShopifyStore(platform, { name: "Store A", shopDomain: SHOP_A });
    const storeB = await createShopifyStore(platform, { name: "Store B", shopDomain: SHOP_B });
    const otherStore = await createShopifyStore(platform, {
      companyId: OTHER_ID,
      name: "Other Shopify",
      shopDomain: "other-co.myshopify.com",
    });
    axios.post.__impl = async () => productsConnection([productNode({ id: 123, title: "A first" })]);
    const first = await syncStore(storeA);
    const localId = fake.__db.products.find((row) => row.source_integration_id === storeA.id).id;
    axios.post.__impl = async () => productsConnection([productNode({ id: 123, title: "A second" })]);
    await syncStore(storeA);
    const afterA = fake.__db.products.find((row) => row.source_integration_id === storeA.id);
    assert.equal(afterA.id, localId);
    assert.equal(afterA.name, "A second");

    axios.post.__impl = async () => productsConnection([productNode({ id: 123, title: "B product" })]);
    await syncStore(storeB);
    axios.post.__impl = async () => productsConnection([productNode({ id: 123, title: "Other product" })]);
    await syncStore(otherStore, { token: otherToken() });

    const rows = fake.__db.products.filter((row) => row.easyorder_id === "123");
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.source_integration_id === storeA.id)[0].id, localId);
    assert.equal(rows.filter((row) => row.source_integration_id === storeB.id)[0].name, "B product");
    assert.equal(rows.filter((row) => row.company_id === OTHER_ID)[0].name, "Other product");

    const listedA = await request(
      "GET",
      `/api/products?source_integration_id=${storeA.id}`,
      { token: enayaToken() },
    );
    assert.equal(listedA.status, 200);
    assert.equal(listedA.json.data.length, 1);
    assert.equal(listedA.json.data[0].id, localId);
    assert.equal(listedA.json.data[0].source_integration_id, storeA.id);
  });

  it("rejects cross-company integrationId, 2+ Shopify first-pick, and revoked tokens", async () => {
    const platform = await loginPlatform();
    const storeA = await createShopifyStore(platform, { name: "Store A", shopDomain: SHOP_A });
    await createShopifyStore(platform, { name: "Store B", shopDomain: SHOP_B });
    const otherStore = await createShopifyStore(platform, {
      companyId: OTHER_ID,
      name: "Other Shopify",
      shopDomain: "other-co.myshopify.com",
    });

    const cross = await syncStore(otherStore, { token: enayaToken() });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.code, "INTEGRATION_NOT_OWNED");

    const unlabeled = await request("POST", "/api/products/sync", { token: enayaToken() });
    assert.equal(unlabeled.status, 409);
    assert.equal(unlabeled.json.code, "INTEGRATION_NOT_CONFIGURED");

    const ambiguous = await request("POST", "/api/products/sync?provider=shopify", {
      token: enayaToken(),
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.code, "INTEGRATION_AMBIGUOUS");

    axios.post.__impl = async () => ({ status: 401, headers: {}, data: { errors: "Unauthorized" } });
    const revoked = await syncStore(storeA);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, "SHOPIFY_CREDENTIALS_INVALID");
    assert.equal(fake.__db.products.length, 0);
  });

  it("retries 429, fails 5xx safely, and does not delete previous products", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    await syncStore(store);
    const existingId = fake.__db.products[0].id;
    fake.__db.products.push({
      id: "keep-me",
      company_id: ENAYA_ID,
      source_integration_id: store.id,
      easyorder_id: "999",
      name: "Previously synced",
      sku: "OLD",
      raw_data: { provider: "shopify" },
    });

    let calls = 0;
    axios.post.__impl = async () => {
      calls += 1;
      if (calls === 1) return { status: 429, headers: { "retry-after": "0" }, data: {} };
      return { status: 503, headers: { "retry-after": "0" }, data: {} };
    };
    const failed = await syncStore(store);
    assert.equal(failed.status, 502);
    assert.equal(failed.json.code, "SHOPIFY_PROVIDER_UNAVAILABLE");
    assert.equal(
      fake.__db.products.some((row) => row.id === existingId),
      true,
    );
    assert.equal(
      fake.__db.products.some((row) => row.easyorder_id === "999"),
      true,
    );
  });

  it("preserves draft/archived status and does not delete products missing from a bounded page", async () => {
    const platform = await loginPlatform();
    const store = await createShopifyStore(platform);
    fake.__db.products.push({
      id: "already-there",
      company_id: ENAYA_ID,
      source_integration_id: store.id,
      easyorder_id: "888",
      name: "Older Shopify product",
      sku: "OLD-888",
      raw_data: { provider: "shopify" },
    });
    axios.post.__impl = async () =>
      productsConnection([productNode({ id: 321, title: "Draft serum", status: "DRAFT" })]);
    const synced = await syncStore(store);
    assert.equal(synced.status, 200);
    const draft = fake.__db.products.find((row) => row.easyorder_id === "321");
    assert.equal(draft.raw_data.shopify.status, "DRAFT");
    assert.equal(draft.is_active, false);
    assert.equal(
      fake.__db.products.some((row) => row.easyorder_id === "888"),
      true,
    );
  });

  it("relinks Shopify orders in the same source only", async () => {
    const platform = await loginPlatform();
    const storeA = await createShopifyStore(platform, { name: "Store A", shopDomain: SHOP_A });
    const storeB = await createShopifyStore(platform, { name: "Store B", shopDomain: SHOP_B });
    fake.__db.orders.push(
      {
        id: "ord-shopify-a",
        company_id: ENAYA_ID,
        order_id: "1001",
        status: "new",
        source_integration_id: storeA.id,
        ingestion_source: "shopify",
        raw_data: {
          provider: "shopify",
          full_name: "Noura",
          cart_items: [{ product_id: "123", variant_id: "456", sku: "SERUM-S", quantity: 1 }],
        },
      },
      {
        id: "ord-shopify-b",
        company_id: ENAYA_ID,
        order_id: "1001",
        status: "new",
        source_integration_id: storeB.id,
        ingestion_source: "shopify",
        raw_data: {
          provider: "shopify",
          cart_items: [{ product_id: "123", variant_id: "456", sku: "SERUM-S", quantity: 1 }],
        },
      },
      {
        id: "ord-easy",
        company_id: ENAYA_ID,
        order_id: "eo-1",
        status: "new",
        source_integration_id: "eeeeeeee-1111-4111-8111-111111111111",
        ingestion_source: "easyorders",
        raw_data: {
          provider: "easyorders",
          cart_items: [{ product_id: "123", variant_id: "456", quantity: 1 }],
        },
      },
    );
    axios.post.__impl = async () =>
      productsConnection([
        productNode({
          id: 123,
          variants: [variantNode({ id: 456, sku: "SERUM-S", title: "S" })],
        }),
      ]);
    const synced = await syncStore(storeA);
    assert.equal(synced.status, 200);
    const catalogId = fake.__db.products.find((row) => row.source_integration_id === storeA.id).id;
    const orderA = fake.__db.orders.find((row) => row.id === "ord-shopify-a");
    const orderB = fake.__db.orders.find((row) => row.id === "ord-shopify-b");
    const easy = fake.__db.orders.find((row) => row.id === "ord-easy");
    assert.equal(orderA.raw_data.cart_items[0].catalogProductId, catalogId);
    assert.equal(orderA.status, "new");
    assert.equal(orderB.raw_data.cart_items[0].catalogProductId, undefined);
    assert.equal(easy.raw_data.cart_items[0].catalogProductId, undefined);

    const catalog = await runWithTenantContext({ companyId: ENAYA_ID }, () =>
      resolveLineCatalogProduct(orderA.raw_data.cart_items[0], storeA.id),
    );
    assert.equal(catalog.id, catalogId);
    assert.equal(orderA.raw_data.cart_items[0].variant_id, "456");
  });

  it("keeps EasyOrders/Salla/Bosta/Shopify webhooks and EasyOrders product sync working", async () => {
    const platform = await loginPlatform();
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
    const shopify = await createShopifyStore(platform);
    const bosta = await createConnection(platform, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Bosta",
      credentials: { apiKey: "boost_aaaa" },
    });
    fake.__db.orders.push({
      id: "ord-bosta-prod",
      company_id: ENAYA_ID,
      order_id: "ALIAS-PROD",
      status: "Shipped",
      shipping_integration_id: bosta.id,
      created_at: new Date().toISOString(),
      raw_data: { bosta_order_alias: "ALIAS-PROD" },
    });

    const originalGet = axios.get;
    axios.get = async (url, config = {}) => ({
      status: 200,
      data: [{ id: "eo-9", name: "EO Cream", sku: "EO-9" }],
      headers: {},
      config,
    });
    const eoSync = await request("POST", `/api/products/sync?integrationId=${easy.id}`, {
      token: enayaToken(),
    });
    axios.get = originalGet;
    assert.equal(eoSync.status, 200);
    assert.equal(eoSync.json.data.provider, "easyorders");

    const sallaSync = await request("POST", `/api/products/sync?integrationId=${salla.id}`, {
      token: enayaToken(),
    });
    assert.equal(sallaSync.status, 409);
    assert.equal(sallaSync.json.code, "SALLA_AUTHORIZATION_LEGACY");

    const raw = Buffer.from(JSON.stringify({ id: "7001", email: "a@b.test", line_items: [] }));
    const shopHook = await request(
      "POST",
      `/webhooks/shopify/${tokenFromWebhookUrl(shopify.webhookUrl)}/orders`,
      {
        raw,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-SHA256": hmacFor(raw, WEBHOOK_SECRET),
          "X-Shopify-Shop-Domain": SHOP_A,
          "X-Shopify-Topic": "orders/create",
        },
      },
    );
    const eoHook = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(easy.webhookUrl)}/order-created`,
      { body: { id: "eo-hook-1", full_name: "EO" } },
    );
    const sallaHook = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(salla.webhookUrl)}/orders`,
      { body: { id: "salla-hook-1", full_name: "Salla" } },
    );
    const bostaHook = await request(
      "POST",
      `/webhooks/bosta/${tokenFromWebhookUrl(bosta.webhookUrl)}/order-status`,
      { body: { orderAlias: "ALIAS-PROD", status: "Delivered" } },
    );
    assert.equal(shopHook.status, 200);
    assert.equal(eoHook.status, 200);
    assert.equal(sallaHook.status, 401);
    assert.match(String(sallaHook.json.code || ""), /^SALLA_WEBHOOK_/);
    assert.equal(bostaHook.status, 200);
  });
});
