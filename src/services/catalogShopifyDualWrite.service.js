/**
 * Shopify canonical dual-write after a successful legacy products persist (C1K).
 *
 * Gate default OFF. Uses the generic planner + writeCatalogProductPlan.
 * Does not call Shopify APIs. Does not retry catalog RPC.
 */

const { isShopifyCatalogDualWriteEnabled } = require("./catalogDualWrite.gate");
const { loadCanonicalPlanningState } = require("./catalogCanonicalState.service");
const {
  isShopifyVariantsComplete,
  incomingShopifyVariantIds,
  planLegacyCatalogProduct,
} = require("./catalogPlanning.adapter");
const { writeCatalogProductPlan } = require("./catalogWriter.service");

const CANONICAL_STATUS = {
  WRITTEN: "written",
  REUSED: "reused",
  BLOCKED: "blocked",
  FAILED: "failed",
  SKIPPED_GATE_OFF: "skipped_gate_off",
  NOT_ATTEMPTED: "not_attempted",
};

const SECRET_PATTERN =
  /secret|token|password|service_role|apikey|authorization|sb_secret|eyJ/i;

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function emptyResult(overrides = {}) {
  return {
    legacyProductId: null,
    externalProductId: null,
    legacyStatus: null,
    canonicalStatus: CANONICAL_STATUS.NOT_ATTEMPTED,
    diagnostics: [],
    canonicalResult: null,
    canonicalError: null,
    writerInvoked: false,
    ...overrides,
  };
}

function safeDiagnostics(diagnostics) {
  return (diagnostics || []).map((item) => ({
    code: item?.code || null,
    severity: item?.severity || null,
    message: trimText(item?.message),
    integration_id: item?.integration_id || null,
    external_product_id: item?.external_product_id || null,
    external_variant_id:
      item?.external_variant_id == null ? undefined : item.external_variant_id,
    internal_variant_id: item?.internal_variant_id || null,
  })).map((item) => {
    const out = {
      code: item.code,
      severity: item.severity,
      message: item.message,
    };
    if (item.integration_id) out.integration_id = item.integration_id;
    if (item.external_product_id) out.external_product_id = item.external_product_id;
    if (item.external_variant_id != null) out.external_variant_id = item.external_variant_id;
    if (item.internal_variant_id) out.internal_variant_id = item.internal_variant_id;
    return out;
  });
}

function sanitizeCanonicalError(error) {
  if (!error) return null;
  const code = trimText(error.code) || "CATALOG_WRITE_FAILED";
  let message = trimText(error.message) || "Canonical catalog write failed";
  if (SECRET_PATTERN.test(message)) {
    message = "Canonical catalog write failed";
  }
  return { code, message };
}

function toPlanningProduct({
  companyId,
  productId,
  sourceIntegrationId,
  normalized,
}) {
  return {
    id: productId,
    company_id: companyId,
    source_integration_id: sourceIntegrationId,
    easyorder_id: normalized?.easyorder_id,
    sku: normalized?.sku ?? null,
    raw_data: normalized?.raw_data || {},
  };
}

function statusFromPlan(plan, writeResult) {
  const variantActions = (plan?.variants || []).map((row) => row.action);
  const mappingActions = (plan?.source_mappings || []).map((row) => row.action);
  const allReuse =
    variantActions.length > 0 &&
    variantActions.every((action) => action === "REUSE") &&
    mappingActions.every((action) => action === "REUSE");
  if (allReuse && writeResult) return CANONICAL_STATUS.REUSED;
  return CANONICAL_STATUS.WRITTEN;
}

