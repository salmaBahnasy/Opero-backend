const express = require("express");
const {
  postAddedOrder,
  getAddedOrders,
} = require("../controllers/addedOrders.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");

const router = express.Router();
const requireTenant = [
  requireAuth,
  bindTenantScope,
  requireCompanyFeature("orders"),
];

router.post("/", ...requireTenant, postAddedOrder);
router.get("/", ...requireTenant, getAddedOrders);

module.exports = router;
