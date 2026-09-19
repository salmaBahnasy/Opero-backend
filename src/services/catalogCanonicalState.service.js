/**
 * Tenant-safe canonical catalog state for one-product planning (C1K).
 *
 * Loads the target product's canonical rows plus company-wide SKU/barcode
 * occupancy from OTHER variants so the planner can avoid 23505 collisions.
 * Does not write. Does not call providers.
 */

const tenantSupabase = require("../config/tenantSupabase");

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function requireId(value, label) {
  const id = trimText(value);
  if (!id) {
    const error = new Error(`${label} is required`);
    error.code = "CATALOG_WRITE_TENANT_MISMATCH";
    throw error;
  }
  return id;
}

function asClient(client) {
  return client || tenantSupabase;
}

async function selectEq(client, table, columns, filters) {
  let query = client.from(table).select(columns);
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value);
  }
  const { data, error } = await query;
  if (error) {
    const err = new Error(error.message || `Failed to load ${table}`);
    err.code = error.code || "CATALOG_STATE_LOAD_FAILED";
    throw err;
  }
  return data || [];
}

function occupancyKey(companyId, value) {
  return `${companyId}::${trimText(value)}`;
}

function bumpOccupancy(map, companyId, value) {
  const text = trimText(value);
  if (!text) return;
  const key = occupancyKey(companyId, text);
  map.set(key, (map.get(key) || 0) + 1);
}

function incomingVariantIdSet(ids) {
  const set = new Set();
  for (const value of ids || []) {
    const text = trimText(value);
    if (text) set.add(text);
  }
  return set;
}

/**
 * Variants currently mapped to incoming provider identities are excluded so
 * UPDATE/REUSE can keep its own SKU. Other company variants occupy the SKU.
 */
function occupancyFromVariants({
  companyId,
  productId,
  variants = [],
  mappings = [],
  incomingExternalVariantIds = [],
  integrationId = "",
} = {}) {
  const incoming = incomingVariantIdSet(incomingExternalVariantIds);
  const retainIds = new Set();
  const wantedIntegration = trimText(integrationId);
  for (const mapping of mappings) {
    if (trimText(mapping.company_id) !== trimText(companyId)) continue;
    if (trimText(mapping.internal_product_id) !== trimText(productId)) continue;
    if (wantedIntegration && trimText(mapping.integration_id) !== wantedIntegration) {
      continue;
    }
    if (!incoming.has(trimText(mapping.external_variant_id))) continue;
    if (mapping.internal_variant_id) retainIds.add(String(mapping.internal_variant_id));
  }

  const skuCounts = new Map();
  const barcodeCounts = new Map();
  for (const row of variants || []) {
    if (trimText(row.company_id) !== trimText(companyId)) continue;
    if (retainIds.has(String(row.id))) continue;
    bumpOccupancy(skuCounts, companyId, row.internal_sku);
    bumpOccupancy(barcodeCounts, companyId, row.barcode);
  }
  return { skuCounts, barcodeCounts };
}

async function loadCanonicalPlanningState({
  companyId,
  productId,
  integrationId,
  incomingExternalVariantIds = [],
  client,
} = {}) {
  const trustedCompanyId = requireId(companyId, "companyId");
  const trustedProductId = requireId(productId, "productId");
  const db = asClient(client);

  const [productVariants, options, optionValues, sourceMappings, companyVariants] =
    await Promise.all([
      selectEq(db, "product_variants", "*", {
        company_id: trustedCompanyId,
        product_id: trustedProductId,
      }),
      selectEq(db, "product_options", "*", {
        company_id: trustedCompanyId,
        product_id: trustedProductId,
      }),
      selectEq(db, "product_option_values", "*", {
        company_id: trustedCompanyId,
        product_id: trustedProductId,
      }),
      selectEq(db, "catalog_source_mappings", "*", {
        company_id: trustedCompanyId,
        internal_product_id: trustedProductId,
      }),
      selectEq(
        db,
        "product_variants",
        "id,company_id,product_id,internal_sku,barcode",
        { company_id: trustedCompanyId },
      ),
    ]);

  const occupancy = occupancyFromVariants({
    companyId: trustedCompanyId,
    productId: trustedProductId,
    variants: companyVariants,
    mappings: sourceMappings,
    incomingExternalVariantIds,
    integrationId,
  });

  return {
    existing: {
      variants: productVariants,
      options,
      optionValues,
      sourceMappings,
    },
    occupancy,
  };
}

module.exports = {
  occupancyFromVariants,
  loadCanonicalPlanningState,
};
