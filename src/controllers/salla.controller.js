const { sendKnownServiceError } = require("../utils/httpErrors");
const { verifySallaLogin } = require("../services/salla.service");
const { sallaError } = require("../services/sallaAuth.service");

function integrationOptions(req) {
  return {
    integrationId:
      req.query.integrationId ||
      req.query.integration_id ||
      req.body?.integrationId ||
      req.body?.integration_id,
  };
}

function sallaProxyRemoved(res) {
  res.status(409).json({
    success: false,
    code: "SALLA_INTEGRATION_REQUIRED",
    message:
      "Live Salla order proxy is not used. Orders live in the ERP after OAuth connect.",
  });
}

async function sallaAuthLogin(req, res) {
  try {
    if (!integrationOptions(req).integrationId) {
      throw sallaError(
        "SALLA_INTEGRATION_REQUIRED",
        "An exact Salla integrationId is required",
        400,
      );
    }
    await verifySallaLogin(integrationOptions(req));
    res.json({
      success: true,
      message: "Salla authentication OK",
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || "SALLA_PROVIDER_UNAVAILABLE",
      message: error.message || "Salla login check failed",
    });
  }
}

async function sallaGetOrders(_req, res) {
  sallaProxyRemoved(res);
}

async function sallaGetStats(_req, res) {
  sallaProxyRemoved(res);
}

module.exports = {
  sallaAuthLogin,
  sallaGetOrders,
  sallaGetStats,
};
