const express = require("express");

const {
  syncLocations,
  listCities,
  listDistricts,
  listZones,
} = require("../controllers/bostaLocations.controller");
const {
  listBostaSkuMappings,
  getBostaSkuMappingHandler,
  getBostaSkuMappingByIdHandler,
  getBostaSkuOptionsByProductHandler,
  addBostaSkuMappingHandler,
  updateBostaSkuMappingHandler,
  updateBostaSkuMappingByIdHandler,
  deleteBostaSkuMappingHandler,
  deleteBostaSkuMappingByIdHandler,
  deleteUnmappedProductHandler,
  importBostaSkuMappingsHandler,
} = require("../controllers/bostaSkuMappings.controller");
const { checkBostaFulfillmentHealth } = require("../controllers/bostaFulfillment.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");
const { requirePlatformAdmin } = require("../middlewares/platformAuth.middleware");

const router = express.Router();
const requireTenant = [
  requireAuth,
  bindTenantScope,
  requireCompanyFeature("bosta"),
];

router.get("/fulfillment/health", ...requireTenant, checkBostaFulfillmentHealth);

router.get("/sku-mappings", ...requireTenant, listBostaSkuMappings);
router.post("/sku-mappings/import", ...requireTenant, importBostaSkuMappingsHandler);
router.post("/sku-mappings", ...requireTenant, addBostaSkuMappingHandler);
router.delete(
  "/sku-mappings/unmapped/:productId",
  ...requireTenant,
  deleteUnmappedProductHandler,
);
router.get(
  "/sku-mappings/by-product/:catalogProductId",
  ...requireTenant,
  getBostaSkuOptionsByProductHandler,
);
router.get("/sku-mappings/rows/:mappingId", ...requireTenant, getBostaSkuMappingByIdHandler);
router.put("/sku-mappings/rows/:mappingId", ...requireTenant, updateBostaSkuMappingByIdHandler);
router.patch("/sku-mappings/rows/:mappingId", ...requireTenant, updateBostaSkuMappingByIdHandler);
router.delete("/sku-mappings/rows/:mappingId", ...requireTenant, deleteBostaSkuMappingByIdHandler);
router.get("/sku-mappings/:mappingType/:entityId", ...requireTenant, getBostaSkuMappingHandler);
router.put(
  "/sku-mappings/:mappingType/:entityId",
  ...requireTenant,
  updateBostaSkuMappingHandler,
);
router.patch(
  "/sku-mappings/:mappingType/:entityId",
  ...requireTenant,
  updateBostaSkuMappingHandler,
);
router.delete(
  "/sku-mappings/:mappingType/:entityId",
  ...requireTenant,
  deleteBostaSkuMappingHandler,
);

router.get("/unmapped-products", ...requireTenant, listBostaSkuMappings);
router.delete(
  "/unmapped-products/:productId",
  ...requireTenant,
  deleteUnmappedProductHandler,
);

router.post("/locations/sync", requirePlatformAdmin, syncLocations);
router.get("/locations/sync", (req, res) => {
  res.status(405).json({
    success: false,
    message:
      "Sync requires POST as a platform admin. In Postman set method to POST with a platform JWT.",
    useMethod: "POST",
    paths: ["/api/bosta/locations/sync"],
  });
});

router.get("/cities", ...requireTenant, listCities);
router.get("/cities/:cityId/districts", ...requireTenant, listDistricts);
router.get("/cities/:cityId/zones", ...requireTenant, listZones);

module.exports = router;
