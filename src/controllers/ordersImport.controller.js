const { sendKnownServiceError } = require("../utils/httpErrors");
const { sendInternalError } = require("../utils/safeError");
const {
  resolveOwnedConnection,
  getTenantProviderSecrets,
} = require("../services/companyIntegrations.service");
const { importShopifyOrders } = require("../services/shopifyOrderImport.service");
const { importSallaOrders } = require("../services/sallaOrderImport.service");
const { isIngestionOnlyProvider } = require("../integrations/catalog");

function importIntegrationRequired() {
  const error = new Error(
    "Historical order import requires an explicit integrationId",
  );
  error.code = "SHOPIFY_IMPORT_INTEGRATION_REQUIRED";
  return error;
}

async function importOrders(req, res) {
  try {
    const integrationId = String(
      req.body?.integrationId ||
        req.body?.integration_id ||
        req.query.integrationId ||
        req.query.integration_id ||
        "",
    ).trim();
    if (!integrationId) {
      throw importIntegrationRequired();
    }

    const connection = await resolveOwnedConnection({
      integrationId,
      category: "commerce",
    });
    const provider = String(connection.provider || "").toLowerCase();
    if (isIngestionOnlyProvider(provider) || provider === "spreadsheet") {
      const error = new Error(
        "Spreadsheet historical migration is a separate flow and is not available through provider API import",
      );
      error.code = "SPREADSHEET_HISTORICAL_API_IMPORT_UNSUPPORTED";
      error.provider = "spreadsheet";
      throw error;
    }
    if (provider === "shopify") {
      const { secrets } = await getTenantProviderSecrets("shopify", {
        integrationId: connection.id,
        category: "commerce",
      });
      const result = await importShopifyOrders({
        integration: connection,
        secrets,
        from: req.body?.from ?? req.query.from,
        to: req.body?.to ?? req.query.to,
        cursor: req.body?.cursor ?? req.body?.nextCursor ?? req.query.cursor,
      });
      res.json({
        success: true,
        message: result.hasMore
          ? "Shopify orders imported. More pages remain."
          : "Shopify orders imported",
        data: result,
      });
      return;
    }

    if (provider === "salla") {
      const result = await importSallaOrders({
        integration: connection,
        from: req.body?.from ?? req.query.from,
        to: req.body?.to ?? req.query.to,
        page: req.body?.page ?? req.body?.nextPage ?? req.query.page ?? req.query.nextPage,
      });
      res.json({
        success: true,
        message: result.hasMore
          ? "Salla orders imported. More pages remain."
          : "Salla orders imported",
        data: result,
      });
      return;
    }

    const error = new Error(
      "Historical order import currently supports Shopify connections only",
    );
    error.code = "SHOPIFY_PROVIDER_MISMATCH";
    error.provider = provider;
    throw error;
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    sendInternalError(res, "Failed to import orders", error, "imports");
  }
}

module.exports = { importOrders };
