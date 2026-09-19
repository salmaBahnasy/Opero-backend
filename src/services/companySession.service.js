const supabase = require("../config/supabase");
const { normalizeRole, toPublicRole } = require("../utils/roles");

const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";
const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";

function sessionInvalidError() {
  const error = new Error("Invalid or expired token");
  error.code = "SESSION_INVALID";
  error.statusCode = 401;
  return error;
}

async function revalidateCompanyEmployee({ companyId, employeeId }) {
  const cid = String(companyId || "").trim();
  const eid = String(employeeId || "").trim();
  if (!cid || !eid) throw sessionInvalidError();

  const [{ data: company, error: companyError }, { data: employee, error: employeeError }] =
    await Promise.all([
      supabase
        .from(COMPANIES_TABLE)
        .select("id,is_active,deleted_at")
        .eq("id", cid)
        .maybeSingle(),
      supabase
        .from(EMPLOYEES_TABLE)
        .select("id,company_id,role,is_active,email")
        .eq("id", eid)
        .maybeSingle(),
    ]);

  if (companyError || employeeError) {
    const error = new Error("Failed to validate session");
    error.code = "SESSION_LOOKUP_FAILED";
    throw error;
  }

  if (!company || company.is_active === false || company.deleted_at) {
    throw sessionInvalidError();
  }
  if (!employee || String(employee.company_id) !== cid) {
    throw sessionInvalidError();
  }
  if (employee.is_active === false) {
    throw sessionInvalidError();
  }

  const role = normalizeRole(employee.role);
  return {
    employeeId: String(employee.id),
    companyId: cid,
    role,
    email: employee.email,
    id: String(employee.id),
    employeeRole: toPublicRole(role),
  };
}

module.exports = {
  revalidateCompanyEmployee,
  sessionInvalidError,
};
