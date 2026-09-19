const {
  listConnections,
  listAllConnectionsOverview,
  getConnection,
  createConnection,
  updateConnection,
  rotateWebhookToken,
  deleteConnection,
  testConnection,
} = require("../services/companyIntegrations.service");

function handleIntegrationError(res, error, fallbackMessage) {
  const { sendKnownServiceError } = require("../utils/httpErrors");
  if (sendKnownServiceError(res, error)) return;
  if (error.code === "COMPANY_NOT_FOUND" || error.code === "INTEGRATION_NOT_FOUND") {
    res.status(404).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (
    error.code === "UNSUPPORTED_PROVIDER" ||
    error.code === "UNSUPPORTED_CATEGORY" ||
    error.code === "PROVIDER_CATEGORY_MISMATCH" ||
    error.code === "INTEGRATION_NAME_REQUIRED" ||
    error.code === "SHOPIFY_SHOP_DOMAIN_INVALID" ||
    error.code === "SHOPIFY_SHOP_DOMAIN_REQUIRED" ||
    error.code === "SHOPIFY_INTEGRATION_REQUIRED" ||
    error.code === "SHOPIFY_PROVIDER_MISMATCH"
  ) {
    res.status(400).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (
    error.code === "SHOPIFY_CREDENTIALS_INVALID" ||
    error.code === "SHOPIFY_SHOP_DOMAIN_MISMATCH" ||
    error.code === "SHOPIFY_WEBHOOK_SECRET_MISSING" ||
    error.code === "SHOPIFY_WEBHOOK_HMAC_INVALID"
  ) {
    res.status(401).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (error.code === "SHOPIFY_RATE_LIMITED") {
    res.status(429).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (
    error.code === "SHOPIFY_PROVIDER_UNAVAILABLE" ||
    error.code === "SHOPIFY_GRAPHQL_ERROR"
  ) {
    res.status(502).json({ success: false, code: error.code, message: error.message });
    return;
  }
  if (
    error.code === "INTEGRATION_NOT_CONFIGURED" ||
    error.code === "INTEGRATION_DISABLED" ||
    error.code === "WEBHOOK_NOT_APPLICABLE" ||
    error.code === "INTEGRATION_IN_USE" ||
    error.code === "SPREADSHEET_WEBHOOK_UNSUPPORTED" ||
    error.code === "SPREADSHEET_REMOTE_TEST_UNSUPPORTED"
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

async function listAllIntegrationsOverview(req, res) {
  try {
    const data = await listAllConnectionsOverview();
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to list integrations overview");
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
  handleIntegrationError,
  listCompanyIntegrations,
  listAllIntegrationsOverview,
  getCompanyIntegration,
  createCompanyIntegration,
  updateCompanyIntegration,
  deleteCompanyIntegration,
  rotateCompanyWebhookToken,
  testCompanyIntegration,
};
