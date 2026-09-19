/**
 * Backend-only Shopify catalog dual-write rollout gate (C1K).
 *
 * Default OFF. Enabling requires BOTH:
 *   CATALOG_DUAL_WRITE_SHOPIFY = true-like
 *   CATALOG_DUAL_WRITE_COMPANY_IDS contains the trusted company UUID
 *
 * An empty allowlist never enables any company. There is no "all companies"
 * implicit mode in this phase.
 *
 * Not a frontend feature flag. Not a company_features row.
 */

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function envOf(env) {
  return env && typeof env === "object" ? env : process.env;
}

function parseTruthyEnv(value) {
  return TRUE_VALUES.has(trimText(value).toLowerCase());
}

function parseCompanyAllowlist(value) {
  const text = trimText(value);
  if (!text) return [];
  const seen = new Set();
  const ids = [];
  for (const part of text.split(/[\s,]+/)) {
    const id = trimText(part).toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isCatalogDualWriteShopifyConfigured(env = process.env) {
  const source = envOf(env);
  return parseTruthyEnv(source.CATALOG_DUAL_WRITE_SHOPIFY);
}

function catalogDualWriteCompanyAllowlist(env = process.env) {
  return parseCompanyAllowlist(envOf(env).CATALOG_DUAL_WRITE_COMPANY_IDS);
}

function isShopifyCatalogDualWriteEnabled(companyId, env = process.env) {
  if (!isCatalogDualWriteShopifyConfigured(env)) return false;
  const allowlist = catalogDualWriteCompanyAllowlist(env);
  if (!allowlist.length) return false;
  const id = trimText(companyId).toLowerCase();
  if (!id) return false;
  return allowlist.includes(id);
}

module.exports = {
  parseTruthyEnv,
  parseCompanyAllowlist,
  isCatalogDualWriteShopifyConfigured,
  catalogDualWriteCompanyAllowlist,
  isShopifyCatalogDualWriteEnabled,
};
