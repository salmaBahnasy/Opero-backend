/**
 * Adapter for public.signup_company_workspace.
 * Builds RPC arguments, parses results, and invokes the RPC once
 * through the service-role client. Mutation is not retried.
 */

const SIGNUP_COMPANY_WORKSPACE_RPC = "signup_company_workspace";

const SIGNUP_RPC_CODES = new Set([
  "SIGNUP_INVALID_INPUT",
  "SIGNUP_SLUG_CONFLICT",
  "SIGNUP_EMPLOYEE_CONFLICT",
]);

const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "login",
  "signup",
  "settings",
  "dashboard",
  "platform",
  "www",
]);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_HASH_PATTERN = /^[$]2[aby][$][0-9]{2}[$][A-Za-z0-9./]{53}$/;
const ALLOWED_SAAS_DEV_HOST = "iydepmuniwybqgejawhf.supabase.co";

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function buildSignupCompanyWorkspaceArgs({
  companyName,
  slug,
  adminName,
  adminEmail,
  passwordHash,
} = {}) {
  return {
    p_company_name: trimText(companyName),
    p_slug: trimText(slug).toLowerCase(),
    p_admin_name: trimText(adminName),
    p_admin_email: trimText(adminEmail).toLowerCase(),
    p_password_hash: trimText(passwordHash),
  };
}

function parseSignupCompanyWorkspaceResult(raw) {
  const row = asObject(raw);
  if (!row) return null;
  return {
    companyId: row.companyId ?? row.company_id ?? null,
    companySlug: row.companySlug ?? row.company_slug ?? null,
    companyName: row.companyName ?? row.company_name ?? null,
    employeeId: row.employeeId ?? row.employee_id ?? null,
    employeeEmail: row.employeeEmail ?? row.employee_email ?? null,
    employeeName: row.employeeName ?? row.employee_name ?? null,
    role: row.role ?? null,
  };
}

function extractSignupCode(error) {
  const hint = trimText(error?.hint);
  if (SIGNUP_RPC_CODES.has(hint)) return hint;
  const message = trimText(error?.message);
  const match = message.match(/\b(SIGNUP_[A-Z0-9_]+)\b/);
  if (match && SIGNUP_RPC_CODES.has(match[1])) return match[1];
  const code = trimText(error?.code);
  if (SIGNUP_RPC_CODES.has(code)) return code;
  return "";
}

function slugifyCompanyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63);
}

function validateSignupSlug(raw) {
  const slug = trimText(raw).toLowerCase();
  if (!slug || slug.length < 2 || slug.length > 63 || !SLUG_PATTERN.test(slug)) {
    return { ok: false, code: "SIGNUP_INVALID_INPUT", slug };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, code: "SIGNUP_INVALID_INPUT", slug };
  }
  return { ok: true, slug };
}

function validateSignupEmail(raw) {
  const email = trimText(raw).toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email) || email.length > 200) {
    return { ok: false, email };
  }
  return { ok: true, email };
}

function isBcryptHash(value) {
  return BCRYPT_HASH_PATTERN.test(trimText(value));
}

function signupError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeSignupRpcError(error) {
  const code = extractSignupCode(error);
  if (code === "SIGNUP_INVALID_INPUT") {
    return signupError(code, "Signup details are invalid", 400);
  }
  if (code === "SIGNUP_SLUG_CONFLICT") {
    return signupError(code, "Workspace slug is already taken", 409);
  }
  if (code === "SIGNUP_EMPLOYEE_CONFLICT") {
    return signupError(code, "This email cannot be used for this workspace", 409);
  }
  return signupError("SIGNUP_FAILED", "Failed to create account", 500);
}

function assertAllowedSignupHost() {
  const urlText = trimText(process.env.SUPABASE_URL);
  let host = "";
  try {
    host = new URL(urlText).hostname;
  } catch {
    host = "";
  }
  if (host !== ALLOWED_SAAS_DEV_HOST) {
    throw signupError(
      "TARGET_UNVERIFIED",
      "signup_company_workspace refuses hosts other than SaaS Development",
      500,
    );
  }
}

async function invokeSignupCompanyWorkspace(args, { rpc } = {}) {
  const invoke =
    typeof rpc === "function"
      ? rpc
      : (name, payload) => {
          if (process.env.NODE_ENV !== "test") {
            assertAllowedSignupHost();
          }
          const supabase = require("../config/supabase");
          return supabase.rpc(name, payload);
        };
  return invoke(SIGNUP_COMPANY_WORKSPACE_RPC, args);
}

module.exports = {
  SIGNUP_COMPANY_WORKSPACE_RPC,
  SIGNUP_RPC_CODES,
  RESERVED_SLUGS,
  ALLOWED_SAAS_DEV_HOST,
  buildSignupCompanyWorkspaceArgs,
  parseSignupCompanyWorkspaceResult,
  extractSignupCode,
  slugifyCompanyName,
  validateSignupSlug,
  validateSignupEmail,
  isBcryptHash,
  signupError,
  normalizeSignupRpcError,
  invokeSignupCompanyWorkspace,
};
