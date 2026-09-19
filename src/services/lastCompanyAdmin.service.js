const supabase = require("../config/supabase");
const { isCompanyAdmin } = require("../utils/roles");

const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";

function lastAdminError() {
  const error = new Error("At least one active company admin is required");
  error.code = "LAST_ADMIN_REQUIRED";
  error.statusCode = 409;
  return error;
}

async function listCompanyEmployeesForAdminGuard(companyId) {
  const { data, error } = await supabase
    .from(EMPLOYEES_TABLE)
    .select("id,role,is_active")
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
  return data || [];
}

function isActiveAdmin(row) {
  return Boolean(row) && row.is_active !== false && isCompanyAdmin(row.role);
}

async function assertNotRemovingLastActiveAdmin({
  companyId,
  employeeId,
  nextRole,
  nextIsActive,
  deleting = false,
}) {
  const rows = await listCompanyEmployeesForAdminGuard(companyId);
  const target = rows.find((row) => String(row.id) === String(employeeId));
  if (!target) return;

  const activeAdmins = rows.filter(isActiveAdmin);
  if (activeAdmins.length !== 1) return;
  if (String(activeAdmins[0].id) !== String(employeeId)) return;

  const roleAfter = nextRole === undefined ? target.role : nextRole;
  const activeAfter = deleting
    ? false
    : nextIsActive === undefined
      ? target.is_active !== false
      : Boolean(nextIsActive);

  if (!activeAfter || !isCompanyAdmin(roleAfter)) {
    throw lastAdminError();
  }
}

module.exports = {
  assertNotRemovingLastActiveAdmin,
  lastAdminError,
};
