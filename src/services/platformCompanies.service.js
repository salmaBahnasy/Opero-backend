const supabase = require("../config/supabase");
const { isCompanyAdmin, normalizeRole } = require("../utils/roles");

const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";
const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";
const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";
const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";
const FEATURES_TABLE = process.env.SUPABASE_FEATURES_TABLE || "features";
const COMPANY_FEATURES_TABLE =
  process.env.SUPABASE_COMPANY_FEATURES_TABLE || "company_features";

const PUBLIC_COLUMNS =
  "id,name,slug,logo_url,login_image_url,favicon_url,primary_color,secondary_color,timezone,currency,is_active,deleted_at,created_at,updated_at,plan_id,subscription_status";

const EMPLOYEE_SAFE_COLUMNS = "id,name,email,role,is_active";

const SUMMARY_PROVIDERS = [
  { provider: "shopify", label: "Shopify" },
  { provider: "easyorders", label: "EasyOrders" },
  { provider: "salla", label: "Salla" },
  { provider: "bosta", label: "Bosta" },
];

const FEATURE_GROUPS = {
  orders: "core",
  products: "core",
  employees: "core",
  analytics: "core",
  bosta: "operational",
  whatsapp: "operational",
  easyorders: "legacy",
  salla: "legacy",
  shopify: "legacy",
};

function platformError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function toPublicCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logo_url: row.logo_url ?? null,
    login_image_url: row.login_image_url ?? null,
    favicon_url: row.favicon_url ?? null,
    primary_color: row.primary_color ?? null,
    secondary_color: row.secondary_color ?? null,
    timezone: row.timezone ?? null,
    currency: row.currency ?? null,
    is_active: row.is_active !== false,
    deleted_at: row.deleted_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    plan_id: row.plan_id ?? null,
    subscription_status: row.subscription_status || "none",
  };
}

async function countForCompany(table, companyId) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId);
  if (error) throw error;
  return Number(count || 0);
}

async function loadCompanyOrThrow(companyId) {
  const id = String(companyId || "").trim();
  if (!id) {
    throw platformError("COMPANY_NOT_FOUND", "Company not found", 404);
  }
  const { data, error } = await supabase
    .from(COMPANIES_TABLE)
    .select(PUBLIC_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw platformError("COMPANY_NOT_FOUND", "Company not found", 404);
  }
  return data;
}

function buildIntegrationsSummary(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    const provider = String(row.provider || "").trim().toLowerCase();
    if (!provider) continue;
    const current = counts.get(provider) || { provider, connections: 0 };
    current.connections += 1;
    counts.set(provider, current);
  }

  const summary = SUMMARY_PROVIDERS.map((item) => {
    const current = counts.get(item.provider);
    const connections = current?.connections || 0;
    counts.delete(item.provider);
    return {
      provider: item.provider,
      label: item.label,
      connections,
      connected: connections > 0,
    };
  });

  for (const leftover of counts.values()) {
    summary.push({
      provider: leftover.provider,
      label: leftover.provider,
      connections: leftover.connections,
      connected: leftover.connections > 0,
    });
  }
  return summary;
}

