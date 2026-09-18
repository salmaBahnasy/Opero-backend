const express = require("express");

const { getCompanyBranding } = require("../controllers/publicBranding.controller");

const router = express.Router();

router.get("/companies/:slug/branding", getCompanyBranding);

module.exports = router;
