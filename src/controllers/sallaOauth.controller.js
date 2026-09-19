const { sendKnownServiceError } = require("../utils/httpErrors");
const { createSallaAuthorizationUrl } = require("../services/sallaAuth.service");

async function connectSallaIntegration(req, res) {
  try {
    const data = await createSallaAuthorizationUrl(
      req.params.companyId,
      req.params.integrationId,
    );
    res.json({
      success: true,
      data: {
        provider: data.provider,
        integrationId: data.integrationId,
        authorizationUrl: data.authorizationUrl,
      },
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    const { handleIntegrationError } = require("./platformIntegrations.controller");
    handleIntegrationError(res, error, "Failed to start Salla authorization");
  }
}

module.exports = { connectSallaIntegration };