async function loadIntegrationCountsByCompany() {
  const { data, error } = await supabase.from(INTEGRATIONS_TABLE).select("company_id");
  if (error) throw error;
  const counts = new Map();
  for (const row of data || []) {
    const id = String(row.company_id || "");
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

async function listCompaniesNewestFirst() {
  const { data, error } = await supabase
    .from(COMPANIES_TABLE)
    .select(PUBLIC_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const integrationCounts = await loadIntegrationCountsByCompany();
  return (data || []).map((row) => ({
    ...toPublicCompany(row),
    integrationsCount: integrationCounts.get(String(row.id)) || 0,
  }));
}

async function getCompanyOverview(companyId) {
  const company = await loadCompanyOrThrow(companyId);
  const [employees, products, orders, integrationResult] = await Promise.all([
    countForCompany(EMPLOYEES_TABLE, company.id),
    countForCompany(PRODUCTS_TABLE, company.id),
    countForCompany(ORDERS_TABLE, company.id),
    supabase
      .from(INTEGRATIONS_TABLE)
      .select("id,provider")
      .eq("company_id", company.id),
  ]);
  if (integrationResult.error) throw integrationResult.error;
  const integrationRows = integrationResult.data || [];

  return {
    ...toPublicCompany(company),
    usage: {
      employees,
      products,
      orders,
      integrations: integrationRows.length,
    },
    integrationsSummary: buildIntegrationsSummary(integrationRows),
  };
}

async function listCompanyEmployees(companyId) {
  await loadCompanyOrThrow(companyId);
  const { data, error } = await supabase
    .from(EMPLOYEES_TABLE)
    .select(EMPLOYEE_SAFE_COLUMNS)
    .eq("company_id", companyId);
  if (error) throw error;

  return (data || [])
    .map((row) => {
      const role = normalizeRole(row.role);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role,
        is_active: row.is_active !== false,
        isCompanyAdmin: isCompanyAdmin(role),
      };
    })
    .sort((a, b) => {
      if (a.isCompanyAdmin !== b.isCompanyAdmin) return a.isCompanyAdmin ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
}

function featureGroup(key) {
  return FEATURE_GROUPS[key] || "other";
}

async function listCompanyFeatures(companyId) {
  await loadCompanyOrThrow(companyId);
  const [{ data: catalog, error: catalogError }, { data: rows, error: rowsError }] =
    await Promise.all([
      supabase.from(FEATURES_TABLE).select("id,key,name,description,is_active"),
      supabase
        .from(COMPANY_FEATURES_TABLE)
        .select("feature_id,is_enabled")
        .eq("company_id", companyId),
    ]);
  if (catalogError) throw catalogError;
  if (rowsError) throw rowsError;

  const enabledByFeatureId = new Map(
    (rows || []).map((row) => [String(row.feature_id), Boolean(row.is_enabled)]),
  );

  return (catalog || [])
    .filter((feature) => feature?.key && feature.is_active !== false)
    .map((feature) => ({
      key: feature.key,
      name: feature.name || feature.key,
      description: feature.description || "",
      is_enabled: enabledByFeatureId.get(String(feature.id)) === true,
      group: featureGroup(feature.key),
    }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

async function setCompanyFeature(companyId, featureKey, isEnabled) {
  if (typeof isEnabled !== "boolean") {
    throw platformError(
      "INVALID_FEATURE_VALUE",
      "is_enabled must be a boolean",
      400,
    );
  }
  const key = String(featureKey || "").trim().toLowerCase();
  if (!key) {
    throw platformError("INVALID_FEATURE", "Unknown feature", 400);
  }

  const company = await loadCompanyOrThrow(companyId);
  const { data: feature, error: featureError } = await supabase
    .from(FEATURES_TABLE)
    .select("id,key,is_active")
    .eq("key", key)
    .maybeSingle();
  if (featureError) throw featureError;
  if (!feature || feature.is_active === false) {
    throw platformError("INVALID_FEATURE", "Unknown feature", 400);
  }

  const { error: upsertError } = await supabase.from(COMPANY_FEATURES_TABLE).upsert(
    {
      company_id: company.id,
      feature_id: feature.id,
      is_enabled: isEnabled,
    },
    { onConflict: "company_id,feature_id" },
  );
  if (upsertError) throw upsertError;

  return {
    key: feature.key,
    is_enabled: isEnabled,
    group: featureGroup(feature.key),
  };
}

module.exports = {
  PUBLIC_COLUMNS,
  listCompaniesNewestFirst,
  getCompanyOverview,
  listCompanyEmployees,
  listCompanyFeatures,
  setCompanyFeature,
  loadCompanyOrThrow,
  toPublicCompany,
  featureGroup,
};
