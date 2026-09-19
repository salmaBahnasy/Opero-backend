const express = require("express");
const { sallaOauthCallback } = require("../controllers/sallaOauthCallback.controller");

const router = express.Router();

router.get("/oauth/callback", sallaOauthCallback);

module.exports = router;
