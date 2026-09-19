const supabase = require("../config/supabase");
const { requireActiveCompanyId } = require("../utils/tenantScope");
const { createConnection } = require("./companyIntegrations.service");

const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";
const SOURCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  const error = new Error("Historical migration source not found");
  error.code = "IMPORT_SOURCE_NOT_FOUND";
  return error;
}

function toImportSourceView(row) {
  return {
    id: row.id,
    provider: "spreadsheet",
    category: "commerce",
    name: row.name,
    isEnabled: row.isEnabled != null ? Boolean(row.isEnabled) : Boolean(row.enabled ?? row.is_enabled),
  };
}

async function listImportSources() {
  const companyId = requireActiveCompanyId();
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("id,provider,category,name,is_enabled")
    .eq("company_id", companyId)
    .eq("provider", "spreadsheet");
  if (error) throw new Error(error.message);
  return (data || [])
    .map(toImportSourceView)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function getOwnedSpreadsheetRow(sourceId) {
  const companyId = requireActiveCompanyId();
  const id = String(sourceId || "").trim();
  if (!SOURCE_UUID.test(id)) {
    throw notFound();
  }
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("id", id)
    .eq("company_id", companyId)
    .eq("provider", "spreadsheet")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound();
  return data;
}

async function getImportSource(sourceId) {
  const row = await getOwnedSpreadsheetRow(sourceId);
  return toImportSourceView(row);
}

async function createImportSource(body = {}) {
  const companyId = requireActiveCompanyId();
  const name = String(body.name || body.label || "").trim();
  if (!name) {
    const error = new Error("name is required");
    error.code = "IMPORT_SOURCE_NAME_REQUIRED";
    throw error;
  }
  const enabled =
    body.isEnabled != null || body.enabled != null || body.is_enabled != null
      ? Boolean(body.isEnabled ?? body.enabled ?? body.is_enabled)
      : true;

  const created = await createConnection(companyId, {
    name,
    provider: "spreadsheet",
    category: "commerce",
    enabled,
  });
  return toImportSourceView(created);
}

async function updateImportSource(sourceId, body = {}) {
  const companyId = requireActiveCompanyId();
  await getOwnedSpreadsheetRow(sourceId);

  const updates = {};
  if (body.name != null || body.label != null) {
    const name = String(body.name || body.label || "").trim();
    if (!name) {
      const error = new Error("name is required");
      error.code = "IMPORT_SOURCE_NAME_REQUIRED";
      throw error;
    }
    updates.name = name;
  }
  if (body.isEnabled != null || body.enabled != null || body.is_enabled != null) {
    updates.is_enabled = Boolean(body.isEnabled ?? body.enabled ?? body.is_enabled);
  }

  if (!Object.keys(updates).length) {
    return getImportSource(sourceId);
  }

  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .update(updates)
    .eq("id", String(sourceId).trim())
    .eq("company_id", companyId)
    .eq("provider", "spreadsheet")
    .select("id,provider,category,name,is_enabled")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw notFound();
  return toImportSourceView(data);
}

module.exports = {
  listImportSources,
  getImportSource,
  createImportSource,
  updateImportSource,
};
