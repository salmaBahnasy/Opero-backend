const express = require("express");

const {
  syncProducts,
  getProducts,
  getProductOptions,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/products.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");

const router = express.Router();
const requireTenant = [
  requireAuth,
  bindTenantScope,
  requireCompanyFeature("products"),
];

router.post("/sync", ...requireTenant, syncProducts);
router.get("/", ...requireTenant, getProducts);
router.get("/options", ...requireTenant, getProductOptions);
router.post("/", ...requireTenant, createProduct);
router.get("/:productId", ...requireTenant, getProductById);
router.patch("/:productId", ...requireTenant, updateProduct);
router.put("/:productId", ...requireTenant, updateProduct);
router.delete("/:productId", ...requireTenant, deleteProduct);

module.exports = router;
