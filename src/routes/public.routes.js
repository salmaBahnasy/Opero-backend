const express = require("express");

const { getCompanyBranding } = require("../controllers/publicBranding.controller");
const { publicSignup } = require("../controllers/publicSignup.controller");

const router = express.Router();

router.get("/companies/:slug/branding", getCompanyBranding);
router.post("/signup", publicSignup);

module.exports = router;
