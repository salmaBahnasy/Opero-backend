const catalog = require("./catalog");

/**
 * Provider adapter registry.
 * Resolve a connection by integration UUID + company ownership, then use the
 * matching provider adapter. Never branch on company name.
 */
function getAdapter(provider) {
  return catalog.assertProvider(provider);
}

function isCommerce(provider) {
  return catalog.getProviderDefinition(provider)?.category === "commerce";
}

function isShipping(provider) {
  return catalog.getProviderDefinition(provider)?.category === "shipping";
}

module.exports = {
  ...catalog,
  getAdapter,
  isCommerce,
  isShipping,
};
