const { getCompanyId } = require("./tenant.middleware");
const { companyHasFeature } = require("../services/companyFeatures.service");
const { sendInternalError } = require("../utils/safeError");

function requireCompanyFeature(featureKey) {
  const key = String(featureKey || "").trim();
  return async function requireCompanyFeatureMiddleware(req, res, next) {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) {
        res.status(401).json({
          success: false,
          message: "Unauthorized. Token must include companyId.",
        });
        return;
      }
      const enabled = await companyHasFeature(companyId, key);
      if (!enabled) {
        res.status(403).json({
          success: false,
          code: "FEATURE_REQUIRED",
          message: `This company does not have the ${key} feature enabled.`,
          feature: key,
        });
        return;
      }
      next();
    } catch (error) {
      sendInternalError(res, "Failed to resolve company features", error, "features");
    }
  };
}

module.exports = {
  requireCompanyFeature,
};
