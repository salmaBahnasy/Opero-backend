const { runWithTenantContext } = require("../utils/tenantScope");
const {
  resolveWebhookByToken,
  markWebhookReceived,
} = require("./companyIntegrations.service");

async function runProviderWebhook(provider, rawToken, handler) {
  const { integration, company } = await resolveWebhookByToken(
    provider,
    rawToken,
  );

  const result = await runWithTenantContext(
    { companyId: company.id, integration },
    () => handler({ integration, company }),
  );

  try {
    await markWebhookReceived(integration.id);
  } catch {
    // timestamp is best-effort
  }

  return result;
}

module.exports = {
  runProviderWebhook,
};
