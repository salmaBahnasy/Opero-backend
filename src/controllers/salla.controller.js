const {
  fetchSallaOrders,
  verifySallaLogin,
  fetchAllSallaOrdersForStats,
  computeStatsFromSallaOrders,
} = require("../services/salla.service");
const { sendKnownServiceError } = require("../utils/httpErrors");

function integrationOptions(req) {
  return {
    integrationId:
      req.query.integrationId ||
      req.query.integration_id ||
      req.body?.integrationId ||
      req.body?.integration_id,
  };
}

async function sallaAuthLogin(req, res) {
  try {
    await verifySallaLogin(integrationOptions(req));
    res.json({
      success: true,
      message: "Salla authentication OK",
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "SALLA_HTTP_ERROR") {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Salla login check failed",
      error: error.message,
    });
  }
}

async function sallaGetOrders(req, res) {
  try {
    const data = await fetchSallaOrders(req.query || {}, integrationOptions(req));
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "SALLA_HTTP_ERROR") {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to fetch Salla orders",
      error: error.message,
    });
  }
}

async function sallaGetStats(req, res) {
  try {
    const orders = await fetchAllSallaOrdersForStats(integrationOptions(req));
    const stats = computeStatsFromSallaOrders(orders);
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "SALLA_HTTP_ERROR") {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to compute Salla stats",
      error: error.message,
    });
  }
}

module.exports = {
  sallaAuthLogin,
  sallaGetOrders,
  sallaGetStats,
};
