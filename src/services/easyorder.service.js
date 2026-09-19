const axios = require("axios");

const EASYORDERS_TIMEOUT_MS = 15000;
const {
  getConnection,
  getTenantProviderSecrets,
} = require("./companyIntegrations.service");
const { requireActiveCompanyId } = require("../utils/tenantScope");
const { getTrustedEasyOrdersApiBaseUrl } = require("../config/easyorders");

function sourceIntegrationIdFromOrder(order) {
  const id = String(
    order?.source_integration_id ?? order?.sourceIntegrationId ?? "",
  ).trim();
  return id || null;
}

function easyConfirmSourceRequired() {
  const err = new Error(
    "This order has no EasyOrders commerce source. EasyConfirm cannot guess a store.",
  );
  err.code = "EASYCONFIRM_SOURCE_REQUIRED";
  err.statusCode = 409;
  return err;
}

function easyConfirmNotEasyOrders() {
  const err = new Error(
    "This order is not sourced from EasyOrders. EasyConfirm is EasyOrders-specific.",
  );
  err.code = "EASYCONFIRM_NOT_EASYORDERS";
  err.statusCode = 409;
  return err;
}

async function getEasyOrdersClient(options = {}) {
  const { secrets } = await getTenantProviderSecrets("easyorders", options);
  const apiKey = String(secrets.apiKey || "").trim();
  void secrets.apiBaseUrl;
  void secrets.api_base_url;
  const baseUrl = getTrustedEasyOrdersApiBaseUrl();

  return {
    apiKey,
    baseUrl,
    headers: { "Api-Key": apiKey },
  };
}

async function getEasyOrdersClientForOrder(order, { required = false } = {}) {
  const sourceId = sourceIntegrationIdFromOrder(order);
  if (!sourceId) {
    if (required) throw easyConfirmSourceRequired();
    return null;
  }

  const companyId = requireActiveCompanyId();
  let connection;
  try {
    connection = await getConnection(companyId, sourceId);
  } catch (error) {
    if (!required && error.code === "INTEGRATION_NOT_FOUND") {
      return null;
    }
    throw error;
  }

  if (String(connection.provider || "").toLowerCase() !== "easyorders") {
    if (required) throw easyConfirmNotEasyOrders();
    return null;
  }

  return getEasyOrdersClient({
    integrationId: sourceId,
    category: "commerce",
  });
}

async function getOrderById(orderId, options = {}) {
  const client = options.client || (await getEasyOrdersClient(options));
  const url = `${client.baseUrl}/orders/${encodeURIComponent(String(orderId || "").trim())}`;
  const response = await axios.get(url, {
    headers: client.headers,
    timeout: EASYORDERS_TIMEOUT_MS,
    maxRedirects: 0,
  });
  return response.data;
}

/**
 * EasyOrders stores WhatsApp confirmation in `status`
 * (pending | confirmed | canceled | …). Map to ERP customer_status.
 */
function mapEasyOrdersStatusToCustomerStatus(easyOrdersStatus) {
  const raw = String(easyOrdersStatus || "")
    .trim()
    .toLowerCase();
  if (raw === "confirmed" || raw === "approved") return "confirmed";
  if (raw === "canceled" || raw === "cancelled") return "canceled";
  if (raw === "failed") return "failed";
  if (raw === "pending" || raw === "waiting") return "pending";
  return null;
}

