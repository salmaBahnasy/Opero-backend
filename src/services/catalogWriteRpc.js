/**
 * Catalog write RPC adapter (C1I-B).
 *
 * Builds apply_catalog_product_plan args from a reviewed planner plan and
 * executes them through an injected rpc() or the backend service-role client.
 *
 * Tests must inject rpc(). NODE_ENV=test never uses the live SaaS Development RPC.
 * Does not parse provider payloads, retry mutations, or enable CLI commit.
 */

const {
  assertWriteEligible,
  assertIntegrationOwnership,
  WRITE_CODE,
} = require("./catalogWriter.service");

const APPLY_CATALOG_PRODUCT_PLAN_RPC = "apply_catalog_product_plan";
const ALLOWED_SAAS_DEV_HOST = "iydepmuniwybqgejawhf.supabase.co";
const CATALOG_RPC_CODES = new Set([
  "CATALOG_PRODUCT_NOT_FOUND",
  "CATALOG_TENANT_MISMATCH",
  "CATALOG_INVALID_PRODUCT_TYPE",
  "CATALOG_INVALID_OPERATION",
  "CATALOG_INVALID_DEFAULT_VARIANT_COUNT",
  "CATALOG_VARIANT_NOT_FOUND",
  "CATALOG_OPTION_NOT_FOUND",
  "CATALOG_OPTION_VALUE_NOT_FOUND",
  "CATALOG_INTEGRATION_NOT_FOUND",
  "CATALOG_MAPPING_CONFLICT",
]);
const NATIVE_PG_GUARDS = new Set(["23505", "23503", "22003"]);

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function sameId(a, b) {
  return String(a || "") === String(b || "");
}

function operationOf(row) {
  return trimText(row?.operation || row?.action).toLowerCase();
}

