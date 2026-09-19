const DEFAULT_SHOPIFY_ADMIN_API_VERSION = "2026-07";
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

function getShopifyAdminApiVersion() {
  const raw = String(process.env.SHOPIFY_ADMIN_API_VERSION || "").trim();
  return raw || DEFAULT_SHOPIFY_ADMIN_API_VERSION;
}

function getShopifyAdminApiTimeoutMs() {
  return DEFAULT_TIMEOUT_MS;
}

function getShopifyAdminApiMaxRetries() {
  return MAX_RETRIES;
}

function shopifyGraphqlUrl(canonicalShopDomain, version = getShopifyAdminApiVersion()) {
  return `https://${canonicalShopDomain}/admin/api/${version}/graphql.json`;
}

module.exports = {
  DEFAULT_SHOPIFY_ADMIN_API_VERSION,
  getShopifyAdminApiVersion,
  getShopifyAdminApiTimeoutMs,
  getShopifyAdminApiMaxRetries,
  shopifyGraphqlUrl,
};
