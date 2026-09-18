const express = require("express");

const {
  sallaAuthLogin,
  sallaGetOrders,
  sallaGetStats,
} = require("../controllers/salla.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");

function sallaLoginMethodNotAllowed(req, res) {
  res.status(405).json({
    success: false,
    message: "Use POST /api/salla/auth/login with a company employee JWT. Credentials come from company_integrations.",
    allow: "POST",
    paths: ["/api/salla/auth/login", "/api/salla/login"],
  });
}

const router = express.Router();
const requireTenant = [requireAuth, bindTenantScope];

router.post("/auth/login", ...requireTenant, sallaAuthLogin);
router.post("/login", ...requireTenant, sallaAuthLogin);
router.get("/auth/login", sallaLoginMethodNotAllowed);
router.get("/login", sallaLoginMethodNotAllowed);
router.get("/orders", ...requireTenant, sallaGetOrders);
router.get("/stats", ...requireTenant, sallaGetStats);

module.exports = router;
