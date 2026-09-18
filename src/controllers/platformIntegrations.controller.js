const {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  rotateWebhookToken,
  deleteConnection,
  testConnection,
} = require("../services/companyIntegrations.service");

function handleIntegrationError(res, error, fallbackMessage) {
  if (error.code === "COMPANY_NOT_FOUND" || error.code === "INTEGRATION_NOT_FOUND") {
    res.status(404).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (
    error.code === "UNSUPPORTED_PROVIDER" ||
    error.code === "UNSUPPORTED_CATEGORY" ||
    error.code === "PROVIDER_CATEGORY_MISMATCH" ||
    error.code === "INTEGRATION_NAME_REQUIRED"
  ) {
    res.status(400).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (
    error.code === "INTEGRATION_NOT_CONFIGURED" ||
    error.code === "WEBHOOK_NOT_APPLICABLE"
  ) {
    res.status(409).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error.message,
  });
}

async function listCompanyIntegrations(req, res) {
  try {
    const data = await listConnections(req.params.companyId);
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to list integrations");
  }
}

async function getCompanyIntegration(req, res) {
  try {
    const data = await getConnection(
      req.params.companyId,
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to get integration");
  }
}

async function createCompanyIntegration(req, res) {
  try {
    const data = await createConnection(req.params.companyId, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to create integration");
  }
}

async function updateCompanyIntegration(req, res) {
  try {
    const data = await updateConnection(
      req.params.companyId,
      req.params.integrationId,
      req.body || {},
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to update integration");
  }
}

async function deleteCompanyIntegration(req, res) {
  try {
    const data = await deleteConnection(
      req.params.companyId,
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to delete integration");
  }
}

async function rotateCompanyWebhookToken(req, res) {
  try {
    const data = await rotateWebhookToken(
      req.params.companyId,
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to rotate webhook token");
  }
}

async function testCompanyIntegration(req, res) {
  try {
    const data = await testConnection(
      req.params.companyId,
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to test integration");
  }
}

module.exports = {
  listCompanyIntegrations,
  getCompanyIntegration,
  createCompanyIntegration,
  updateCompanyIntegration,
  deleteCompanyIntegration,
  rotateCompanyWebhookToken,
  testCompanyIntegration,
};
