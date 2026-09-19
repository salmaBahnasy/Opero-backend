const supabase = require("../config/supabase");
const tenantSupabase = require("../config/tenantSupabase");
const {
  requireActiveCompanyId,
} = require("../utils/tenantScope");
const {
  integrationNotConfigured,
  integrationDisabled,
} = require("../utils/httpErrors");

const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";
const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";

const INTEGRATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return INTEGRATION_UUID.test(String(value || "").trim());
}

function invalidShippingIntegration() {
  const error = new Error("Invalid shippingIntegrationId");
  error.code = "INVALID_SHIPPING_INTEGRATION";
  error.status = 400;
  return error;
}

function integrationNotFound() {
  const error = new Error("Integration connection not found");
  error.code = "INTEGRATION_NOT_FOUND";
  error.status = 404;
  return error;
}

function integrationAmbiguous(provider = "bosta") {
  const error = new Error(
    `Multiple ${provider} connections exist. Pass shippingIntegrationId to select one.`,
  );
  error.code = "INTEGRATION_AMBIGUOUS";
  error.provider = provider;
  return error;
}

function pickShippingIntegrationId(source = {}) {
  return String(
    source.shippingIntegrationId ||
      source.shipping_integration_id ||
      source.integrationId ||
      source.integration_id ||
      "",
  ).trim();
}

async function listEnabledBostaRows(companyId) {
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("company_id", companyId)
    .eq("provider", "bosta")
    .eq("category", "shipping")
    .eq("is_enabled", true);
  if (error) throw new Error(error.message);
  return data || [];
}

async function getIntegrationRow(integrationId) {
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Resolve the Bosta shipping connection for the JWT company.
 * Explicit id: UUID + same-company + shipping/bosta + enabled.
 * Omitted: 0 → not configured, 1 → auto-select, 2+ → ambiguous.
 */
async function resolveBostaShippingConnection(integrationId, { required = false } = {}) {
  const companyId = requireActiveCompanyId();
  const id = String(integrationId || "").trim();

  if (id) {
    if (!isUuid(id)) throw invalidShippingIntegration();
    const row = await getIntegrationRow(id);
    if (!row || row.company_id !== companyId) throw integrationNotFound();
    if (row.provider !== "bosta" || row.category !== "shipping") {
      throw integrationNotFound();
    }
    if (!row.is_enabled) throw integrationDisabled("bosta");
    return row;
  }

  if (required) {
    const rows = await listEnabledBostaRows(companyId);
    if (!rows.length) throw integrationNotConfigured("bosta");
    if (rows.length > 1) throw integrationAmbiguous("bosta");
    return rows[0];
  }

  const rows = await listEnabledBostaRows(companyId);
  if (!rows.length) throw integrationNotConfigured("bosta");
  if (rows.length > 1) throw integrationAmbiguous("bosta");
  return rows[0];
}

function catalogProductNotFound() {
  const error = new Error("Catalog product not found");
  error.code = "CATALOG_PRODUCT_NOT_FOUND";
  error.status = 404;
  return error;
}

function catalogProductAmbiguous() {
  const error = new Error(
    "Multiple catalog products match this external product id. Pass source_integration_id or catalogProductId.",
  );
  error.code = "CATALOG_PRODUCT_AMBIGUOUS";
  error.status = 409;
  return error;
}

function invalidCatalogProduct() {
  const error = new Error("catalogProductId must be a products.id UUID");
  error.code = "INVALID_CATALOG_PRODUCT";
  error.status = 400;
  return error;
}

async function requireCatalogProductById(catalogProductId) {
  const id = String(catalogProductId || "").trim();
  if (!isUuid(id)) throw invalidCatalogProduct();
  const { data, error } = await tenantSupabase
    .from(PRODUCTS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw catalogProductNotFound();
  return data;
}

async function findCatalogProductsByExternalId(externalId, sourceIntegrationId) {
  const id = String(externalId || "").trim();
  if (!id) return [];
  let query = tenantSupabase.from(PRODUCTS_TABLE).select("*").eq("easyorder_id", id);
  if (sourceIntegrationId) {
    query = query.eq("source_integration_id", sourceIntegrationId);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Resolve a cart line / import key to a local products.id row.
 * UUID is tried as products.id first. Otherwise easyorder_id + optional source.
 */
async function resolveCatalogProduct({
  catalogProductId,
  externalId,
  sourceIntegrationId,
} = {}) {
  const catalogId = String(catalogProductId || "").trim();
  if (catalogId && isUuid(catalogId)) {
    return requireCatalogProductById(catalogId);
  }

  const external = String(externalId || catalogId || "").trim();
  if (isUuid(external)) {
    try {
      return await requireCatalogProductById(external);
    } catch (error) {
      if (error.code !== "CATALOG_PRODUCT_NOT_FOUND") throw error;
    }
  }

  if (!external) throw catalogProductNotFound();

  const source = String(sourceIntegrationId || "").trim() || null;
  const rows = await findCatalogProductsByExternalId(external, source);
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) throw catalogProductAmbiguous();
  throw catalogProductNotFound();
}

function pickLineExternalProductId(line) {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  return (
    String(
      line?.catalogProductId ??
        line?.catalog_product_id ??
        line?._catalogProductId ??
        line?.variant?.productId ??
        line?.variant?.product_id ??
        line?.product_id ??
        line?.productId ??
        product?.id ??
        product?.product_id ??
        product?.easyorder_id ??
        "",
    ).trim() || null
  );
}

async function resolveLineCatalogProduct(line, sourceIntegrationId) {
  const explicitCatalog = String(
    line?.catalogProductId ??
      line?.catalog_product_id ??
      line?._catalogProductId ??
      "",
  ).trim();
  const external = pickLineExternalProductId(line);
  return resolveCatalogProduct({
    catalogProductId: isUuid(explicitCatalog) ? explicitCatalog : "",
    externalId: external,
    sourceIntegrationId,
  });
}

module.exports = {
  INTEGRATION_UUID,
  isUuid,
  pickShippingIntegrationId,
  resolveBostaShippingConnection,
  requireCatalogProductById,
  resolveCatalogProduct,
  resolveLineCatalogProduct,
  listEnabledBostaRows,
};
