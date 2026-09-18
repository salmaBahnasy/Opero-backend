process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
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
const {
  buildCacheKey,
  withCache,
  clearDashboardCache,
} = require("../src/services/dashboardCache.service");
const { runWithCompanyId } = require("../src/utils/tenantScope");
const tenantSupabase = require("../src/config/tenantSupabase");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHARED_ORDER_ID = "shared-external-order";
const SHARED_REF = 1001;
const SHARED_EASYORDER_ID = "shared-easyorder-product";
const DEV_PASSWORD = "DevPassword123!";
const NOW = new Date().toISOString();

let passwordHash;
let server;
let baseUrl;
let fake;

function tokenFor(companyId, employeeId, email) {
  return signEmployeeToken({
    employeeId,
    companyId,
    role: "company_admin",
    email,
  });
}

const enayaToken = () =>
  tokenFor(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
const otherToken = () =>
  tokenFor(OTHER_ID, OTHER_ADMIN_ID, "admin@other.local");

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

function seedClient() {
  return createFakeSupabase({
    companies: [
      { id: ENAYA_ID, name: "Enaya", slug: "enaya", is_active: true },
      { id: OTHER_ID, name: "Other Co", slug: "other", is_active: true },
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
    orders: [
      {
        id: "ord-enaya-uuid",
        company_id: ENAYA_ID,
        order_id: SHARED_ORDER_ID,
        order_reference: SHARED_REF,
        status: "new",
        created_at: NOW,
        raw_data: {
          is_manual: true,
          isManual: true,
          customer_status: "confirmed",
          full_name: "Enaya Customer",
        },
      },
      {
        id: "ord-other-uuid",
        company_id: OTHER_ID,
        order_id: SHARED_ORDER_ID,
        order_reference: SHARED_REF,
        status: "Confirmed",
        created_at: NOW,
        raw_data: {
          is_manual: true,
          isManual: true,
          customer_status: "confirmed",
          full_name: "Other Customer",
        },
      },
    ],
    products: [
      {
        id: "prod-enaya",
        company_id: ENAYA_ID,
        easyorder_id: SHARED_EASYORDER_ID,
        name: "Enaya Product",
        sku: "ENA-1",
        synced_at: NOW,
      },
      {
        id: "prod-other",
        company_id: OTHER_ID,
        easyorder_id: SHARED_EASYORDER_ID,
        name: "Other Product",
        sku: "OTH-1",
        synced_at: NOW,
      },
    ],
    added_orders: [
      {
        id: "add-enaya",
        company_id: ENAYA_ID,
        customer_name: "Enaya added",
        phone: "01000000001",
        products: [{ name: "X", quantity: 1, cost: 10 }],
        total_cost: 10,
        added_by_employee_id: ENAYA_ADMIN_ID,
        created_at: NOW,
      },
      {
        id: "add-other",
        company_id: OTHER_ID,
        customer_name: "Other added",
        phone: "01000000002",
        products: [{ name: "Y", quantity: 1, cost: 20 }],
        total_cost: 20,
        added_by_employee_id: OTHER_ADMIN_ID,
        created_at: NOW,
      },
    ],
    order_status_logs: [
      {
        id: "log-enaya",
        company_id: ENAYA_ID,
        order_id: SHARED_ORDER_ID,
        order_uuid: "ord-enaya-uuid",
        old_status: "new",
        new_status: "new",
        changed_by: ENAYA_ADMIN_ID,
        changed_at: NOW,
      },
      {
        id: "log-other",
        company_id: OTHER_ID,
        order_id: SHARED_ORDER_ID,
        order_uuid: "ord-other-uuid",
        old_status: "new",
        new_status: "Confirmed",
        changed_by: OTHER_ADMIN_ID,
        changed_at: NOW,
      },
    ],
    order_cost_daily: [
      {
        id: "cost-enaya",
        company_id: ENAYA_ID,
        cost_date: "2026-09-01",
        expense: 50,
        total_orders: 1,
        shipped_orders: 0,
        successful_orders: 0,
        total_sales: 10,
        shipped_sales: 0,
        successful_sales: 0,
      },
      {
        id: "cost-other",
        company_id: OTHER_ID,
        cost_date: "2026-09-01",
        expense: 999,
        total_orders: 8,
        shipped_orders: 0,
        successful_orders: 0,
        total_sales: 80,
        shipped_sales: 0,
        successful_sales: 0,
      },
    ],
    bosta_sku_mappings: [
      {
        id: "map-enaya",
        company_id: ENAYA_ID,
        mapping_type: "product",
        entity_id: SHARED_EASYORDER_ID,
        name: "Enaya map",
        skus: ["ENA-SKU"],
      },
      {
        id: "map-other",
        company_id: OTHER_ID,
        mapping_type: "product",
        entity_id: SHARED_EASYORDER_ID,
        name: "Other map",
        skus: ["OTH-SKU"],
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
  clearDashboardCache();
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("tenant isolation", () => {
  it("A. Company A order list never returns Company B orders", async () => {
    const { status, json } = await request("GET", "/api/orders?from=2020-01-01&to=2030-12-31", {
      token: enayaToken(),
    });
    assert.equal(status, 200);
    const names = (json.data || []).map(
      (row) => row.full_name || row.customer_name || row.sourceOrderId,
    );
    assert.ok((json.data || []).length >= 1);
    assert.equal(
      (json.data || []).every((row) => row.full_name !== "Other Customer"),
      true,
    );
    assert.ok(names.includes("Enaya Customer") || json.total >= 1);
  });

  it("B. Company A cannot fetch Company B order by treating the other row as its own", async () => {
    const { status, json } = await request(
      "GET",
      `/api/orders/${SHARED_ORDER_ID}?raw=true`,
      { token: enayaToken() },
    );
    assert.equal(status, 200);
    assert.equal(json.data.full_name, "Enaya Customer");
    assert.notEqual(json.data.full_name, "Other Customer");
  });

  it("C. Company A cannot update Company B order", async () => {
    const before = fake.__db.orders.find((row) => row.id === "ord-other-uuid");
    const { status } = await request("PATCH", `/api/orders/${SHARED_ORDER_ID}/status`, {
      token: enayaToken(),
      body: { status: "canceled", company_id: OTHER_ID },
    });
    assert.ok(status === 200 || status === 404);
    const after = fake.__db.orders.find((row) => row.id === "ord-other-uuid");
    assert.equal(after.status, before.status);
    if (status === 200) {
      const enaya = fake.__db.orders.find((row) => row.id === "ord-enaya-uuid");
      assert.equal(enaya.status, "canceled");
    }
  });

  it("D. same external order_id can exist in both companies", async () => {
    const a = await request("GET", `/api/orders/${SHARED_ORDER_ID}?raw=true`, {
      token: enayaToken(),
    });
    const b = await request("GET", `/api/orders/${SHARED_ORDER_ID}?raw=true`, {
      token: otherToken(),
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.data.full_name, "Enaya Customer");
    assert.equal(b.json.data.full_name, "Other Customer");
  });

  it("E. same order_reference can exist in different companies", async () => {
    const a = await request("GET", `/api/orders/reference/${SHARED_REF}?raw=true`, {
      token: enayaToken(),
    });
    const b = await request("GET", `/api/orders/reference/${SHARED_REF}?raw=true`, {
      token: otherToken(),
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.data.full_name, "Enaya Customer");
    assert.equal(b.json.data.full_name, "Other Customer");
  });

  it("F. products with the same easyorder_id can exist in different companies", async () => {
    const a = await request("GET", "/api/products", { token: enayaToken() });
    const b = await request("GET", "/api/products", { token: otherToken() });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.data[0].easyorder_id, SHARED_EASYORDER_ID);
    assert.equal(b.json.data[0].easyorder_id, SHARED_EASYORDER_ID);
    assert.notEqual(a.json.data[0].id, b.json.data[0].id);
  });

  it("G. product lists are tenant isolated", async () => {
    const a = await request("GET", "/api/products", { token: enayaToken() });
    const b = await request("GET", "/api/products", { token: otherToken() });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aIds = (a.json.data || []).map((row) => row.easyorder_id);
    const bIds = (b.json.data || []).map((row) => row.easyorder_id);
    assert.deepEqual(aIds, [SHARED_EASYORDER_ID]);
    assert.deepEqual(bIds, [SHARED_EASYORDER_ID]);
    assert.equal(a.json.data[0].name, "Enaya Product");
    assert.equal(b.json.data[0].name, "Other Product");
  });

  it("H. Company A cannot modify Company B product", async () => {
    await runWithCompanyId(ENAYA_ID, async () => {
      await tenantSupabase
        .from("products")
        .update({ name: "Hacked", company_id: OTHER_ID })
        .eq("easyorder_id", SHARED_EASYORDER_ID);
    });

    const other = fake.__db.products.find((row) => row.id === "prod-other");
    const enaya = fake.__db.products.find((row) => row.id === "prod-enaya");
    assert.equal(other.name, "Other Product");
    assert.equal(enaya.name, "Hacked");
    assert.equal(enaya.company_id, ENAYA_ID);
  });

  it("I. added orders are tenant isolated", async () => {
    const a = await request("GET", "/api/added-orders", { token: enayaToken() });
    assert.equal(a.status, 200);
    const names = (a.json.data || []).map((row) => row.customerName);
    assert.deepEqual(names, ["Enaya added"]);

    const created = await request("POST", "/api/added-orders", {
      token: enayaToken(),
      body: {
        company_id: OTHER_ID,
        companyId: OTHER_ID,
        customerName: "Created in Enaya",
        phone: "01111111111",
        products: [{ name: "Z", quantity: 1, cost: 5 }],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(
      fake.__db.added_orders.every(
        (row) => row.customer_name !== "Created in Enaya" || row.company_id === ENAYA_ID,
      ),
      true,
    );
  });

  it("J. order status logs are tenant isolated", async () => {
    await request("PATCH", `/api/orders/${SHARED_ORDER_ID}/status`, {
      token: enayaToken(),
      body: { status: "follow up" },
    });
    const otherLogs = fake.__db.order_status_logs.filter(
      (row) => row.company_id === OTHER_ID,
    );
    const enayaLogs = fake.__db.order_status_logs.filter(
      (row) => row.company_id === ENAYA_ID,
    );
    assert.equal(otherLogs.every((row) => row.new_status !== "follow up"), true);
    assert.ok(enayaLogs.length >= 1);
    assert.equal(
      enayaLogs.every((row) => row.company_id === ENAYA_ID),
      true,
    );
  });

  it("K. daily cost/statistics data is tenant isolated", async () => {
    const saved = await request("POST", "/api/orders/charts/order-cost", {
      token: enayaToken(),
      body: { date: "2026-09-18", expense: 12, company_id: OTHER_ID },
    });
    assert.ok(saved.status === 200 || saved.status === 201);
    const otherRow = fake.__db.order_cost_daily.find(
      (row) => row.company_id === OTHER_ID && row.cost_date === "2026-09-01",
    );
    assert.equal(Number(otherRow.expense), 999);
    assert.equal(
      fake.__db.order_cost_daily.some(
        (row) => row.company_id === OTHER_ID && Number(row.expense) === 12,
      ),
      false,
    );
  });

  it("L. Bosta SKU mappings/unmapped products are tenant isolated", async () => {
    const a = await request("GET", "/api/bosta/sku-mappings", {
      token: enayaToken(),
    });
    assert.equal(a.status, 200);
    assert.equal(a.json.data.productSkuMap[SHARED_EASYORDER_ID].name, "Enaya map");
    assert.equal(a.json.data.productSkuMap[SHARED_EASYORDER_ID].skus[0], "ENA-SKU");

    const b = await request("GET", "/api/bosta/sku-mappings", {
      token: otherToken(),
    });
    assert.equal(b.status, 200);
    assert.equal(b.json.data.productSkuMap[SHARED_EASYORDER_ID].name, "Other map");
  });

  it("M. dashboard/statistics cache cannot leak between companies", async () => {
    const keyA = buildCacheKey("orders-stats", { companyId: ENAYA_ID, x: 1 });
    const keyB = buildCacheKey("orders-stats", { companyId: OTHER_ID, x: 1 });
    assert.notEqual(keyA, keyB);

    let calls = 0;
    await withCache("orders-stats", { companyId: ENAYA_ID, x: 1 }, async () => {
      calls += 1;
      return { tenant: "A" };
    });
    const b = await withCache(
      "orders-stats",
      { companyId: OTHER_ID, x: 1 },
      async () => {
        calls += 1;
        return { tenant: "B" };
      },
    );
    assert.equal(b.value.tenant, "B");
    assert.equal(calls, 2);

    assert.throws(() => buildCacheKey("orders-stats", { x: 1 }));
  });

  it("N. company_id/companyId supplied in request body/query cannot override JWT companyId", async () => {
    const created = await request("POST", "/api/orders", {
      token: enayaToken(),
      body: {
        company_id: OTHER_ID,
        companyId: OTHER_ID,
        id: "manual-enaya-1",
        full_name: "Body Override Attempt",
        phone: "01012345678",
        is_manual: true,
      },
    });
    assert.equal(created.status, 201);
    const inserted = fake.__db.orders.find(
      (row) => row.order_id === "manual-enaya-1" || row.raw_data?.full_name === "Body Override Attempt",
    );
    assert.ok(inserted);
    assert.equal(inserted.company_id, ENAYA_ID);
  });

  it("O. legacy /api/easyorder aliases cannot bypass tenant isolation", async () => {
    const openList = await request(
      "GET",
      "/api/easyorder/orders?from=2020-01-01&to=2030-12-31",
    );
    const openProducts = await request("GET", "/api/easyorder/products");
    const openStats = await request("GET", "/api/easyorder/stats");
    assert.equal(openList.status, 401);
    assert.equal(openProducts.status, 401);
    assert.equal(openStats.status, 401);

    const list = await request(
      "GET",
      "/api/easyorder/orders?from=2020-01-01&to=2030-12-31",
      { token: enayaToken() },
    );
    assert.equal(list.status, 200);
    assert.equal(
      (list.json.data || []).every((row) => row.full_name !== "Other Customer"),
      true,
    );

    const products = await request("GET", "/api/easyorder/products", {
      token: enayaToken(),
    });
    assert.equal(products.status, 200);
    assert.equal(products.json.data[0].name, "Enaya Product");
    assert.equal(
      (products.json.data || []).every((row) => row.name !== "Other Product"),
      true,
    );
  });
});
