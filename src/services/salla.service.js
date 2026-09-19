const { sallaError } = require("./sallaAuth.service");
const { sallaUserInfo } = require("./sallaClient.service");

function requireExactSallaIntegrationId(options = {}) {
  const integrationId = String(
    options.integrationId || options.integration_id || "",
  ).trim();
  if (!integrationId) {
    throw sallaError(
      "SALLA_INTEGRATION_REQUIRED",
      "An exact Salla integrationId is required",
      400,
    );
  }
  return integrationId;
}

async function verifySallaLogin(options = {}) {
  const integrationId = requireExactSallaIntegrationId(options);
  const { getConnectionRow, assertSallaConnection } = require("./sallaAuth.service");
  const { requireActiveCompanyId } = require("../utils/tenantScope");
  const companyId = requireActiveCompanyId();
  const row = assertSallaConnection(await getConnectionRow(integrationId), companyId);
  await sallaUserInfo({ integration: row, allowDisabled: false });
  return { ok: true, integrationId: row.id };
}

module.exports = {
  verifySallaLogin,
  requireExactSallaIntegrationId,
};
