const bcrypt = require("bcryptjs");
const { signEmployeeToken } = require("../config/jwt");
const { normalizeRole, ROLE_COMPANY_ADMIN } = require("../utils/roles");
const {
  buildSignupCompanyWorkspaceArgs,
  parseSignupCompanyWorkspaceResult,
  invokeSignupCompanyWorkspace,
  normalizeSignupRpcError,
  validateSignupSlug,
  validateSignupEmail,
  isBcryptHash,
  signupError,
} = require("./signupCompanyWorkspaceRpc");

const { assertPassword, MIN_PASSWORD_CHARS } = require("../utils/passwordPolicy");

function pickString(body, ...keys) {
  if (!body || typeof body !== "object") return "";
  const key = keys.find((name) => body[name] != null && String(body[name]).trim() !== "");
  return key == null ? "" : String(body[key]).trim();
}

function validateSignupInput(body = {}) {
  const name = pickString(body, "name", "adminName", "fullName");
  const emailResult = validateSignupEmail(pickString(body, "email", "adminEmail"));
  const password = body?.password;
  const companyName = pickString(body, "companyName", "company_name");
  const slugResult = validateSignupSlug(pickString(body, "slug", "companySlug", "company_slug"));

  if (!name || name.length > 200) {
    throw signupError("SIGNUP_INVALID_INPUT", "Name is required", 400);
  }
  if (!emailResult.ok) {
    throw signupError("SIGNUP_INVALID_INPUT", "A valid email is required", 400);
  }
  if (typeof password !== "string") {
    throw signupError(
      "SIGNUP_INVALID_INPUT",
      "Password must be at least 8 characters",
      400,
    );
  }
  try {
    assertPassword(password);
  } catch (error) {
    throw signupError("SIGNUP_INVALID_INPUT", error.message, 400);
  }
  if (!companyName || companyName.length > 200) {
    throw signupError("SIGNUP_INVALID_INPUT", "Company name is required", 400);
  }
  if (!slugResult.ok) {
    throw signupError("SIGNUP_INVALID_INPUT", "Workspace slug is invalid", 400);
  }

  return {
    name,
    email: emailResult.email,
    password,
    companyName,
    slug: slugResult.slug,
  };
}

async function signupCompanyWorkspace(body, { rpc } = {}) {
  const input = validateSignupInput(body);
  const passwordHash = await bcrypt.hash(input.password, 10);
  if (!isBcryptHash(passwordHash)) {
    throw signupError("SIGNUP_FAILED", "Failed to create account", 500);
  }

  const args = buildSignupCompanyWorkspaceArgs({
    companyName: input.companyName,
    slug: input.slug,
    adminName: input.name,
    adminEmail: input.email,
    passwordHash,
  });

  const result = await invokeSignupCompanyWorkspace(args, { rpc });
  if (result?.error) {
    throw normalizeSignupRpcError(result.error);
  }

  const created = parseSignupCompanyWorkspaceResult(result?.data);
  if (
    !created?.companyId ||
    !created?.employeeId ||
    !created?.employeeEmail ||
    !created?.companySlug
  ) {
    throw signupError("SIGNUP_FAILED", "Failed to create account", 500);
  }

  const role = normalizeRole(created.role);
  if (role !== ROLE_COMPANY_ADMIN) {
    throw signupError("SIGNUP_FAILED", "Failed to create account", 500);
  }

  const token = signEmployeeToken({
    employeeId: created.employeeId,
    companyId: created.companyId,
    role,
    email: created.employeeEmail,
  });

  return {
    token,
    company: {
      id: created.companyId,
      name: created.companyName,
      slug: created.companySlug,
    },
    employee: {
      id: created.employeeId,
      name: created.employeeName,
      email: created.employeeEmail,
      role,
      companyId: created.companyId,
      is_active: true,
    },
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH: MIN_PASSWORD_CHARS,
  validateSignupInput,
  signupCompanyWorkspace,
};
