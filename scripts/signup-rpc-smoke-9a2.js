#!/usr/bin/env node
/**
 * Phase 9A-2 controlled live signup RPC smoke.
 * SaaS Development only (iydepmuniwybqgejawhf.supabase.co).
 * Calls signup_company_workspace directly — not POST /api/public/signup.
 *
 * Usage: NODE_ENV=development node scripts/signup-rpc-smoke-9a2.js
 */

process.env.NODE_ENV = "development";

const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcryptjs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ALLOWED_HOST = "iydepmuniwybqgejawhf.supabase.co";
const SMOKE_NAME = "__SIGNUP_RPC_SMOKE_9A2__";
const ENABLED_FEATURES = ["orders", "products", "employees", "analytics"];

function fail(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  throw error;
}

function hostOf(urlText) {
  try {
    return new URL(String(urlText || "").trim()).hostname;
  } catch {
    return "";
  }
}

const CHILD_TABLES = [
  "employees",
  "company_integrations",
  "company_features",
  "company_order_sequences",
  "company_subscriptions",
];

async function deleteRows(supabase, table, column, value) {
  const { error } = await supabase.from(table).delete().eq(column, value);
  if (!error) return;
  const message = String(error.message || "").toLowerCase();
  if (message.includes("does not exist") || message.includes("schema cache")) return;
  fail(`cleanup failed for ${table}`, { details: error.message });
}

async function cleanupCompany(supabase, companyId) {
  if (!companyId) return;
  for (const table of CHILD_TABLES) {
    await deleteRows(supabase, table, "company_id", companyId);
  }
  await deleteRows(supabase, "companies", "id", companyId);
}

async function countForCompany(supabase, table, companyId) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("company_id", companyId);
  if (error && !String(error.message || "").toLowerCase().includes("does not exist")) {
    fail(`count failed for ${table}`, { details: error.message });
  }
  return count || 0;
}

async function main() {
  const host = hostOf(process.env.SUPABASE_URL);
  if (host !== ALLOWED_HOST) {
    console.log(
      JSON.stringify({
        ok: false,
        skipped: true,
        code: "TARGET_UNVERIFIED",
        expected: ALLOWED_HOST,
        rollback: "LIVE_ROLLBACK_PROOF_PENDING",
      }),
    );
    return;
  }

  const supabase = require("../src/config/supabase");
  const {
    SIGNUP_COMPANY_WORKSPACE_RPC,
    buildSignupCompanyWorkspaceArgs,
    parseSignupCompanyWorkspaceResult,
  } = require("../src/services/signupCompanyWorkspaceRpc");

  const suffix = crypto.randomBytes(4).toString("hex");
  const slug = `signup-rpc-smoke-9a2-${suffix}`;
  const adminEmail = `signup-smoke-${suffix}@example.test`;
  const passwordHash = await bcrypt.hash(`Smoke${suffix}Aa1!`, 10);
  let companyId = "";
  let rpcCalls = 0;

  try {
    const args = buildSignupCompanyWorkspaceArgs({
      companyName: SMOKE_NAME,
      slug,
      adminName: "Signup Smoke Admin",
      adminEmail,
      passwordHash,
    });
    rpcCalls += 1;
    const { data, error } = await supabase.rpc(SIGNUP_COMPANY_WORKSPACE_RPC, args);
    if (error) fail("signup RPC failed", { code: error.code, hint: error.hint });
    const created = parseSignupCompanyWorkspaceResult(data);
    companyId = created.companyId;
    if (!companyId) fail("signup RPC returned no companyId");
    if (created.role !== "company_admin") fail("first employee was not company_admin");
    if (created.companySlug !== slug) fail("slug mismatch");

    const company = await supabase
      .from("companies")
      .select("id,name,slug,is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (company.error) fail("company lookup failed", { details: company.error.message });
    if (!company.data || company.data.name !== SMOKE_NAME) fail("smoke company missing");

    const employee = await supabase
      .from("employees")
      .select("id,role,is_active,email,password")
      .eq("company_id", companyId)
      .maybeSingle();
    if (employee.error) fail("employee lookup failed", { details: employee.error.message });
    if (employee.data?.role !== "company_admin") fail("employee role mismatch");
    if (employee.data?.is_active !== true) fail("employee is not active");
    const storedHash = String(employee.data?.password || "");
    if (!storedHash.startsWith("$2")) fail("password was not hashed");

    const featureLinks = await supabase
      .from("company_features")
      .select("feature_id,is_enabled")
      .eq("company_id", companyId);
    if (featureLinks.error) fail("features lookup failed", { details: featureLinks.error.message });
    const enabledIds = (featureLinks.data || [])
      .filter((row) => row.is_enabled)
      .map((row) => row.feature_id)
      .filter(Boolean);
    const featureRows = enabledIds.length
      ? await supabase.from("features").select("id,key").in("id", enabledIds)
      : { data: [], error: null };
    if (featureRows.error) fail("feature keys lookup failed", { details: featureRows.error.message });
    const enabled = new Set((featureRows.data || []).map((row) => row.key).filter(Boolean));
    for (const key of ENABLED_FEATURES) {
      if (!enabled.has(key)) fail(`missing enabled feature ${key}`);
    }

    const sequence = await supabase
      .from("company_order_sequences")
      .select("company_id,next_value")
      .eq("company_id", companyId)
      .maybeSingle();
    if (sequence.error) fail("sequence lookup failed", { details: sequence.error.message });
    if (!sequence.data) fail("order sequence missing");

    await cleanupCompany(supabase, companyId);
    const leftoverEmployees = await countForCompany(supabase, "employees", companyId);
    const leftoverFeatures = await countForCompany(supabase, "company_features", companyId);
    const leftoverSeq = await countForCompany(supabase, "company_order_sequences", companyId);
    const gone = await supabase.from("companies").select("id").eq("id", companyId).maybeSingle();
    if (leftoverEmployees || leftoverFeatures || leftoverSeq || gone.data) {
      fail("smoke cleanup left rows behind");
    }
    companyId = "";

    console.log(
      JSON.stringify({
        ok: true,
        host,
        rpc: SIGNUP_COMPANY_WORKSPACE_RPC,
        rpcCalls,
        rollback: "LIVE_ROLLBACK_PROOF_PENDING",
        cleaned: true,
      }),
    );
  } catch (error) {
    if (companyId) {
      try {
        await cleanupCompany(supabase, companyId);
      } catch {
        // still report the original error
      }
    }
    console.error(
      JSON.stringify({
        ok: false,
        code: error.code || "SMOKE_FAILED",
        message: error.message,
        rollback: "LIVE_ROLLBACK_PROOF_PENDING",
      }),
    );
    process.exitCode = 1;
  }
}

main();
