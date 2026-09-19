const easyorderService = require("../services/easyorder.service");
const {
  syncProductsFromEasyOrder,
  getProductsFromDb,
  getProductOptionsFromDb,
  getProductFromDb,
  createLocalProduct,
  updateLocalProduct,
  deleteLocalProduct,
  presentProduct,
} = require("../services/products.service");
const { syncShopifyProducts } = require("../services/shopifyProducts.service");
const { syncSallaProducts } = require("../services/sallaProducts.service");
const { sendKnownServiceError } = require("../utils/httpErrors");
const { sendInternalError } = require("../utils/safeError");
const { getCompanyId } = require("../middlewares/tenant.middleware");
const { clampListLimit, DEFAULT_LIST_LIMIT } = require("../utils/listPagination");
const {
  getConnection,
  resolveOwnedConnection,
  getTenantProviderSecrets,
} = require("../services/companyIntegrations.service");
const {
  isIngestionOnlyProvider,
} = require("../integrations/catalog");

const SOURCE_INTEGRATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function integrationOptions(req) {
  return {
    integrationId:
      req.query.integrationId ||
      req.query.integration_id ||
      req.body?.integrationId ||
      req.body?.integration_id,
  };
}

function optionalSourceFilter(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function sendProductError(res, error) {
  if (sendKnownServiceError(res, error)) return true;
  if (error.code === "INVALID_SOURCE_INTEGRATION") {
    res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
    return true;
  }
  if (error.code === "INTEGRATION_NOT_FOUND") {
    res.status(404).json({
      success: false,
      message: "Source integration not found",
      code: "INTEGRATION_NOT_FOUND",
    });
    return true;
  }
  if (
    error.code === "INVALID_PRODUCT" ||
    error.code === "INVALID_PRODUCT_ID" ||
    error.code === "SOURCE_INTEGRATION_REQUIRED"
  ) {
    res.status(error.status || 400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
    return true;
  }
  if (error.code === "PRODUCT_NOT_FOUND") {
    res.status(404).json({
      success: false,
      message: error.message,
      code: error.code,
    });
    return true;
  }
  if (error.code === "PRODUCT_CONFLICT" || error.code === "PRODUCT_AMBIGUOUS") {
    res.status(409).json({
      success: false,
      message: error.message,
      code: error.code,
    });
    return true;
  }
  return false;
}

async function assertOwnedSourceIntegration(req, sourceIntegrationId) {
  const id = optionalSourceFilter(sourceIntegrationId);
  if (!id) return "";
  if (!SOURCE_INTEGRATION_UUID.test(id)) {
    const err = new Error("Invalid source_integration_id filter");
    err.code = "INVALID_SOURCE_INTEGRATION";
    throw err;
  }
  const companyId = getCompanyId(req);
  await getConnection(companyId, id);
  return id;
}

function commerceSyncNotImplemented(provider) {
  const err = new Error(`${provider} product sync is not implemented`);
  err.code = "COMMERCE_SYNC_NOT_IMPLEMENTED";
  err.provider = provider;
  return err;
}

function spreadsheetSyncUnsupported() {
  const err = new Error(
    "Historical spreadsheet sources do not support remote product sync",
  );
  err.code = "SPREADSHEET_SYNC_UNSUPPORTED";
  err.provider = "spreadsheet";
  return err;
}

async function syncProducts(req, res) {
  try {
    const requestedProvider = String(
      req.query.provider || req.body?.provider || "",
    )
      .trim()
      .toLowerCase();
    if (
      requestedProvider === "spreadsheet" ||
      isIngestionOnlyProvider(requestedProvider)
    ) {
      throw spreadsheetSyncUnsupported();
    }
    const integrationId = integrationOptions(req).integrationId;
    const resolveOpts = {
      integrationId,
      category: "commerce",
    };
    if (integrationId) {
      if (requestedProvider) resolveOpts.provider = requestedProvider;
    } else {
      resolveOpts.provider = requestedProvider || "easyorders";
    }

    const connection = await resolveOwnedConnection(resolveOpts);
    const provider = String(connection.provider || "").toLowerCase();
    if (isIngestionOnlyProvider(provider) || provider === "spreadsheet") {
      throw spreadsheetSyncUnsupported();
    }

    if (provider === "easyorders") {
      const payload = await easyorderService.getProductsFromEasyOrder({
        integrationId: connection.id,
      });
      const result = await syncProductsFromEasyOrder(payload, {
        sourceIntegrationId: connection.id,
      });
      res.json({
        success: true,
        message: "Products synced",
        data: {
          provider: "easyorders",
          integrationId: connection.id,
          ...result,
        },
      });
      return;
    }

    if (provider === "shopify") {
      const { secrets } = await getTenantProviderSecrets("shopify", {
        integrationId: connection.id,
        category: "commerce",
      });
      const cursor =
        req.query.cursor ||
        req.query.nextCursor ||
        req.body?.cursor ||
        req.body?.nextCursor ||
        "";
      const result = await syncShopifyProducts({
        integration: connection,
        secrets,
        cursor,
      });
      res.json({
        success: true,
        message: result.hasMore
          ? "Shopify products synced. More pages remain."
          : "Products synced",
        data: result,
      });
      return;
    }

    if (provider === "salla") {
      const page =
        req.query.page ||
        req.query.nextPage ||
        req.body?.page ||
        req.body?.nextPage ||
        "";
      const result = await syncSallaProducts({
        integration: connection,
        page,
      });
      res.json({
        success: true,
        message: result.hasMore
          ? "Salla products synced. More pages remain."
          : "Products synced",
        data: result,
      });
      return;
    }

    throw commerceSyncNotImplemented(provider || "commerce");
  } catch (error) {
    if (sendProductError(res, error)) return;
    sendInternalError(res, "Failed to sync products", error, "products");
  }
}

async function getProducts(req, res) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = clampListLimit(req.query.limit, { fallback: DEFAULT_LIST_LIMIT });
    const search = req.query.search;
    const source_integration_id = await assertOwnedSourceIntegration(
      req,
      req.query.source_integration_id || req.query.sourceIntegrationId,
    );

    const result = await getProductsFromDb({
      page,
      limit,
      search,
      source_integration_id: source_integration_id || undefined,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (sendProductError(res, error)) return;
    sendInternalError(res, "Failed to fetch products", error, "products");
  }
}

async function getProductOptions(req, res) {
  try {
    const source_integration_id = await assertOwnedSourceIntegration(
      req,
      req.query.source_integration_id || req.query.sourceIntegrationId,
    );
    const result = await getProductOptionsFromDb({
      search: req.query.q || req.query.search,
      limit: req.query.limit,
      source_integration_id: source_integration_id || undefined,
      ids: req.query.id || req.query.ids || req.query.selected,
    });
    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (sendProductError(res, error)) return;
    sendInternalError(res, "Failed to search product options", error, "products");
  }
}

/**
 * GET /api/products/:productId
 * Local tenant catalog row. Live EasyOrders is used only:
 * - to enrich a local row from its own source_integration_id, or
 * - when an explicit integrationId is passed and no local row exists.
 */
async function getProductById(req, res) {
  try {
    const productId =
      req.params.productId ??
      req.params.product_id ??
      req.query.product_id ??
      req.query.productId;

    if (productId == null || String(productId).trim() === "") {
      res.status(400).json({
        success: false,
        message: "product_id is required",
      });
      return;
    }

    const requestedIntegrationId = optionalSourceFilter(
      integrationOptions(req).integrationId,
    );
    if (requestedIntegrationId) {
      await resolveOwnedConnection({
        integrationId: requestedIntegrationId,
        category: "commerce",
      });
    }

    const local = await getProductFromDb(productId, {
      source_integration_id: requestedIntegrationId || undefined,
    });

    if (local) {
      res.json({
        success: true,
        product_id: String(local.id),
        data: presentProduct(local),
      });
      return;
    }

    if (requestedIntegrationId) {
      const source = await getConnection(getCompanyId(req), requestedIntegrationId);
      if (String(source.provider || "").toLowerCase() === "easyorders") {
        const product = await easyorderService.getProductById(productId, {
          integrationId: requestedIntegrationId,
        });
        res.json({
          success: true,
          product_id: String(productId).trim(),
          data: product,
        });
        return;
      }
    }

    res.status(404).json({
      success: false,
      message: "Product not found",
      code: "PRODUCT_NOT_FOUND",
    });
  } catch (error) {
    if (sendProductError(res, error)) return;
    if (error.code === "INVALID_PRODUCT_ID") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    sendInternalError(res, "Failed to fetch product", error, "products");
  }
}

async function createProduct(req, res) {
  try {
    const data = await createLocalProduct(req.body || {});
    res.status(201).json({
      success: true,
      data,
    });
  } catch (error) {
    if (sendProductError(res, error)) return;
    sendInternalError(res, "Failed to create product", error, "products");
  }
}

async function updateProduct(req, res) {
  try {
    const productId = req.params.productId ?? req.params.product_id;
    const data = await updateLocalProduct(productId, req.body || {});
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (sendProductError(res, error)) return;
    sendInternalError(res, "Failed to update product", error, "products");
  }
}

async function deleteProduct(req, res) {
  try {
    const productId = req.params.productId ?? req.params.product_id;
    const data = await deleteLocalProduct(productId);
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (sendProductError(res, error)) return;
    sendInternalError(res, "Failed to delete product", error, "products");
  }
}

module.exports = {
  syncProducts,
  getProducts,
  getProductOptions,
  getProductById,
  getEasyOrderProductById: getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
