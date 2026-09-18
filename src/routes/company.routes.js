const express = require("express");

const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { getBootstrap } = require("../controllers/companyBootstrap.controller");

const router = express.Router();

router.get("/bootstrap", requireAuth, bindTenantScope, getBootstrap);

module.exports = router;
