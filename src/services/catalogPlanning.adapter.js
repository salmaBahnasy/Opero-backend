/**
 * Catalog planning adapter (C1F).
 *
 * Bridges:
 *   legacy products.raw_data
 *   OR C1E EasyOrders enriched snapshots
 * into the existing C1C planner input (product rows).
 *
 * Pure: no provider HTTP, no DB writes, no credential access.
 * Does not enable catalog commit.
 */

const {
  planCatalogBackfill,
  parseRawData,
  productStatus,
  SEVERITY,
} = require("./catalogBackfill.service");

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function catalogPlanningIdentityKey({
  companyId,
  sourceIntegrationId,
  externalProductId,
}) {
  return `${trimText(companyId)}::${trimText(sourceIntegrationId)}::${trimText(
    externalProductId,
  )}`;
}

function snapshotIsComplete(snapshot) {
  const row = asObject(snapshot);
  if (!row) return false;
  if (row.incomplete === true) return false;
  if (row.variantsComplete !== true) return false;
  const variants = Array.isArray(row.variants) ? row.variants : [];
  if (!variants.length) return false;
  return variants.every((variant) => trimText(variant?.externalVariantId));
}

function snapshotWasAttempted(snapshot) {
  return asObject(snapshot) != null;
}

function toPlannerVariant(variant) {
  const options = Array.isArray(variant?.options) ? variant.options : [];
  const pairs = options
    .map((option) => ({
      name: trimText(option?.name),
      value: trimText(option?.value),
    }))
    .filter((pair) => pair.name && pair.value);
  return {
    id: trimText(variant?.externalVariantId),
    sku: variant?.sku ?? null,
    price: variant?.price ?? null,
    sale_price: variant?.price ?? null,
    quantity: variant?.quantity ?? null,
    is_default: Boolean(variant?.isDefault),
    variation_props: pairs.map((pair) => ({
      variation: pair.name,
      variation_prop: pair.value,
    })),
    selected_options: pairs.map((pair) => ({
      name: pair.name,
      value: pair.value,
    })),
  };
}

/**
 * Preserve products.id. Match only by company + source integration +
 * easyorder_id / externalProductId. Never by SKU.
 */
function snapshotsMatchLegacyProduct(legacyProduct, snapshot) {
  const product = asObject(legacyProduct);
  const row = asObject(snapshot);
  if (!product || !row) return false;
  const externalId = trimText(row.externalProductId);
  const productExternal = trimText(product.easyorder_id);
  if (!externalId || !productExternal || externalId !== productExternal) {
    return false;
  }
  return true;
}

function toCatalogPlanningProduct(legacyProduct, snapshot = null) {
  const product = asObject(legacyProduct) || {};
  const planningBase = {
    source: snapshot ? "enriched" : "legacy",
    enrichmentAttempted: snapshotWasAttempted(snapshot),
    variantsComplete: snapshot ? snapshotIsComplete(snapshot) : null,
  };

  if (!snapshot || !snapshotsMatchLegacyProduct(product, snapshot)) {
    return {
      ...product,
      id: product.id,
      planning: {
        source: "legacy",
        enrichmentAttempted: false,
        variantsComplete: null,
      },
    };
  }

  if (!snapshotIsComplete(snapshot)) {
    return {
      ...product,
      id: product.id,
      planning: {
        ...planningBase,
        variantsComplete: false,
      },
    };
  }

  const variants = (snapshot.variants || []).map(toPlannerVariant);
  const previous = parseRawData(product.raw_data);
  return {
    ...product,
    id: product.id,
    easyorder_id: trimText(snapshot.externalProductId) || product.easyorder_id,
    sku: snapshot.sku != null ? snapshot.sku : product.sku,
    planning: {
      ...planningBase,
      variantsComplete: true,
      productType: snapshot.productType || null,
    },
    raw_data: {
      id: trimText(snapshot.externalProductId) || previous.id || null,
      name: snapshot.title || previous.name || previous.title || null,
      sku: snapshot.sku ?? previous.sku ?? product.sku ?? null,
      price: snapshot.price ?? previous.price ?? product.price ?? null,
      variants,
      provider: "easyorders",
    },
  };
}

function indexEasyOrdersSnapshots(snapshots = []) {
  const byIdentity = new Map();
  for (const entry of snapshots || []) {
    const wrapped = asObject(entry);
    if (!wrapped) continue;
    const snapshot = asObject(wrapped.snapshot) || wrapped;
    const companyId = wrapped.company_id || wrapped.companyId;
    const sourceIntegrationId =
      wrapped.source_integration_id || wrapped.sourceIntegrationId;
    const externalProductId =
      snapshot.externalProductId ||
      wrapped.externalProductId ||
      wrapped.external_product_id;
    if (!companyId || !sourceIntegrationId || !externalProductId) continue;
    byIdentity.set(
      catalogPlanningIdentityKey({
        companyId,
        sourceIntegrationId,
        externalProductId,
      }),
      snapshot,
    );
  }
  return byIdentity;
}

