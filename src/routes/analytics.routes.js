const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope, getCompanyId } = require("../middlewares/tenant.middleware");
const { companyHasFeature } = require("../services/companyFeatures.service");
const {
  getOverview,
  getTrend,
  getStatuses,
  getStores,
  getProducts,
} = require("../controllers/analytics.controller");

async function requireAnalyticsFeature(req, res, next) {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized. Token must include companyId.",
      });
      return;
    }
    const enabled = await companyHasFeature(companyId, "analytics");
    if (!enabled) {
      res.status(403).json({
        success: false,
        code: "FEATURE_REQUIRED",
        message: "This company does not have the analytics feature enabled.",
        feature: "analytics",
      });
      return;
    }
    next();
  } catch (error) {
    console.error("analytics feature check failed", error);
    res.status(500).json({
      success: false,
      message: "Failed to load analytics",
    });
  }
}

const requireAnalytics = [requireAuth, bindTenantScope, requireAnalyticsFeature];

router.get("/overview", ...requireAnalytics, getOverview);
router.get("/trend", ...requireAnalytics, getTrend);
router.get("/statuses", ...requireAnalytics, getStatuses);
router.get("/stores", ...requireAnalytics, getStores);
router.get("/products", ...requireAnalytics, getProducts);

module.exports = router;
