process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENAYA_STAFF_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_STAFF_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEV_PASSWORD = "DevPassword123!";

let passwordHash;
let server;
let baseUrl;

async function request(method, path, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = await response.json();
  return { status: response.status, json };
}

function seedClient() {
  return createFakeSupabase({
    companies: [
      { id: ENAYA_ID, name: "Enaya", slug: "enaya", is_active: true, deleted_at: null },
      { id: OTHER_ID, name: "Other Co", slug: "other", is_active: true, deleted_at: null },
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
        phone: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: ENAYA_STAFF_ID,
        company_id: ENAYA_ID,
        name: "Enaya Staff",
        email: "staff@enaya.local",
        password: passwordHash,
        role: "employee",
        is_active: true,
        phone: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: OTHER_ADMIN_ID,
        company_id: OTHER_ID,
        name: "Other Admin",
        email: "admin@other.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
        phone: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: OTHER_STAFF_ID,
        company_id: OTHER_ID,
        name: "Other Staff",
        email: "staff@other.local",
        password: passwordHash,
        role: "employee",
        is_active: true,
        phone: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
}

before(async () => {
  passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  supabase.__setClientForTests(seedClient());
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("tenant-aware employee authentication", () => {
  it("A. valid Enaya login returns a token containing companyId", async () => {
    const { status, json } = await request("POST", "/api/employees/login", {
      body: {
        companySlug: "enaya",
        email: "admin@enaya.local",
        password: DEV_PASSWORD,
        companyId: OTHER_ID,
      },
    });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.ok(json.token);

    const payload = jwt.verify(json.token, process.env.JWT_SECRET);
    assert.equal(payload.companyId, ENAYA_ID);
    assert.equal(payload.employeeId, ENAYA_ADMIN_ID);
    assert.equal(payload.role, "company_admin");
    assert.equal(payload.email, "admin@enaya.local");
    assert.equal(json.data.companyId, ENAYA_ID);
  });

  it("B. wrong company slug fails", async () => {
    const { status, json } = await request("POST", "/api/employees/login", {
      body: {
        companySlug: "does-not-exist",
        email: "admin@enaya.local",
        password: DEV_PASSWORD,
      },
    });

    assert.equal(status, 401);
    assert.equal(json.success, false);
    assert.equal(json.token, undefined);
  });

  it("C. employee from Company A cannot authenticate through Company B", async () => {
    const { status, json } = await request("POST", "/api/employees/login", {
      body: {
        companySlug: "other",
        email: "admin@enaya.local",
        password: DEV_PASSWORD,
      },
    });

    assert.equal(status, 401);
    assert.equal(json.success, false);
    assert.equal(json.token, undefined);
  });

  it("D. company_admin can list employees only from their company", async () => {
    const token = signEmployeeToken({
      employeeId: ENAYA_ADMIN_ID,
      companyId: ENAYA_ID,
      role: "company_admin",
      email: "admin@enaya.local",
    });

    const { status, json } = await request("GET", "/api/employees", { token });

    assert.equal(status, 200);
    assert.equal(json.success, true);
    const ids = (json.data || []).map((row) => row.id).sort();
    assert.deepEqual(ids, [ENAYA_ADMIN_ID, ENAYA_STAFF_ID].sort());
    assert.equal(
      (json.data || []).every((row) => row.companyId === ENAYA_ID),
      true,
    );
  });

  it("E. company_admin cannot modify an employee from another company", async () => {
    const token = signEmployeeToken({
      employeeId: ENAYA_ADMIN_ID,
      companyId: ENAYA_ID,
      role: "company_admin",
      email: "admin@enaya.local",
    });

    const { status, json } = await request(
      "PATCH",
      `/api/employees/${OTHER_STAFF_ID}`,
      {
        token,
        body: { name: "Hacked" },
      },
    );

    assert.equal(status, 404);
    assert.equal(json.success, false);
  });

  it("F. normal employee cannot access employee-management operations", async () => {
    const token = signEmployeeToken({
      employeeId: ENAYA_STAFF_ID,
      companyId: ENAYA_ID,
      role: "employee",
      email: "staff@enaya.local",
    });

    const list = await request("GET", "/api/employees", { token });
    assert.equal(list.status, 403);
    assert.equal(list.json.success, false);

    const create = await request("POST", "/api/employees", {
      token,
      body: {
        name: "New Person",
        email: "new@enaya.local",
        password: "unused",
      },
    });
    assert.equal(create.status, 403);
  });

  it("create employee ignores company_id from the request body", async () => {
    const token = signEmployeeToken({
      employeeId: ENAYA_ADMIN_ID,
      companyId: ENAYA_ID,
      role: "admin",
      email: "admin@enaya.local",
    });

    const { status, json } = await request("POST", "/api/employees", {
      token,
      body: {
        name: "Injected",
        email: "injected@enaya.local",
        password: "TempPass123!",
        company_id: OTHER_ID,
        companyId: OTHER_ID,
        role: "employee",
      },
    });

    assert.equal(status, 201);
    assert.equal(json.data.companyId, ENAYA_ID);
    assert.notEqual(json.data.companyId, OTHER_ID);
  });

  it("rejects tokens that do not contain companyId", async () => {
    const token = jwt.sign(
      {
        employeeId: ENAYA_ADMIN_ID,
        role: "company_admin",
        email: "admin@enaya.local",
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" },
    );

    const { status } = await request("GET", "/api/employees", { token });
    assert.equal(status, 401);
  });
});
