const express = require("express");

const { requirePlatformAdmin } = require("../middlewares/platformAuth.middleware");
const { platformLogin } = require("../controllers/platformAuth.controller");
const {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  setCompanyActive,
} = require("../controllers/platformCompanies.controller");
const {
  listCompanyIntegrations,
  getCompanyIntegration,
  createCompanyIntegration,
  updateCompanyIntegration,
  deleteCompanyIntegration,
  rotateCompanyWebhookToken,
  testCompanyIntegration,
} = require("../controllers/platformIntegrations.controller");

const router = express.Router();

router.post("/auth/login", platformLogin);

router.use(requirePlatformAdmin);

router.get("/companies", listCompanies);
router.post("/companies", createCompany);
router.get("/companies/:companyId", getCompany);
router.patch("/companies/:companyId", updateCompany);
router.patch("/companies/:companyId/active", setCompanyActive);

router.get("/companies/:companyId/integrations", listCompanyIntegrations);
router.post("/companies/:companyId/integrations", createCompanyIntegration);
router.get(
  "/companies/:companyId/integrations/:integrationId",
  getCompanyIntegration,
);
router.patch(
  "/companies/:companyId/integrations/:integrationId",
  updateCompanyIntegration,
);
router.delete(
  "/companies/:companyId/integrations/:integrationId",
  deleteCompanyIntegration,
);
router.post(
  "/companies/:companyId/integrations/:integrationId/rotate-webhook",
  rotateCompanyWebhookToken,
);
router.post(
  "/companies/:companyId/integrations/:integrationId/test",
  testCompanyIntegration,
);

module.exports = router;
