const express = require("express");

const { requireAuth } = require("../middlewares/auth.middleware");
const {
  bindTenantScope,
  requireCompanyAdmin,
} = require("../middlewares/tenant.middleware");
const { getBootstrap } = require("../controllers/companyBootstrap.controller");
const {
  listCompanySelfServiceIntegrations,
  getCompanySelfServiceIntegration,
  createCompanySelfServiceIntegration,
  updateCompanySelfServiceIntegration,
  rotateCompanySelfServiceWebhook,
  testCompanySelfServiceIntegration,
  connectCompanySallaIntegration,
} = require("../controllers/companyIntegrations.controller");

const router = express.Router();

const requireAdmin = [requireAuth, bindTenantScope, requireCompanyAdmin];

router.get("/bootstrap", requireAuth, bindTenantScope, getBootstrap);

router.get("/integrations", ...requireAdmin, listCompanySelfServiceIntegrations);
router.post("/integrations", ...requireAdmin, createCompanySelfServiceIntegration);
router.get(
  "/integrations/:integrationId",
  ...requireAdmin,
  getCompanySelfServiceIntegration,
);
router.patch(
  "/integrations/:integrationId",
  ...requireAdmin,
  updateCompanySelfServiceIntegration,
);
router.post(
  "/integrations/:integrationId/test",
  ...requireAdmin,
  testCompanySelfServiceIntegration,
);
router.post(
  "/integrations/:integrationId/rotate-webhook",
  ...requireAdmin,
  rotateCompanySelfServiceWebhook,
);
router.post(
  "/integrations/:integrationId/salla/connect",
  ...requireAdmin,
  connectCompanySallaIntegration,
);

module.exports = router;
