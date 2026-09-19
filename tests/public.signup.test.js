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
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { getJwtSecret } = require("../src/config/jwt");
const {
  SIGNUP_COMPANY_WORKSPACE_RPC,
  buildSignupCompanyWorkspaceArgs,
} = require("../src/services/signupCompanyWorkspaceRpc");

let server;
let baseUrl;
let fake;

async function request(method, pathname, { body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
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

function validBody(overrides = {}) {
  return {
    name: "Salma Admin",
    email: "owner@acme.test",
    password: "SignupPass123!",
    companyName: "Acme Store",
    slug: "acme-store",
    ...overrides,
  };
}

describe("public SaaS signup", () => {
  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    fake = createFakeSupabase({
      companies: [],
      employees: [],
      features: [
        { id: "feat-orders", key: "orders", is_active: true },
        { id: "feat-products", key: "products", is_active: true },
        { id: "feat-employees", key: "employees", is_active: true },
        { id: "feat-analytics", key: "analytics", is_active: true },
      ],
    });
    supabase.__setClientForTests(fake);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("creates company_admin, hashes the password, signs an employee JWT, and calls the RPC once", async () => {
    const body = validBody();
    const created = await request("POST", "/api/public/signup", { body });
    assert.equal(created.status, 201, created.json?.message);
    assert.equal(created.json.success, true);
    assert.equal(created.json.data.employee.role, "company_admin");
    assert.equal(created.json.data.employee.is_active, true);
    assert.equal(created.json.data.company.slug, "acme-store");
    assert.equal(Boolean(created.json.token), true);

    const payload = jwt.verify(created.json.token, getJwtSecret());
    assert.equal(payload.employeeId, created.json.data.employee.id);
    assert.equal(payload.companyId, created.json.data.company.id);
    assert.equal(payload.role, "company_admin");
    assert.equal(payload.email, "owner@acme.test");
    assert.equal(payload.scope, "company");
    assert.equal(Boolean(payload.platformAdminId), false);

    const blob = JSON.stringify(created.json);
    assert.equal(blob.includes(body.password), false);
    assert.equal(blob.includes("$2a$"), false);
    assert.equal(blob.includes("$2b$"), false);
    assert.equal("password" in (created.json.data.employee || {}), false);

    assert.equal(fake.__rpcCalls.length, 1);
    assert.equal(fake.__rpcCalls[0].name, SIGNUP_COMPANY_WORKSPACE_RPC);
    const args = fake.__rpcCalls[0].args;
    assert.equal(args.p_password_hash.startsWith("$2"), true);
    assert.equal(args.p_password_hash === body.password, false);
    assert.equal("p_password" in args, false);
    assert.equal("p_role" in args, false);
    assert.equal("p_company_id" in args, false);
    assert.equal("p_is_active" in args, false);
    assert.equal(await bcrypt.compare(body.password, args.p_password_hash), true);

    const stored = fake.__db.employees[0];
    assert.equal(stored.role, "company_admin");
    assert.equal(stored.is_active, true);
    assert.equal(stored.password.startsWith("$2"), true);
  });

  it("ignores privileged client fields and still forces company_admin", async () => {
    const created = await request("POST", "/api/public/signup", {
      body: validBody({
        companyId: "stolen-company",
        employeeId: "stolen-employee",
        role: "employee",
        is_active: false,
        features: ["ai"],
        plan: "scale",
        subscription: "active",
        platformAdmin: true,
      }),
    });
    assert.equal(created.status, 201, created.json?.message);
    assert.equal(created.json.data.employee.role, "company_admin");
    assert.equal(created.json.data.employee.is_active, true);
    assert.notEqual(created.json.data.company.id, "stolen-company");
    const args = fake.__rpcCalls[0].args;
    assert.deepEqual(Object.keys(args).sort(), Object.keys(buildSignupCompanyWorkspaceArgs({
      companyName: "x",
      slug: "x",
      adminName: "x",
      adminEmail: "a@b.co",
      passwordHash: "x",
    })).sort());
  });

  it("rejects reserved/invalid slugs before RPC and maps slug conflicts to 409", async () => {
    const reserved = await request("POST", "/api/public/signup", {
      body: validBody({ slug: "login" }),
    });
    assert.equal(reserved.status, 400);
    assert.equal(reserved.json.code, "SIGNUP_INVALID_INPUT");
    assert.equal(fake.__rpcCalls.length, 0);

    const invalid = await request("POST", "/api/public/signup", {
      body: validBody({ slug: "Not Valid" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(fake.__rpcCalls.length, 0);

    const first = await request("POST", "/api/public/signup", { body: validBody() });
    assert.equal(first.status, 201);
    const second = await request("POST", "/api/public/signup", {
      body: validBody({ email: "other@acme.test" }),
    });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "SIGNUP_SLUG_CONFLICT");
    assert.equal(fake.__rpcCalls.length, 2);
  });

  it("maps employee conflict to 409 and unexpected database errors to a safe 500", async () => {
    const { signupCompanyWorkspace } = require("../src/services/publicSignup.service");
    let employeeCalls = 0;
    await assert.rejects(
      () =>
        signupCompanyWorkspace(validBody({ slug: "conflict-admin" }), {
          rpc: async () => {
            employeeCalls += 1;
            return {
              data: null,
              error: {
                hint: "SIGNUP_EMPLOYEE_CONFLICT",
                message: "SIGNUP_EMPLOYEE_CONFLICT: employee email already exists",
              },
            };
          },
        }),
      (error) =>
        error.statusCode === 409 &&
        error.code === "SIGNUP_EMPLOYEE_CONFLICT" &&
        employeeCalls === 1,
    );

    const originalRpc = fake.rpc.bind(fake);
    fake.rpc = async (name, args) => {
      if (name === SIGNUP_COMPANY_WORKSPACE_RPC) {
        fake.__rpcCalls.push({ name, args: { ...(args || {}) } });
        return {
          data: null,
          error: { message: 'duplicate key value violates unique constraint "secret_idx"' },
        };
      }
      return originalRpc(name, args);
    };
    const boom = await request("POST", "/api/public/signup", {
      body: validBody({ slug: "safe-500", email: "safe500@acme.test" }),
    });
    assert.equal(boom.status, 500);
    assert.equal(boom.json.code, "SIGNUP_FAILED");
    assert.equal(boom.json.message, "Failed to create account");
    const blob = JSON.stringify(boom.json);
    assert.equal(blob.includes("duplicate key"), false);
    assert.equal(blob.includes("secret_idx"), false);
    assert.equal(fake.__rpcCalls.length, 1);
  });

  it("does not retry the mutation RPC and never exposes platform tokens or secrets in source", () => {
    const service = fs.readFileSync(
      path.join(__dirname, "../src/services/publicSignup.service.js"),
      "utf8",
    );
    const adapter = fs.readFileSync(
      path.join(__dirname, "../src/services/signupCompanyWorkspaceRpc.js"),
      "utf8",
    );
    const controller = fs.readFileSync(
      path.join(__dirname, "../src/controllers/publicSignup.controller.js"),
      "utf8",
    );
    assert.equal(service.includes("invokeSignupCompanyWorkspace(args"), true);
    assert.equal(service.includes("for ("), false);
    assert.equal(adapter.includes("signPlatformAdminToken"), false);
    assert.equal(controller.includes("console.log"), false);
    assert.equal(service.includes("from(\"companies\")"), false);
    assert.equal(service.includes("from(\"employees\")"), false);
    const migrations = fs.readdirSync(path.join(__dirname, "../supabase/migrations"));
    assert.equal(migrations.some((name) => String(name).startsWith("016")), false);
  });
});