function catalogRpcError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function sanitizeRpcDetails(details) {
  if (!details || typeof details !== "object") return details ?? null;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (/secret|token|password|service_role|apikey|authorization/i.test(key)) continue;
    if (typeof value === "string" && /service_role|eyJ|sb_secret/i.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function extractCatalogCode(error) {
  const hint = trimText(error?.hint);
  if (CATALOG_RPC_CODES.has(hint)) return hint;
  const message = trimText(error?.message);
  const match = message.match(/\b(CATALOG_[A-Z0-9_]+)\b/);
  if (match && CATALOG_RPC_CODES.has(match[1])) return match[1];
  const code = trimText(error?.code);
  if (CATALOG_RPC_CODES.has(code)) return code;
  return "";
}

function normalizeCatalogRpcError(error) {
  const sqlState = trimText(error?.code);
  const message = trimText(error?.message) || "apply_catalog_product_plan failed";
  const details = sanitizeRpcDetails(error);
  const catalogCode = extractCatalogCode(error);
  if (catalogCode) {
    return catalogRpcError(catalogCode, message, { sqlState: sqlState || null, details });
  }
  if (NATIVE_PG_GUARDS.has(sqlState)) {
    return catalogRpcError(sqlState, message, { sqlState, details });
  }
  return catalogRpcError(WRITE_CODE.FAILED, message, {
    sqlState: sqlState || null,
    details,
  });
}

function buildApplyCatalogProductPlanArgs(plan, { companyId } = {}) {
  assertWriteEligible(plan, { companyId });
  const variants = (plan.variants || []).map((row) => ({
    operation: operationOf(row),
    key: row.variant_key,
    id: row.existing_variant_id || null,
    title: row.title ?? null,
    internal_sku: row.internal_sku ?? null,
    barcode: row.barcode ?? null,
    price: row.price ?? null,
    compare_at_price: row.compare_at_price ?? null,
    is_default: Boolean(row.is_default),
    is_active: row.is_active == null ? true : Boolean(row.is_active),
    position: Number(row.position || 0),
    raw_data: asObject(row.raw_data) || {},
  }));
  const options = (plan.options || []).map((row) => ({
    operation: operationOf(row),
    key: row.name,
    id: row.existing_option_id || null,
    name: row.name,
    position: Number(row.position || 0),
  }));
  const option_values = (plan.option_values || []).map((row) => ({
    operation: operationOf(row),
    key: row.value,
    id: row.existing_option_value_id || null,
    option_key: row.option_name,
    value_key: row.value,
    value: row.value,
    position: Number(row.position || 0),
  }));
  const variant_option_values = [];
  for (const variant of plan.variants || []) {
    const pairs = Array.isArray(variant.option_pairs) ? variant.option_pairs : [];
    for (const pair of pairs) {
      const name = trimText(pair?.name);
      const value = trimText(pair?.value);
      if (!name || !value) continue;
      variant_option_values.push({
        operation: "create",
        variant_key: variant.variant_key,
        option_key: name,
        value_key: value,
        value,
      });
    }
  }
  const source_mappings = (plan.source_mappings || []).map((row) => ({
    operation: operationOf(row),
    id: row.existing_mapping_id || null,
    integration_id: row.integration_id,
    external_product_id: row.external_product_id,
    external_variant_id: row.external_variant_id ?? "",
    variant_key: row.variant_key,
    external_sku: row.external_sku ?? null,
    metadata: asObject(row.metadata) || {},
  }));

  return {
    p_company_id: companyId,
    p_product_id: plan.product_id,
    p_product_type: plan.planned_product_type,
    p_payload: {
      variants,
      options,
      option_values,
      variant_option_values,
      source_mappings,
    },
  };
}

function assertRpcResultShape(data, plan) {
  const row = asObject(data);
  if (!row) {
    throw catalogRpcError(
      WRITE_CODE.MALFORMED_RPC_RESULT,
      "apply_catalog_product_plan returned a non-object result",
    );
  }
  if (!sameId(row.productId, plan.product_id)) {
    throw catalogRpcError(
      WRITE_CODE.MALFORMED_RPC_RESULT,
      "apply_catalog_product_plan productId does not match the planned product",
      { productId: row.productId, planned_product_id: plan.product_id },
    );
  }
  if (trimText(row.productType) !== trimText(plan.planned_product_type)) {
    throw catalogRpcError(
      WRITE_CODE.MALFORMED_RPC_RESULT,
      "apply_catalog_product_plan productType does not match the planned product type",
      { productType: row.productType, planned_product_type: plan.planned_product_type },
    );
  }
  if (!asObject(row.variants) || !asObject(row.options) || !asObject(row.optionValues)) {
    throw catalogRpcError(
      WRITE_CODE.MALFORMED_RPC_RESULT,
      "apply_catalog_product_plan variants/options/optionValues must be JSON objects",
    );
  }
  if (!Array.isArray(row.mappings)) {
    throw catalogRpcError(
      WRITE_CODE.MALFORMED_RPC_RESULT,
      "apply_catalog_product_plan mappings must be an array",
    );
  }
  return row;
}

function normalizeCatalogWriteResult(data) {
  return {
    productId: data.productId,
    productType: data.productType,
    variantIds: Object.values(data.variants),
    optionIds: data.options,
    optionValueIds: data.optionValues,
    sourceMappings: data.mappings,
  };
}

function productionSupabaseHost() {
  const urlText = trimText(process.env.SUPABASE_URL);
  if (!urlText) return "";
  try {
    return new URL(urlText).hostname;
  } catch {
    return "";
  }
}

function resolveCatalogRpc(rpc) {
  if (typeof rpc === "function") return rpc;
  if (process.env.NODE_ENV === "test") {
    throw catalogRpcError(
      WRITE_CODE.TRANSACTION_UNAVAILABLE,
      "tests must inject rpc(); live apply_catalog_product_plan is forbidden",
    );
  }
  const host = productionSupabaseHost();
  if (host !== ALLOWED_SAAS_DEV_HOST) {
    throw catalogRpcError(
      WRITE_CODE.TRANSACTION_UNAVAILABLE,
      "apply_catalog_product_plan adapter refuses hosts other than SaaS Development",
      { host },
    );
  }
  const supabase = require("../config/supabase");
  return (name, args) => supabase.rpc(name, args);
}

/**
 * Execute one reviewed plan through apply_catalog_product_plan.
 * Inject rpc() in tests. Production uses the backend service-role client once.
 * Mutation RPC is never retried automatically.
 */
async function applyCatalogProductPlanViaRpc(plan, { companyId, integrations, rpc } = {}) {
  const args = buildApplyCatalogProductPlanArgs(plan, { companyId });
  assertIntegrationOwnership(plan, { companyId, integrations: integrations || [] });
  const invoke = resolveCatalogRpc(rpc);
  const result = await invoke(APPLY_CATALOG_PRODUCT_PLAN_RPC, args);
  if (result?.error) {
    throw normalizeCatalogRpcError(result.error);
  }
  const data = assertRpcResultShape(result?.data, plan);
  return normalizeCatalogWriteResult(data);
}

module.exports = {
  APPLY_CATALOG_PRODUCT_PLAN_RPC,
  ALLOWED_SAAS_DEV_HOST,
  CATALOG_RPC_CODES,
  buildApplyCatalogProductPlanArgs,
  applyCatalogProductPlanViaRpc,
  normalizeCatalogRpcError,
};
