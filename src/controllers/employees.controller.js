const bcrypt = require("bcryptjs");
const supabase = require("../config/supabase");
const { signEmployeeToken } = require("../config/jwt");
const { getCompanyId } = require("../middlewares/tenant.middleware");
const {
  ALLOWED_ROLES,
  normalizeRole,
  normalizeRoleForApp,
  isKnownRoleInput,
  withEmployeeRoleKeys,
} = require("../utils/roles");

const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";
const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";

const EMPLOYEE_PUBLIC_COLUMNS =
  "id,company_id,name,email,phone,role,is_active,created_at,updated_at";

function pickLoginField(body, ...keys) {
  if (!body || typeof body !== "object") return "";
  for (const key of keys) {
    if (body[key] != null && String(body[key]).trim() !== "") {
      return String(body[key]).trim();
    }
  }
  return "";
}

function pickRoleFromBody(body) {
  if (body == null || typeof body !== "object") return "employee";
  if (body.role != null && String(body.role).trim() !== "") {
    return String(body.role).trim();
  }
  if (body.employeeRole != null && String(body.employeeRole).trim() !== "") {
    return String(body.employeeRole).trim();
  }
  return "employee";
}

/** Accepts boolean, 0/1, or strings like active / inactive / notactive */
function coerceIsActive(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "active", "yes"].includes(s)) return true;
  if (
    ["false", "0", "inactive", "notactive", "not_active", "disabled", "no"].includes(
      s,
    )
  ) {
    return false;
  }
  return null;
}

function toPublicEmployee(employee) {
  if (!employee) return null;
  const { password, company_id: companyIdCol, ...safeEmployee } = employee;
  return {
    ...withEmployeeRoleKeys(safeEmployee),
    companyId: companyIdCol ?? employee.companyId ?? null,
  };
}

function invalidCredentials(res) {
  res.status(401).json({
    success: false,
    message: "Invalid credentials",
  });
}

async function login(req, res) {
  try {
    const body = req.body || {};
    const companySlug = pickLoginField(body, "companySlug", "company_slug").toLowerCase();
    const email = pickLoginField(body, "email").toLowerCase();
    const password = body.password;

    if (!companySlug || !email || !password) {
      res.status(400).json({
        success: false,
        message: "companySlug, email and password are required",
      });
      return;
    }

    const { data: company, error: companyError } = await supabase
      .from(COMPANIES_TABLE)
      .select("id,slug,is_active,deleted_at")
      .eq("slug", companySlug)
      .maybeSingle();

    if (companyError) {
      throw new Error(companyError.message);
    }

    if (!company || company.is_active === false || company.deleted_at) {
      invalidCredentials(res);
      return;
    }

    const { data: employee, error: employeeError } = await supabase
      .from(EMPLOYEES_TABLE)
      .select("*")
      .eq("company_id", company.id)
      .eq("email", email)
      .maybeSingle();

    if (employeeError) {
      throw new Error(employeeError.message);
    }

    if (!employee) {
      invalidCredentials(res);
      return;
    }

    const isValidPassword = await bcrypt.compare(password, employee.password);
    if (!isValidPassword) {
      invalidCredentials(res);
      return;
    }

    if (employee.is_active === false) {
      res.status(403).json({
        success: false,
        message: "Account is inactive. Contact an administrator.",
      });
      return;
    }

    const role = normalizeRole(employee.role);
    const token = signEmployeeToken({
      employeeId: employee.id,
      companyId: company.id,
      role,
      email: employee.email,
    });

    res.json({
      success: true,
      message: "Login successful",
      token,
      data: toPublicEmployee({ ...employee, company_id: company.id }),
    });
  } catch (error) {
    console.error("[login] failed", {
      message: error?.message,
      code: error?.code,
    });
    const isDev = ["development", "dev", "test"].includes(
      String(process.env.NODE_ENV || "").toLowerCase(),
    );
    res.status(500).json({
      success: false,
      message: "Failed to login",
      ...(isDev ? { error: error?.message } : {}),
    });
  }
}

function employeesTable() {
  return supabase.from(EMPLOYEES_TABLE);
}

function rejectMissingTenant(res, companyId) {
  if (companyId) return false;
  res.status(401).json({
    success: false,
    message: "Unauthorized. Token must include companyId.",
  });
  return true;
}

async function getEmployees(req, res) {
  try {
    const companyId = getCompanyId(req);
    if (rejectMissingTenant(res, companyId)) return;

    const { data, error } = await employeesTable()
      .select(EMPLOYEE_PUBLIC_COLUMNS)
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    res.json({
      success: true,
      total: (data || []).length,
      data: (data || []).map((row) => toPublicEmployee(row)),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch employees",
    });
  }
}

