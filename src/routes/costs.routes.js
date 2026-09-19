const express = require("express");
const router = express.Router();

const {
  getOrderCosts,
  getOrderCostChartHandler,
  saveOrderCostDailyHandler,
} = require("../controllers/orders.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");

const requireTenant = [
  requireAuth,
  bindTenantScope,
  requireCompanyFeature("orders"),
];

router.get("/", ...requireTenant, getOrderCosts);
router.get("/chart", ...requireTenant, getOrderCostChartHandler);
router.post("/daily", ...requireTenant, saveOrderCostDailyHandler);

module.exports = router;
