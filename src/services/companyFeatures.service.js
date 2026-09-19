const { loadFeatureMap } = require("./companyBootstrap.service");

async function companyHasFeature(companyId, featureKey) {
  const key = String(featureKey || "").trim();
  if (!key) return false;
  const map = await loadFeatureMap(companyId);
  return map[key] === true;
}

module.exports = {
  companyHasFeature,
  loadFeatureMap,
};
