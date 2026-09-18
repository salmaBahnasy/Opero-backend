const supabase = require("../config/supabase");
const { normalizeRole } = require("../utils/roles");
const {
  CORE_FEATURE_KEYS,
  COMPANY_BRANDING_COLUMNS,
  SAFE_INTEGRATION_COLUMNS,
  toBranding,
} = require("../utils/branding");

const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";
const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";
const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";
const FEATURES_TABLE = process.env.SUPABASE_FEATURES_TABLE || "features";
const COMPANY_FEATURES_TABLE =
  process.env.SUPABASE_COMPANY_FEATURES_TABLE || "company_features";

function notFound(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toSafeIntegration(row) {
  return {
    id: row.id,
    provider: row.provider,
    category: row.category,
    name: row.name,
    enabled: Boolean(row.is_enabled),
  };
}

async function loadCompany(companyId) {
  const { data, error } = await supabase
    .from(COMPANIES_TABLE)
    .select(COMPANY_BRANDING_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.deleted_at) {
    throw notFound("Company not found", "COMPANY_NOT_FOUND");
  }
  return data;
}

async function loadEmployee(companyId, employeeId) {
  const { data, error } = await supabase
    .from(EMPLOYEES_TABLE)
    .select("id,company_id,name,email,role,is_active")
    .eq("id", employeeId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw notFound("Employee not found", "EMPLOYEE_NOT_FOUND");
  }
  if (data.is_active === false) {
    const inactive = new Error("Account is inactive. Contact an administrator.");
    inactive.code = "EMPLOYEE_INACTIVE";
    throw inactive;
  }
  return data;
}

async function loadFeatureMap(companyId) {
  const map = {};
  for (const key of CORE_FEATURE_KEYS) {
    map[key] = false;
  }

  const [{ data: catalog, error: catalogError }, { data: rows, error: rowsError }] =
    await Promise.all([
      supabase.from(FEATURES_TABLE).select("id,key,is_active"),
      supabase
        .from(COMPANY_FEATURES_TABLE)
        .select("feature_id,is_enabled")
        .eq("company_id", companyId),
    ]);

  if (catalogError) {
    if (isMissingRelation(catalogError)) return map;
    throw new Error(catalogError.message);
  }
  if (rowsError) {
    if (isMissingRelation(rowsError)) return map;
    throw new Error(rowsError.message);
  }

  const byId = new Map((catalog || []).map((feature) => [String(feature.id), feature]));
  for (const row of rows || []) {
    const feature = byId.get(String(row.feature_id));
    if (!feature || !feature.key) continue;
    map[feature.key] = Boolean(row.is_enabled) && feature.is_active !== false;
  }
  return map;
}

function isMissingRelation(error) {
  const message = String(error?.message || error?.code || "").toLowerCase();
  return (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    error?.code === "42P01" ||
    error?.code === "PGRST205"
  );
}

async function loadIntegrations(companyId) {
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select(SAFE_INTEGRATION_COLUMNS)
    .eq("company_id", companyId)
    .eq("is_enabled", true);
  if (error) throw new Error(error.message);

  const grouped = { commerce: [], shipping: [] };
  for (const row of data || []) {
    const item = toSafeIntegration(row);
    if (item.category === "shipping") grouped.shipping.push(item);
    else if (item.category === "commerce") grouped.commerce.push(item);
  }
  grouped.commerce.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  grouped.shipping.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return grouped;
}

async function getCompanyBootstrap({ companyId, employeeId }) {
  const id = String(companyId || "").trim();
  const empId = String(employeeId || "").trim();
  if (!id || !empId) {
    const error = new Error("Authenticated company context is missing");
    error.code = "TENANT_CONTEXT_MISSING";
    throw error;
  }

  const [company, employee, features, integrations] = await Promise.all([
    loadCompany(id),
    loadEmployee(id, empId),
    loadFeatureMap(id),
    loadIntegrations(id),
  ]);

  return {
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      active: company.is_active !== false,
    },
    branding: toBranding(company),
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: normalizeRole(employee.role),
    },
    features,
    integrations,
  };
}

module.exports = {
  getCompanyBootstrap,
};
