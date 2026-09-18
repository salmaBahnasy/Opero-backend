/**
 * Canonical company roles for the SaaS employees table:
 *   company_admin | employee
 *
 * The old ERP stored and returned `admin`. Treat it as an alias of
 * company_admin everywhere — do not scatter `role === "admin" || ...`.
 *
 * Platform owners are NOT handled here (platform_admins table, later phase).
 */

const ROLE_COMPANY_ADMIN = "company_admin";
const ROLE_EMPLOYEE = "employee";

const CANONICAL_ROLES = [ROLE_COMPANY_ADMIN, ROLE_EMPLOYEE];

/** Roles accepted on write from the old frontend / Postman bodies. */
const INPUT_ROLES = [ROLE_COMPANY_ADMIN, "admin", ROLE_EMPLOYEE];

function normalizeRole(rawRole) {
  const r = String(rawRole || "").trim().toLowerCase();
  if (r === ROLE_COMPANY_ADMIN || r === "admin" || r === "senior" || r === "agent") {
    return ROLE_COMPANY_ADMIN;
  }
  if (r === ROLE_EMPLOYEE) {
    return ROLE_EMPLOYEE;
  }
  return ROLE_EMPLOYEE;
}

function isCompanyAdmin(rawRole) {
  return normalizeRole(rawRole) === ROLE_COMPANY_ADMIN;
}

function isKnownRoleInput(rawRole) {
  const r = String(rawRole || "").trim().toLowerCase();
  return INPUT_ROLES.includes(r);
}

/** Legacy public role for old clients that still check `admin`. */
function toPublicRole(rawRole) {
  return isCompanyAdmin(rawRole) ? "admin" : ROLE_EMPLOYEE;
}

function withEmployeeRoleKeys(row) {
  if (!row || typeof row !== "object") return row;
  const role = normalizeRole(row.role);
  return {
    ...row,
    role,
    employeeRole: toPublicRole(role),
  };
}

module.exports = {
  ROLE_COMPANY_ADMIN,
  ROLE_EMPLOYEE,
  CANONICAL_ROLES,
  INPUT_ROLES,
  ALLOWED_ROLES: INPUT_ROLES,
  normalizeRole,
  normalizeRoleForApp: normalizeRole,
  isCompanyAdmin,
  isKnownRoleInput,
  toPublicRole,
  withEmployeeRoleKeys,
};
