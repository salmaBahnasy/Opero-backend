const express = require("express");

const {
  syncProducts,
  getProducts,
  getEasyOrderProductById,
} = require("../controllers/products.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");

const router = express.Router();
const requireTenant = [requireAuth, bindTenantScope];

router.post("/sync", ...requireTenant, syncProducts);
router.get("/", ...requireTenant, getProducts);
router.get("/:productId", ...requireTenant, getEasyOrderProductById);

module.exports = router;
