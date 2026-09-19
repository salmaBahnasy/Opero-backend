const {
  listCompanyEmployees,
  listCompanyFeatures,
  setCompanyFeature,
} = require("../services/platformCompanies.service");
const { sendPlatformCompanyError } = require("./platformCompanies.controller");

async function listEmployees(req, res) {
  try {
    const data = await listCompanyEmployees(req.params.companyId);
    res.json({ success: true, data });
  } catch (error) {
    sendPlatformCompanyError(res, error, "Failed to list employees");
  }
}

async function listFeatures(req, res) {
  try {
    const data = await listCompanyFeatures(req.params.companyId);
    res.json({ success: true, data });
  } catch (error) {
    sendPlatformCompanyError(res, error, "Failed to list company features");
  }
}

async function updateFeature(req, res) {
  try {
    const body = req.body || {};
    const enabled = body.is_enabled ?? body.enabled ?? body.isEnabled;
    const data = await setCompanyFeature(
      req.params.companyId,
      req.params.featureKey,
      enabled,
    );
    res.json({ success: true, data });
  } catch (error) {
    sendPlatformCompanyError(res, error, "Failed to update company feature");
  }
}

module.exports = {
  listEmployees,
  listFeatures,
  updateFeature,
};
