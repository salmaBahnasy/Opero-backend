process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const {
  SIGNUP_COMPANY_WORKSPACE_RPC,
  buildSignupCompanyWorkspaceArgs,
  parseSignupCompanyWorkspaceResult,
  extractSignupCode,
} = require("../src/services/signupCompanyWorkspaceRpc");

const BACKEND_ROOT = path.resolve(__dirname, "..");
const MIGRATION_015 = path.join(
  BACKEND_ROOT,
  "supabase/migrations/015_atomic_company_signup.sql",
);
const MIGRATION_013 = path.join(
  BACKEND_ROOT,
  "supabase/migrations/013_catalog_foundation.sql",
);
const MIGRATION_014 = path.join(
  BACKEND_ROOT,
  "supabase/migrations/014_catalog_write_rpc.sql",
);
const DEFAULTS_SQL = path.join(
  BACKEND_ROOT,
  "supabase/migrations/004_features_plans.sql",
);

const LIVE_ROLLBACK_PROOF_PENDING = "LIVE_ROLLBACK_PROOF_PENDING";

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

describe("Phase 9A-1 atomic signup RPC (review only)", () => {
  const sql = fs.readFileSync(MIGRATION_015, "utf8");
  const sql004 = fs.readFileSync(DEFAULTS_SQL, "utf8");
  const sql013 = fs.readFileSync(MIGRATION_013, "utf8");
  const sql014 = fs.readFileSync(MIGRATION_014, "utf8");
  const executable = sql.slice(sql.indexOf("create or replace function public.signup_company_workspace"));

  it("creates 015 in place with the expected signature, DEFINER, and search_path", () => {
    assert.equal(fs.existsSync(MIGRATION_015), true);
    assert.match(
      sql,
      /create or replace function public\.signup_company_workspace\(\s*p_company_name text,\s*p_slug text,\s*p_admin_name text,\s*p_admin_email text,\s*p_password_hash text\s*\)/s,
    );
    const header = sql.slice(
      sql.indexOf("create or replace function public.signup_company_workspace"),
      sql.indexOf("$signup$"),
    );
    assert.match(header, /security definer/i);
    assert.match(header, /set search_path = public, pg_temp/);
    assert.equal(SIGNUP_COMPANY_WORKSPACE_RPC, "signup_company_workspace");
  });

  it("grants EXECUTE to service_role only and revokes PUBLIC/anon/authenticated", () => {
    assert.match(
      sql,
      /revoke all on function public\.signup_company_workspace\(text, text, text, text, text\) from public/i,
    );
    assert.match(sql, /from anon/);
    assert.match(sql, /from authenticated/);
    assert.match(
      sql,
      /grant execute on function public\.signup_company_workspace\(text, text, text, text, text\) to service_role/,
    );
  });

  it("inserts only required company columns and reuses existing default provisioning", () => {
    assert.match(executable, /insert into public\.companies \(name, slug\)/);
    assert.doesNotMatch(executable, /insert into public\.company_features/i);
    assert.doesNotMatch(executable, /insert into public\.company_order_sequences/i);
    assert.doesNotMatch(executable, /perform public\.provision_company_defaults/);
    assert.match(sql, /Does NOT duplicate provision_company_defaults/);
    assert.match(
      sql004,
      /f\.key in \('orders', 'products', 'employees', 'analytics'\)/,
    );
    assert.match(sql004, /trg_companies_provision_defaults/);
  });

  it("forces company_admin and is_active=true and does not accept privileged inputs", () => {
    assert.match(
      sql,
      /insert into public\.employees \(\s*company_id,\s*name,\s*email,\s*password,\s*role,\s*is_active\s*\)/s,
    );
    assert.match(sql, /'company_admin',\s*true/s);
    assert.doesNotMatch(sql, /p_role\b/);
    assert.doesNotMatch(sql, /p_is_active\b/);
    assert.doesNotMatch(sql, /p_company_id\b/);
    assert.doesNotMatch(sql, /p_employee_id\b/);
    assert.doesNotMatch(sql, /p_feature/);
    assert.doesNotMatch(sql, /p_plan/);
    assert.doesNotMatch(sql, /p_subscription/);
    assert.doesNotMatch(sql, /p_password\b/);
  });

  it("never accepts a plaintext password parameter and returns a safe shape", () => {
    assert.match(sql, /p_password_hash text/);
    assert.match(sql, /\^\[\$\]2\[aby\]\[\$\]\[0-9\]\{2\}\[\$\]\[A-Za-z0-9\.\/\]\{53\}\$/);
    assert.match(sql, /'companyId'/);
    assert.match(sql, /'companySlug'/);
    assert.match(sql, /'companyName'/);
    assert.match(sql, /'employeeId'/);
    assert.match(sql, /'employeeEmail'/);
    assert.match(sql, /'employeeName'/);
    assert.match(sql, /'role'/);
    assert.doesNotMatch(sql, /'password'/);
    assert.doesNotMatch(sql, /v_employee\.password/);
    assert.doesNotMatch(sql, /service_role key/i);
  });

  it("maps slug and employee unique conflicts and has no explicit transaction control", () => {
    assert.match(sql, /SIGNUP_INVALID_INPUT/);
    assert.match(sql, /SIGNUP_SLUG_CONFLICT/);
    assert.match(sql, /SIGNUP_EMPLOYEE_CONFLICT/);
    assert.match(sql, /companies_slug_unique/);
    assert.match(sql, /employees_company_email_unique/);
    assert.doesNotMatch(sql, /\bbegin\s*;/i);
    assert.doesNotMatch(sql, /\bcommit\s*;/i);
    assert.doesNotMatch(sql, /\brollback\s*;/i);
  });

  it("does not alter 013/014 or add tables/columns/RLS/catalog/order/product schema", () => {
    assert.doesNotMatch(executable, /alter table/i);
    assert.doesNotMatch(executable, /create table/i);
    assert.doesNotMatch(executable, /drop table/i);
    assert.doesNotMatch(executable, /enable row level security/i);
    assert.doesNotMatch(executable, /apply_catalog_product_plan/);
    assert.doesNotMatch(executable, /writeCatalogProductPlan/);
    assert.match(sql013, /create table if not exists public\.product_variants/);
    assert.match(sql014, /create or replace function public\.apply_catalog_product_plan/);
    assert.equal(
      fs.existsSync(path.join(BACKEND_ROOT, "supabase/migrations/015_catalog_write_rpc.sql")),
      false,
    );
  });

  it("adapter builds trusted args without role/features and parses a safe result", async () => {
    const passwordHash = await bcrypt.hash("SignupPass123!", 10);
    const args = buildSignupCompanyWorkspaceArgs({
      companyName: " Acme Store ",
      slug: "Acme-Store",
      adminName: " Salma ",
      adminEmail: "Admin@Acme.Store",
      passwordHash,
      role: "employee",
      is_active: false,
      companyId: "stolen",
      features: ["ai"],
    });
    assert.deepEqual(Object.keys(args).sort(), [
      "p_admin_email",
      "p_admin_name",
      "p_company_name",
      "p_password_hash",
      "p_slug",
    ]);
    assert.equal(args.p_company_name, "Acme Store");
    assert.equal(args.p_slug, "acme-store");
    assert.equal(args.p_admin_email, "admin@acme.store");
    assert.equal(args.p_password_hash.startsWith("$2"), true);
    assert.equal("role" in args, false);
    assert.equal("p_role" in args, false);
    assert.equal("p_is_active" in args, false);

    const parsed = parseSignupCompanyWorkspaceResult({
      companyId: "11111111-1111-4111-8111-111111111111",
      companySlug: "acme-store",
      companyName: "Acme Store",
      employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      employeeEmail: "admin@acme.store",
      employeeName: "Salma",
      role: "company_admin",
      password: "should-not-be-kept-if-absent",
    });
    assert.equal(parsed.role, "company_admin");
    assert.equal(parsed.companySlug, "acme-store");
    assert.equal("password" in parsed, false);
    assert.equal(extractSignupCode({ hint: "SIGNUP_SLUG_CONFLICT" }), "SIGNUP_SLUG_CONFLICT");
  });

  it("does not add migration 016 and leaves live rollback proof pending", () => {
    const migrations = fs.readdirSync(path.join(BACKEND_ROOT, "supabase/migrations"));
    assert.equal(
      migrations.some((name) => String(name).startsWith("016")),
      false,
    );
    assert.equal(fs.existsSync(MIGRATION_015), true);
    assert.equal(LIVE_ROLLBACK_PROOF_PENDING, "LIVE_ROLLBACK_PROOF_PENDING");
  });
});