function isTruthyFlag(value) {
  if (value === true || value === 1) return true;
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/** Manual ERP order (POST /api/orders) — never sync customerStatus from EasyOrders. */
function isManualOrder(order = {}) {
  return isTruthyFlag(order?.is_manual) || isTruthyFlag(order?.isManual);
}

/**
 * Live-sync customer confirmation from EasyOrders onto a local order.
 * Source of truth: EasyOrders GET /orders/:id → status
 *
 * options.forceSync — always write to DB (used by "إظهار الحالة" button)
 */
async function enrichOrderWithEasyOrdersCustomerStatus(order, options = {}) {
  if (!order || typeof order !== "object") {
    return { order, easyOrdersConfirm: null };
  }

  // Manual ERP orders keep customerStatus=confirmed — never overwrite from EasyOrders
  if (isManualOrder(order)) {
    return {
      order: {
        ...order,
        customer_status: "confirmed",
        customerStatus: "confirmed",
        is_manual: true,
        isManual: true,
      },
      easyOrdersConfirm: null,
    };
  }

  const syncLocal = options.syncLocal !== false;
  const forceSync = options.forceSync === true;
  const orderId = String(
    order.sourceOrderId || order.order_id || "",
  ).trim();
  if (!orderId) {
    return { order, easyOrdersConfirm: null };
  }

  let client;
  try {
    client = await getEasyOrdersClientForOrder(order, {
      required: options.throwOnError === true,
    });
  } catch (error) {
    if (options.throwOnError) throw error;
    return { order, easyOrdersConfirm: null };
  }
  if (!client) {
    return { order, easyOrdersConfirm: null };
  }

  let remote;
  try {
    remote = await getOrderById(orderId, { client });
  } catch (error) {
    if (
      error?.code === "INTEGRATION_NOT_CONFIGURED" ||
      error?.code === "INTEGRATION_DISABLED" ||
      error?.code === "INTEGRATION_NOT_OWNED" ||
      error?.code === "INTEGRATION_NOT_FOUND" ||
      error?.code === "INTEGRATION_AMBIGUOUS" ||
      error?.code === "PROVIDER_MISMATCH" ||
      error?.code === "EASYCONFIRM_SOURCE_REQUIRED" ||
      error?.code === "EASYCONFIRM_NOT_EASYORDERS"
    ) {
      if (options.throwOnError) {
        if (error.code === "PROVIDER_MISMATCH") throw easyConfirmNotEasyOrders();
        throw error;
      }
      return { order, easyOrdersConfirm: null };
    }
    console.warn(
      JSON.stringify({
        source: "easyorder-api",
        level: "warn",
        message: error?.message || "Failed to fetch EasyOrders order",
        orderId,
      }),
    );
    if (options.throwOnError) {
      const err = new Error(
        error?.response?.data?.message ||
          error?.message ||
          "Failed to fetch EasyOrders order",
      );
      err.code = "EASYORDERS_FETCH_FAILED";
      err.statusCode = error?.response?.status || 502;
      err.cause = error;
      throw err;
    }
    return { order, easyOrdersConfirm: null };
  }

  const remoteOrder =
    remote && typeof remote === "object"
      ? remote.data && typeof remote.data === "object" && remote.data.id
        ? remote.data
        : remote
      : null;

  if (!remoteOrder) {
    if (options.throwOnError) {
      const err = new Error("EasyOrders order response was empty");
      err.code = "EASYORDERS_EMPTY_RESPONSE";
      err.statusCode = 502;
      throw err;
    }
    return { order, easyOrdersConfirm: null };
  }

  const customerStatus =
    mapEasyOrdersStatusToCustomerStatus(remoteOrder.status) || "pending";
  const easyOrdersConfirm = {
    id: remoteOrder.id ?? null,
    shortId: remoteOrder.short_id ?? remoteOrder.shortId ?? null,
    status: remoteOrder.status ?? null,
    customerStatus,
    source: "easyorders",
  };

  const localStatus = String(
    order.customer_status ?? order.customerStatus ?? "",
  )
    .trim()
    .toLowerCase();
  const localNormalized =
    localStatus === "cancelled" ? "canceled" : localStatus;

  let enriched = {
    ...order,
    customer_status: customerStatus,
    customerStatus,
    short_id: order.short_id ?? remoteOrder.short_id,
    easyorders_status: remoteOrder.status,
    easyOrdersStatus: remoteOrder.status,
  };

  const shouldWrite =
    syncLocal &&
    order.sourceOrderId &&
    (forceSync || localNormalized !== customerStatus);

  if (shouldWrite) {
    const { mergeOrderRawDataPatch } = require("./webhookOrders.service");
    enriched = await mergeOrderRawDataPatch(order.localOrderId || order.sourceOrderId, {
      customer_status: customerStatus,
      customerStatus,
      easyorders_status: remoteOrder.status,
      easyOrdersStatus: remoteOrder.status,
      confirmation_source: "easyorders",
      confirmation_status:
        customerStatus === "canceled" ? "cancelled" : customerStatus,
      easyorders_customer_synced_at: new Date().toISOString(),
    });
  }

  return { order: enriched, easyOrdersConfirm };
}

async function refreshCustomerStatusFromEasyOrders(orderId, lookupOptions = {}) {
  const id = String(orderId || "").trim();
  if (!id) {
    const err = new Error("order id is required");
    err.code = "INVALID_ORDER_ID";
    err.statusCode = 400;
    throw err;
  }

  const { getWebhookOrderById } = require("./webhookOrders.service");
  const localOrder = await getWebhookOrderById(id, lookupOptions);

  if (isManualOrder(localOrder)) {
    const err = new Error(
      "Manual orders keep customerStatus=confirmed and cannot be refreshed from EasyOrders",
    );
    err.code = "MANUAL_ORDER_NO_REFRESH";
    err.statusCode = 400;
    throw err;
  }

  const previousStatus =
    localOrder.customerStatus || localOrder.customer_status || "pending";

  const { order, easyOrdersConfirm } =
    await enrichOrderWithEasyOrdersCustomerStatus(
      {
        ...localOrder,
        sourceOrderId: localOrder.sourceOrderId || localOrder.order_id || "",
      },
      { syncLocal: true, forceSync: true, throwOnError: true },
    );

  return {
    order,
    easyOrdersConfirm,
    previousCustomerStatus:
      String(previousStatus).toLowerCase() === "cancelled"
        ? "canceled"
        : String(previousStatus).toLowerCase() || "pending",
    customerStatus: easyOrdersConfirm.customerStatus,
    changed:
      String(previousStatus).toLowerCase().replace("cancelled", "canceled") !==
      easyOrdersConfirm.customerStatus,
  };
}

/** Fetches products list from EasyOrders external-apps API. */
async function getProductsFromEasyOrder(options = {}) {
  const client = await getEasyOrdersClient(options);
  const url = `${client.baseUrl}/products`;
  const response = await axios.get(url, {
    headers: client.headers,
    timeout: EASYORDERS_TIMEOUT_MS,
    maxRedirects: 0,
  });
  return response.data;
}

/** GET /products/:product_id — single product from EasyOrders external-apps API. */
async function getProductById(productId, options = {}) {
  const id = String(productId || "").trim();
  if (!id) {
    const err = new Error("product_id is required");
    err.code = "INVALID_PRODUCT_ID";
    throw err;
  }

  const client = await getEasyOrdersClient(options);
  const url = `${client.baseUrl}/products/${encodeURIComponent(id)}`;
  const response = await axios.get(url, {
    headers: client.headers,
    timeout: EASYORDERS_TIMEOUT_MS,
    maxRedirects: 0,
  });
  return response.data;
}

module.exports = {
  getEasyOrdersClient,
  getOrderById,
  getProductsFromEasyOrder,
  getProductById,
  mapEasyOrdersStatusToCustomerStatus,
  enrichOrderWithEasyOrdersCustomerStatus,
  refreshCustomerStatusFromEasyOrders,
  isManualOrder,
  sourceIntegrationIdFromOrder,
  EASYORDERS_TIMEOUT_MS,
};
