const express = require("express");

const { requireAuth } = require("../middlewares/auth.middleware");
const {
  requireCompanyAdmin,
  bindTenantScope,
} = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");
const {
  listSources,
  getSource,
  createSource,
  updateSource,
} = require("../controllers/importSources.controller");

const router = express.Router();
const requireImportAdmin = [
  requireAuth,
  bindTenantScope,
  requireCompanyAdmin,
  requireCompanyFeature("imports"),
];

router.get("/", ...requireImportAdmin, listSources);
router.post("/", ...requireImportAdmin, createSource);
router.get("/:sourceId", ...requireImportAdmin, getSource);
router.patch("/:sourceId", ...requireImportAdmin, updateSource);

module.exports = router;