async function writeShopifyCatalogDualWrite({
  companyId,
  integration,
  productId,
  externalProductId,
  normalized,
  variantsComplete,
  catalogWriter,
  canonicalStateLoader,
  env,
} = {}) {
  const trustedCompanyId = trimText(companyId);
  const sourceIntegrationId = trimText(integration?.id);
  const legacyProductId = trimText(productId);
  const externalId = trimText(externalProductId || normalized?.easyorder_id);

  if (!isShopifyCatalogDualWriteEnabled(trustedCompanyId, env)) {
    return emptyResult({
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.SKIPPED_GATE_OFF,
    });
  }

  if (!legacyProductId) {
    return emptyResult({
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.NOT_ATTEMPTED,
      canonicalError: {
        code: "CATALOG_WRITE_INVALID_PLAN",
        message: "Canonical write requires the persisted legacy products.id",
      },
    });
  }

  if (trimText(integration?.company_id) && trimText(integration.company_id) !== trustedCompanyId) {
    return emptyResult({
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.FAILED,
      canonicalError: {
        code: "CATALOG_WRITE_TENANT_MISMATCH",
        message: "Integration connection is not owned by this company",
      },
    });
  }

  const planningProduct = toPlanningProduct({
    companyId: trustedCompanyId,
    productId: legacyProductId,
    sourceIntegrationId,
    normalized,
  });
  const complete =
    variantsComplete === true && isShopifyVariantsComplete(planningProduct);

  if (!complete) {
    return emptyResult({
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.BLOCKED,
      diagnostics: [
        {
          code: "TRUNCATED_PROVIDER_VARIANTS",
          severity: "ERROR",
          message:
            "Shopify variant list is truncated; identity cannot be trusted for canonical write",
        },
      ],
    });
  }

  const loadState = canonicalStateLoader || loadCanonicalPlanningState;
  let state;
  try {
    state = await loadState({
      companyId: trustedCompanyId,
      productId: legacyProductId,
      integrationId: sourceIntegrationId,
      incomingExternalVariantIds: incomingShopifyVariantIds(planningProduct),
    });
  } catch (error) {
    return emptyResult({
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.FAILED,
      canonicalError: sanitizeCanonicalError(error),
    });
  }

  const { plan } = planLegacyCatalogProduct({
    product: planningProduct,
    companyId: trustedCompanyId,
    integrations: [integration],
    existing: state.existing || {},
    occupancy: state.occupancy || {},
  });

  if (!plan || plan.status === "BLOCKED") {
    return emptyResult({
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.BLOCKED,
      diagnostics: safeDiagnostics(plan?.diagnostics),
    });
  }

  const writer = catalogWriter || writeCatalogProductPlan;
  try {
    const canonicalResult = await writer(plan, {
      companyId: trustedCompanyId,
      integrations: [integration],
    });
    return {
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: statusFromPlan(plan, canonicalResult),
      diagnostics: safeDiagnostics(plan.diagnostics),
      canonicalResult: canonicalResult || null,
      canonicalError: null,
      writerInvoked: true,
      plan,
    };
  } catch (error) {
    return {
      legacyProductId,
      externalProductId: externalId,
      canonicalStatus: CANONICAL_STATUS.FAILED,
      diagnostics: safeDiagnostics(plan.diagnostics),
      canonicalResult: null,
      canonicalError: sanitizeCanonicalError(error),
      writerInvoked: true,
      plan,
    };
  }
}

function emptyCanonicalAggregates() {
  return {
    canonicalSuccess: 0,
    canonicalFailed: 0,
    canonicalBlocked: 0,
    canonicalSkipped: 0,
  };
}

function addCanonicalAggregate(aggregates, result) {
  const next = aggregates || emptyCanonicalAggregates();
  const status = result?.canonicalStatus;
  if (status === CANONICAL_STATUS.WRITTEN || status === CANONICAL_STATUS.REUSED) {
    next.canonicalSuccess += 1;
  } else if (status === CANONICAL_STATUS.FAILED) {
    next.canonicalFailed += 1;
  } else if (status === CANONICAL_STATUS.BLOCKED) {
    next.canonicalBlocked += 1;
  } else if (status === CANONICAL_STATUS.SKIPPED_GATE_OFF) {
    next.canonicalSkipped += 1;
  }
  return next;
}

module.exports = {
  CANONICAL_STATUS,
  sanitizeCanonicalError,
  writeShopifyCatalogDualWrite,
  emptyCanonicalAggregates,
  addCanonicalAggregate,
  toPlanningProduct,
};