function attachEasyOrdersSnapshots(products = [], snapshots = []) {
  const byIdentity = indexEasyOrdersSnapshots(snapshots);
  return (products || []).map((product) => {
    const key = catalogPlanningIdentityKey({
      companyId: product?.company_id,
      sourceIntegrationId: product?.source_integration_id,
      externalProductId: product?.easyorder_id,
    });
    return toCatalogPlanningProduct(product, byIdentity.get(key) || null);
  });
}

/**
 * Dry-run orchestration: legacy rows + injected C1E snapshots → C1C planner.
 * Snapshots must be supplied by the caller. This never fetches providers.
 */
function planCatalogBackfillFromEasyOrdersSnapshots({
  products = [],
  integrations = [],
  existing = {},
  occupancy = {},
  bostaMappings = [],
  snapshots = [],
} = {}) {
  return planCatalogBackfill({
    products: attachEasyOrdersSnapshots(products, snapshots),
    integrations,
    existing,
    occupancy,
    bostaMappings,
  });
}

function isShopifyVariantsComplete(productOrRaw) {
  const raw =
    asObject(parseRawData(productOrRaw?.raw_data)) ||
    asObject(productOrRaw) ||
    {};
  const shopify = asObject(raw.shopify) || {};
  if (shopify.variants_truncated === true) return false;
  if (shopify.variants_complete !== true) return false;
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  if (!variants.length) return false;
  return variants.every((variant) => trimText(variant?.id || variant?.variant_id));
}

function incomingShopifyVariantIds(product) {
  const raw = asObject(parseRawData(product?.raw_data)) || {};
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  return variants
    .map((variant) => trimText(variant?.id || variant?.variant_id))
    .filter(Boolean);
}

function toLegacyPlanningProduct(legacyProduct, { companyId } = {}) {
  const product = asObject(legacyProduct) || {};
  return {
    ...product,
    id: product.id,
    company_id: trimText(companyId) || product.company_id,
    planning: {
      source: "legacy",
      enrichmentAttempted: false,
      variantsComplete: isShopifyVariantsComplete(product) ? true : null,
    },
  };
}

function attachStaleProviderVariantDiagnostics(
  plan,
  {
    mappings = [],
    incomingExternalVariantIds = [],
    integrationId,
    complete,
  } = {},
) {
  if (!plan || complete === false) return plan;
  const incoming = new Set(
    (incomingExternalVariantIds || []).map((value) => trimText(value)).filter(Boolean),
  );
  const wantedIntegration = trimText(integrationId || plan.integration_id);
  for (const mapping of mappings || []) {
    if (wantedIntegration && trimText(mapping.integration_id) !== wantedIntegration) {
      continue;
    }
    if (incoming.has(trimText(mapping.external_variant_id))) continue;
    plan.diagnostics = plan.diagnostics || [];
    plan.diagnostics.push({
      code: "STALE_PROVIDER_VARIANT",
      severity: SEVERITY.WARNING,
      message:
        "Provider variant is absent from the current complete snapshot; canonical row was left unchanged",
      integration_id: mapping.integration_id || null,
      external_product_id: mapping.external_product_id || null,
      external_variant_id: mapping.external_variant_id ?? "",
      internal_variant_id: mapping.internal_variant_id || null,
    });
  }
  plan.status = productStatus(plan.diagnostics || []);
  return plan;
}

/**
 * One persisted legacy products row → existing C1C planner.
 * Provider-specific GraphQL/normalization stays outside this function.
 */
function planLegacyCatalogProduct({
  product,
  companyId,
  integrations = [],
  existing = {},
  occupancy = {},
  bostaMappings = [],
  attachStale = true,
} = {}) {
  const planningProduct = toLegacyPlanningProduct(product, { companyId });
  const complete = isShopifyVariantsComplete(planningProduct);
  const report = planCatalogBackfill({
    products: [planningProduct],
    integrations,
    existing,
    occupancy,
    bostaMappings,
  });
  const plan = report.plans[0] || null;
  if (!plan) return { plan: null, report, complete };
  if (attachStale && complete) {
    attachStaleProviderVariantDiagnostics(plan, {
      mappings: existing.sourceMappings || existing.source_mappings || [],
      incomingExternalVariantIds: incomingShopifyVariantIds(planningProduct),
      integrationId: planningProduct.source_integration_id,
      complete: true,
    });
  }
  return { plan, report, complete };
}

module.exports = {
  catalogPlanningIdentityKey,
  snapshotIsComplete,
  snapshotsMatchLegacyProduct,
  toCatalogPlanningProduct,
  attachEasyOrdersSnapshots,
  planCatalogBackfillFromEasyOrdersSnapshots,
  isShopifyVariantsComplete,
  incomingShopifyVariantIds,
  toLegacyPlanningProduct,
  attachStaleProviderVariantDiagnostics,
  planLegacyCatalogProduct,
};