async function addEmployee(req, res) {
  try {
    const companyId = getCompanyId(req);
    if (rejectMissingTenant(res, companyId)) return;
    const { name, email, password } = req.body || {};
    const roleInput = pickRoleFromBody(req.body);

    if (!name || !email || !password) {
      res.status(400).json({
        success: false,
        message: "name, email and password are required",
      });
      return;
    }

    if (!isKnownRoleInput(roleInput)) {
      res.status(400).json({
        success: false,
        message: "Invalid role",
        allowedRoles: ALLOWED_ROLES,
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = normalizeRole(roleInput);

    const { data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .insert({
        company_id: companyId,
        name,
        email: String(email).trim().toLowerCase(),
        password: hashedPassword,
        role,
        is_active: true,
      })
      .select(EMPLOYEE_PUBLIC_COLUMNS)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    res.status(201).json({
      success: true,
      message: "Employee added successfully",
      data: toPublicEmployee(data),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to add employee",
    });
  }
}

async function deleteEmployee(req, res) {
  try {
    const companyId = getCompanyId(req);
    if (rejectMissingTenant(res, companyId)) return;
    const { employeeId } = req.params;

    const { data, error } = await employeesTable()
      .delete()
      .eq("company_id", companyId)
      .eq("id", employeeId)
      .select("id")
      .single();

    if (error || !data) {
      res.status(404).json({
        success: false,
        message: "Employee not found",
      });
      return;
    }

    res.json({
      success: true,
      message: "Employee deleted successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete employee",
    });
  }
}

async function editEmployee(req, res) {
  try {
    const companyId = getCompanyId(req);
    if (rejectMissingTenant(res, companyId)) return;
    const { employeeId } = req.params;
    const {
      name,
      email,
      phone,
      password,
      role,
      employeeRole,
      is_active,
      account_status,
    } = req.body || {};

    const updates = {};

    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = String(email).trim().toLowerCase();
    if (phone !== undefined) updates.phone = phone;

    if (account_status !== undefined) {
      const coerced = coerceIsActive(account_status);
      if (coerced === null) {
        res.status(400).json({
          success: false,
          message:
            "Invalid account_status. Use active, inactive, or notactive",
        });
        return;
      }
      updates.is_active = coerced;
    }

    if (is_active !== undefined && account_status === undefined) {
      const coerced = coerceIsActive(is_active);
      if (coerced === null) {
        res.status(400).json({
          success: false,
          message: "Invalid is_active value",
        });
        return;
      }
      updates.is_active = coerced;
    }

    if (role !== undefined || employeeRole !== undefined) {
      const fromRole =
        role !== undefined && String(role).trim() !== ""
          ? String(role).trim()
          : null;
      const fromER =
        employeeRole !== undefined && String(employeeRole).trim() !== ""
          ? String(employeeRole).trim()
          : null;
      const r = fromRole ?? fromER ?? "";
      if (!r) {
        res.status(400).json({
          success: false,
          message: "role or employeeRole must be admin or employee (non-empty)",
          allowedRoles: ALLOWED_ROLES,
        });
        return;
      }
      if (!isKnownRoleInput(r)) {
        res.status(400).json({
          success: false,
          message: "Invalid role",
          allowedRoles: ALLOWED_ROLES,
          hint: "Send role or employeeRole (company_admin | admin | employee)",
        });
        return;
      }
      updates.role = normalizeRole(r);
    }

    if (password !== undefined) {
      updates.password = await bcrypt.hash(password, 10);
    }

    if (!Object.keys(updates).length) {
      res.status(400).json({
        success: false,
        message:
          "No fields to update. Send at least one of: name, email, phone, password, role, employeeRole, is_active, account_status",
      });
      return;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await employeesTable()
      .update(updates)
      .eq("company_id", companyId)
      .eq("id", employeeId)
      .select(EMPLOYEE_PUBLIC_COLUMNS)
      .single();

    if (error || !data) {
      res.status(404).json({
        success: false,
        message: "Employee not found",
      });
      return;
    }

    res.json({
      success: true,
      message: "Employee updated successfully",
      data: toPublicEmployee(data),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update employee",
    });
  }
}

async function setEmployeeActive(req, res) {
  try {
    const companyId = getCompanyId(req);
    if (rejectMissingTenant(res, companyId)) return;
    const { employeeId } = req.params;
    const activeRaw =
      req.body.active ?? req.body.is_active ?? req.body.account_status;

    if (activeRaw === undefined) {
      res.status(400).json({
        success: false,
        message: "Send active (boolean) or account_status (active / inactive)",
      });
      return;
    }

    const coerced = coerceIsActive(activeRaw);
    if (coerced === null) {
      res.status(400).json({
        success: false,
        message: "Invalid value. Use true/false or active / inactive / notactive",
      });
      return;
    }

    const { data, error } = await employeesTable()
      .update({
        is_active: coerced,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", companyId)
      .eq("id", employeeId)
      .select(EMPLOYEE_PUBLIC_COLUMNS)
      .single();

    if (error || !data) {
      res.status(404).json({
        success: false,
        message: "Employee not found",
      });
      return;
    }

    res.json({
      success: true,
      message: coerced ? "Employee activated" : "Employee deactivated",
      data: toPublicEmployee(data),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update employee status",
    });
  }
}

module.exports = {
  login,
  /** @deprecated استخدم `login` أو `POST /api/employees/login` */
  loginSenior: login,
  getEmployees,
  addEmployee,
  deleteEmployee,
  editEmployee,
  setEmployeeActive,
  ALLOWED_ROLES,
  normalizeRoleForApp,
};
