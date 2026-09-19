const {
  getBostaSkuMappings,
  getBostaSkuMapping,
  getBostaSkuMappingById,
  addBostaSkuMapping,
  updateBostaSkuMapping,
  updateBostaSkuMappingById,
  deleteBostaSkuMapping,
  deleteBostaSkuMappingById,
  deleteUnmappedProduct,
  importBostaSkuMappings,
  getBostaSkuOptionsForProduct,
  presentMappingRow,
} = require("../services/bostaSkuMappings.service");
const { sendKnownServiceError } = require("../utils/httpErrors");
const { sendInternalError, shouldExposeErrorDetails } = require("../utils/safeError");
const { pickShippingIntegrationId } = require("../services/bostaShipping.service");

function shippingOptions(req) {
  return {
    shippingIntegrationId: pickShippingIntegrationId({
      ...req.query,
      ...req.body,
      shippingIntegrationId:
        req.query?.shippingIntegrationId ||
        req.query?.shipping_integration_id ||
        req.body?.shippingIntegrationId ||
        req.body?.shipping_integration_id,
    }),
  };
}

function sendMappingError(res, error) {
  if (sendKnownServiceError(res, error)) return true;
  if (
    error.code === "INVALID_MAPPING_TYPE" ||
    error.code === "INVALID_ENTITY_ID" ||
    error.code === "INVALID_NAME" ||
    error.code === "INVALID_SKUS" ||
    error.code === "INVALID_SIZES" ||
    error.code === "INVALID_PRODUCT_ID" ||
    error.code === "INVALID_UPDATES" ||
    error.code === "LEGACY_MAPPING_READONLY"
  ) {
    res.status(400).json({ success: false, code: error.code, message: error.message });
    return true;
  }
  if (error.code === "MAPPING_NOT_FOUND" || error.code === "PRODUCT_NOT_MAPPED" || error.code === "PRODUCT_UNMAPPED") {
    res.status(404).json({
      success: false,
      code: error.code,
      message: error.message,
      productId: error.productId,
      catalogProductId: error.catalogProductId,
      unmapped: error.unmapped || null,
    });
    return true;
  }
  if (error.code === "MAPPING_EXISTS") {
    res.status(409).json({ success: false, code: error.code, message: error.message });
    return true;
  }
  if (error.code === "IMPORT_PRODUCT_AMBIGUOUS") {
    res.status(409).json({
      success: false,
      code: error.code,
      message: error.message,
      ambiguous: error.ambiguous || [],
    });
    return true;
  }
  if (error.code === "BOSTA_API_KEY_MISSING" || error.code === "BOSTA_FULFILLMENT_API_KEY_MISSING") {
    res.status(400).json({ success: false, message: error.message, code: error.code });
    return true;
  }
  if (error.code === "BOSTA_API_ERROR") {
    res.status(error.status || 502).json({
      success: false,
      message: shouldExposeErrorDetails() ? error.message : "Bosta request failed",
      code: error.code,
      details: shouldExposeErrorDetails() ? error.details || null : undefined,
    });
    return true;
  }
  return false;
}

async function listBostaSkuMappings(req, res) {
  try {
    const data = await getBostaSkuMappings(shippingOptions(req));
    res.json({ success: true, data });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function getBostaSkuMappingHandler(req, res) {
  try {
    const { mappingType, entityId } = req.params;
    const row = await getBostaSkuMapping(mappingType, entityId, shippingOptions(req));
    res.json({ success: true, data: presentMappingRow(row) });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function getBostaSkuMappingByIdHandler(req, res) {
  try {
    const row = await getBostaSkuMappingById(req.params.mappingId);
    res.json({ success: true, data: presentMappingRow(row) });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function addBostaSkuMappingHandler(req, res) {
  try {
    const row = await addBostaSkuMapping({ ...req.body, ...shippingOptions(req) });
    res.status(201).json({
      success: true,
      message: "Bosta SKU mapping created",
      data: presentMappingRow(row),
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function updateBostaSkuMappingHandler(req, res) {
  try {
    const { mappingType, entityId } = req.params;
    const row = await updateBostaSkuMapping(mappingType, entityId, {
      ...req.body,
      ...shippingOptions(req),
    });
    res.json({
      success: true,
      message: "Bosta SKU mapping updated",
      data: presentMappingRow(row),
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function updateBostaSkuMappingByIdHandler(req, res) {
  try {
    const row = await updateBostaSkuMappingById(req.params.mappingId, {
      ...req.body,
      ...shippingOptions(req),
    });
    res.json({
      success: true,
      message: "Bosta SKU mapping updated",
      data: presentMappingRow(row),
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function deleteBostaSkuMappingHandler(req, res) {
  try {
    const { mappingType, entityId } = req.params;
    const result = await deleteBostaSkuMapping(mappingType, entityId, shippingOptions(req));
    res.json({
      success: true,
      message: "Bosta SKU mapping deleted",
      data: result,
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function deleteBostaSkuMappingByIdHandler(req, res) {
  try {
    const result = await deleteBostaSkuMappingById(
      req.params.mappingId,
      shippingOptions(req),
    );
    res.json({
      success: true,
      message: "Bosta SKU mapping deleted",
      data: result,
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function deleteUnmappedProductHandler(req, res) {
  try {
    const productId = req.params.productId ?? req.params.entityId ?? req.params.mappingId;
    const result = await deleteUnmappedProduct(productId, shippingOptions(req));
    res.json({
      success: true,
      message: "Unmapped product removed",
      data: result,
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function getBostaSkuOptionsByProductHandler(req, res) {
  try {
    const productId =
      req.params.catalogProductId ??
      req.params.productId ??
      req.params.product_id ??
      req.query.product_id ??
      req.query.productId ??
      req.query.catalogProductId;

    const quantityRaw = req.query.quantity ?? req.query.qty;
    const requiredQuantity =
      quantityRaw != null && String(quantityRaw).trim() !== ""
        ? Number(quantityRaw)
        : 1;

    const includeInventoryRaw = String(
      req.query.includeInventory ?? req.query.include_inventory ?? "",
    )
      .trim()
      .toLowerCase();
    const data = await getBostaSkuOptionsForProduct(productId, {
      requiredQuantity,
      includeInventory:
        includeInventoryRaw === "1" ||
        includeInventoryRaw === "true" ||
        includeInventoryRaw === "yes",
      ...shippingOptions(req),
      sourceIntegrationId:
        req.query.source_integration_id || req.query.sourceIntegrationId,
    });

    res.json({ success: true, data });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function importBostaSkuMappingsHandler(req, res) {
  try {
    const data = await importBostaSkuMappings({
      ...req.body,
      ...shippingOptions(req),
    });
    res.json({
      success: true,
      message: "Bosta SKU mappings imported",
      data,
    });
  } catch (error) {
    if (sendMappingError(res, error)) return;
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

module.exports = {
  listBostaSkuMappings,
  getBostaSkuMappingHandler,
  getBostaSkuMappingByIdHandler,
  getBostaSkuOptionsByProductHandler,
  addBostaSkuMappingHandler,
  updateBostaSkuMappingHandler,
  updateBostaSkuMappingByIdHandler,
  deleteBostaSkuMappingHandler,
  deleteBostaSkuMappingByIdHandler,
  deleteUnmappedProductHandler,
  importBostaSkuMappingsHandler,
};
