const supabase = require("../config/tenantSupabase");
const {
  requireActiveCompanyId,
} = require("../utils/tenantScope");
const {
  readOrderReferenceFromRow,
  shouldAssignOrderReference,
  applyOrderReferenceToRawData,
  allocateNextOrderReference,
} = require("../utils/orderReference");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";

const LOCAL_FULFILLMENT_KEYS = [
  "bosta_order_id",
  "bosta_fulfillment_id",
  "bosta_order_alias",
  "bosta_tracking_number",
  "bosta_city_id",
  "bostaCityId",
  "bosta_district_id",
  "bostaDistrictId",
  "cityId",
  "districtId",
  "shipping_integration_id",
  "shippingIntegrationId",
  "assigned_employee_id",
  "assignedEmployeeId",
];

function shopifyPersistError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numericShopifyId(value) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if (!text) return "";
  const gid = text.match(/gid:\/\/shopify\/[A-Za-z]+\/(\d+)/i);
  if (gid) return gid[1];
  return text;
}

function shopifyExternalOrderId(payload) {
  return numericShopifyId(payload?.id ?? payload?.order_id ?? payload?.orderId);
}

function moneyString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const text = String(value).trim();
  return text || null;
}

function moneyFromSet(set) {
  const shop = asObject(asObject(set)?.shop_money);
  return moneyString(shop?.amount);
}

function personName(entity) {
  const obj = asObject(entity);
  if (!obj) return "";
  const combined = firstNonEmpty(obj.name);
  if (combined) return combined;
  return firstNonEmpty(
    [obj.first_name, obj.last_name].filter(Boolean).join(" ").trim(),
  );
}

function joinStreet(address) {
  const obj = asObject(address);
  if (!obj) return "";
  return [obj.address1, obj.address2]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function snapshotAddress(address) {
  const obj = asObject(address);
  if (!obj) return null;
  return {
    address1: firstNonEmpty(obj.address1) || null,
    address2: firstNonEmpty(obj.address2) || null,
    city: firstNonEmpty(obj.city) || null,
    province: firstNonEmpty(obj.province) || null,
    province_code: firstNonEmpty(obj.province_code) || null,
    country: firstNonEmpty(obj.country) || null,
    country_code: firstNonEmpty(obj.country_code) || null,
    zip: firstNonEmpty(obj.zip) || null,
    name: firstNonEmpty(obj.name) || null,
    phone: firstNonEmpty(obj.phone) || null,
    company: firstNonEmpty(obj.company) || null,
  };
}

function snapshotCustomer(customer) {
  const obj = asObject(customer);
  if (!obj) return null;
  return {
    id: numericShopifyId(obj.id) || null,
    email: firstNonEmpty(obj.email) || null,
    first_name: firstNonEmpty(obj.first_name) || null,
    last_name: firstNonEmpty(obj.last_name) || null,
    phone: firstNonEmpty(obj.phone) || null,
  };
}

function isShopifyCancelled(topic, payload) {
  if (String(topic || "").toLowerCase() === "orders/cancelled") return true;
  if (firstNonEmpty(payload?.cancelled_at)) return true;
  if (firstNonEmpty(payload?.canceled_at)) return true;
  if (firstNonEmpty(payload?.cancel_reason)) return true;
  return false;
}

function resolveShopifyErpStatus({ topic, payload, existingStatus }) {
  if (isShopifyCancelled(topic, payload)) return "canceled";
  if (existingStatus) return existingStatus;
  return "new";
}

function parseShopifyInstant(value) {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function isOlderShopifyPayload(existingRaw, payload) {
  const previous = parseShopifyInstant(asObject(existingRaw?.shopify)?.updated_at);
  const incoming = parseShopifyInstant(payload?.updated_at);
  if (!Number.isFinite(previous) || !Number.isFinite(incoming)) return false;
  return incoming < previous;
}

function keepUseful(incoming, existing) {
  if (incoming == null) return existing ?? incoming;
  if (typeof incoming === "string" && incoming.trim() === "") {
    return existing != null && String(existing).trim() !== "" ? existing : incoming;
  }
  if (Array.isArray(incoming) && incoming.length === 0) {
    return Array.isArray(existing) && existing.length ? existing : incoming;
  }
  return incoming;
}

function shippingAmount(payload) {
  const fromSet = moneyFromSet(payload?.total_shipping_price_set);
  if (fromSet != null) return fromSet;
  const lines = Array.isArray(payload?.shipping_lines) ? payload.shipping_lines : [];
  for (const line of lines) {
    const amount = moneyString(line?.price ?? asObject(line?.price_set)?.shop_money?.amount);
    if (amount != null) return amount;
  }
  return null;
}

function paymentMethod(payload) {
  return firstNonEmpty(
    payload?.gateway,
    Array.isArray(payload?.payment_gateway_names)
      ? payload.payment_gateway_names[0]
      : "",
  );
}

function normalizeCustomer(payload) {
  const shipping = asObject(payload?.shipping_address);
  const billing = asObject(payload?.billing_address);
  const customer = asObject(payload?.customer);
  const orderName = firstNonEmpty(payload?.name);
  const orderNameLooksLikeNumber = /^#?\d+/.test(orderName);

  const full_name = firstNonEmpty(
    shipping?.name,
    billing?.name,
    personName(customer),
    orderNameLooksLikeNumber ? "" : orderName,
  );

  const phone = firstNonEmpty(
    shipping?.phone,
    billing?.phone,
    customer?.phone,
    payload?.phone,
  );

  const email = firstNonEmpty(
    payload?.email,
    payload?.contact_email,
    customer?.email,
  );

  return { full_name, phone, email };
}

function normalizeAddress(payload) {
  const shipping = asObject(payload?.shipping_address);
  const billing = asObject(payload?.billing_address);
  const chosen = shipping || billing || {};
  const address = joinStreet(chosen);
  const city = firstNonEmpty(chosen.city);
  const province = firstNonEmpty(chosen.province);
  const province_code = firstNonEmpty(chosen.province_code);
  const country = firstNonEmpty(chosen.country);
  const country_code = firstNonEmpty(chosen.country_code);
  const zip = firstNonEmpty(chosen.zip);
  return {
    address,
    address1: firstNonEmpty(chosen.address1),
    address2: firstNonEmpty(chosen.address2),
    city,
    government: province || city,
    province,
    province_code,
    country,
    country_code,
    zip,
  };
}

function normalizeTotals(payload) {
  const subtotal = moneyString(payload?.subtotal_price) || moneyFromSet(payload?.subtotal_price_set);
  const discounts = moneyString(payload?.total_discounts) || moneyFromSet(payload?.total_discounts_set);
  const shipping = shippingAmount(payload);
  const tax = moneyString(payload?.total_tax) || moneyFromSet(payload?.total_tax_set);
  const total = moneyString(payload?.total_price) || moneyFromSet(payload?.total_price_set);
  const currency = firstNonEmpty(payload?.currency, payload?.presentment_currency);
  return {
    subtotal,
    discounts,
    shipping,
    tax,
    total,
    currency,
    cost: subtotal,
    shipping_cost: shipping,
    total_cost: total,
  };
}

function lineUnitPrice(line) {
  return moneyString(line?.price) || moneyFromSet(line?.price_set);
}

function normalizeLineItem(line, sourceIntegrationId, catalogMap) {
  const productId = numericShopifyId(line?.product_id);
  const variantId = numericShopifyId(line?.variant_id);
  const sku = firstNonEmpty(line?.sku);
  const title = firstNonEmpty(line?.title, line?.name);
  const variantTitle = firstNonEmpty(line?.variant_title);
  const name = firstNonEmpty(line?.name, [title, variantTitle].filter(Boolean).join(" - "));
  const quantity = Number(line?.quantity);
  const unitPrice = lineUnitPrice(line);
  const catalogProductId = productId ? catalogMap.get(productId) || null : null;
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  return {
    product_id: productId || null,
    productId: productId || null,
    variant_id: variantId || null,
    variantId: variantId || null,
    sku: sku || null,
    name: name || null,
    title: title || null,
    variant_title: variantTitle || null,
    quantity: qty,
    price: unitPrice,
    unit_price: unitPrice,
    total_discount: moneyString(line?.total_discount),
    source_integration_id: sourceIntegrationId,
    sourceIntegrationId: sourceIntegrationId,
    catalogProductId: catalogProductId || undefined,
    catalog_product_id: catalogProductId || undefined,
    product: {
      id: productId || null,
      name: title || name || null,
      sku: sku || null,
    },
    variant: variantId
      ? {
          id: variantId,
          title: variantTitle || null,
        }
      : undefined,
    shopify: {
      line_item_id: numericShopifyId(line?.id) || null,
      admin_graphql_api_id: firstNonEmpty(line?.admin_graphql_api_id) || null,
    },
  };
}

async function loadCatalogProductMap(sourceIntegrationId, productIds) {
  const ids = [...new Set((productIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const map = new Map();
  if (!ids.length || !sourceIntegrationId) return map;
  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("id, easyorder_id, source_integration_id")
    .eq("source_integration_id", sourceIntegrationId)
    .in("easyorder_id", ids);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    const externalId = String(row.easyorder_id || "").trim();
    if (!externalId || !row.id) continue;
    if (String(row.source_integration_id || "") !== String(sourceIntegrationId)) continue;
    map.set(externalId, row.id);
  }
  return map;
}

function shopifyMetadata(payload, { topic, shopDomain, webhookId, ingestedVia, existingShopify } = {}) {
  const previous = asObject(existingShopify) || {};
  return {
    order_id: shopifyExternalOrderId(payload) || null,
    name: firstNonEmpty(payload?.name) || null,
    order_number:
      payload?.order_number != null ? String(payload.order_number) : null,
    number: payload?.number != null ? String(payload.number) : null,
    financial_status: firstNonEmpty(payload?.financial_status) || null,
    fulfillment_status: firstNonEmpty(payload?.fulfillment_status) || null,
    cancelled_at: firstNonEmpty(payload?.cancelled_at, payload?.canceled_at) || null,
    cancel_reason: firstNonEmpty(payload?.cancel_reason) || null,
    tags: payload?.tags == null ? null : String(payload.tags),
    note: payload?.note == null ? null : String(payload.note),
    created_at: firstNonEmpty(payload?.created_at) || null,
    updated_at: firstNonEmpty(payload?.updated_at) || null,
    processed_at: firstNonEmpty(payload?.processed_at) || null,
    currency: firstNonEmpty(payload?.currency, payload?.presentment_currency) || null,
    gateway: firstNonEmpty(payload?.gateway) || null,
    source_name: firstNonEmpty(payload?.source_name) || null,
    admin_graphql_api_id: firstNonEmpty(payload?.admin_graphql_api_id) || null,
    topic: topic || null,
    shop_domain: shopDomain || null,
    webhook_id: webhookId || null,
    ingested_via: firstNonEmpty(previous.ingested_via, ingestedVia) || null,
    last_ingested_via: firstNonEmpty(ingestedVia, previous.last_ingested_via) || null,
    shipping_address: snapshotAddress(payload?.shipping_address),
    billing_address: snapshotAddress(payload?.billing_address),
    customer: snapshotCustomer(payload?.customer),
  };
}

function preserveLocalFulfillment(existingRaw, nextRaw) {
  const existing = asObject(existingRaw) || {};
  for (const key of LOCAL_FULFILLMENT_KEYS) {
    if (
      (nextRaw[key] == null || nextRaw[key] === "") &&
      existing[key] != null &&
      existing[key] !== ""
    ) {
      nextRaw[key] = existing[key];
    }
  }
  return nextRaw;
}

async function normalizeShopifyOrder(input = {}) {
  const companyId = String(input.companyId || "").trim();
  const sourceIntegrationId = String(input.sourceIntegrationId || "").trim();
  const topic = String(input.topic || "").trim().toLowerCase();
  const shopDomain = String(input.shopDomain || "").trim();
  const payload = asObject(input.payload) || {};
  const existingRow = input.existingRow || null;
  const existingRaw = asObject(existingRow?.raw_data) || {};
  const webhookId = firstNonEmpty(input.webhookId);
  const stale = Boolean(input.stale);

  if (!companyId || !sourceIntegrationId) {
    throw shopifyPersistError(
      "SHOPIFY_INTEGRATION_REQUIRED",
      "Shopify order persistence requires company and source integration context",
      400,
    );
  }

  const externalId = shopifyExternalOrderId(payload);
  if (!externalId) {
    throw shopifyPersistError(
      "SHOPIFY_ORDER_ID_REQUIRED",
      "Shopify order id is required",
      400,
    );
  }

  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : null;
  const productIds = (lineItems || [])
    .map((line) => numericShopifyId(line?.product_id))
    .filter(Boolean);
  const catalogMap =
    input.catalogMap instanceof Map
      ? input.catalogMap
      : await loadCatalogProductMap(sourceIntegrationId, productIds);

  const customer = normalizeCustomer(payload);
  const address = normalizeAddress(payload);
  const totals = normalizeTotals(payload);
  const incomingCart = lineItems
    ? lineItems.map((line) => normalizeLineItem(line, sourceIntegrationId, catalogMap))
    : null;
  const existingStatus = existingRow?.status || existingRaw.status || null;
  const status = resolveShopifyErpStatus({
    topic,
    payload,
    existingStatus,
  });
  const pay = paymentMethod(payload);

  const incoming = {
    full_name: customer.full_name || null,
    phone: customer.phone || null,
    mobile: customer.phone || null,
    email: customer.email || null,
    address: address.address || null,
    address1: address.address1 || null,
    address2: address.address2 || null,
    city: address.city || null,
    government: address.government || null,
    province: address.province || null,
    province_code: address.province_code || null,
    country: address.country || null,
    country_code: address.country_code || null,
    zip: address.zip || null,
    cost: totals.cost,
    shipping_cost: totals.shipping_cost,
    total_cost: totals.total_cost,
    subtotal: totals.subtotal,
    discounts: totals.discounts,
    shipping: totals.shipping,
    tax: totals.tax,
    total: totals.total,
    currency: totals.currency || null,
    payment_method: pay || null,
    paymentMethod: pay || null,
    cart_items: incomingCart,
    cartItems: incomingCart,
    tags: payload.tags == null ? null : String(payload.tags),
    note: payload.note == null ? null : String(payload.note),
  };

  const mergedCustomerAddressTotals = {};
  const mergeKeys = [
    "full_name",
    "phone",
    "mobile",
    "email",
    "address",
    "address1",
    "address2",
    "city",
    "government",
    "province",
    "province_code",
    "country",
    "country_code",
    "zip",
    "cost",
    "shipping_cost",
    "total_cost",
    "subtotal",
    "discounts",
    "shipping",
    "tax",
    "total",
    "currency",
    "payment_method",
    "paymentMethod",
    "tags",
    "note",
  ];
  for (const key of mergeKeys) {
    mergedCustomerAddressTotals[key] = stale
      ? keepUseful(undefined, existingRaw[key])
      : keepUseful(incoming[key], existingRaw[key]);
  }

  const cart_items = stale
    ? keepUseful(undefined, existingRaw.cart_items || existingRaw.cartItems)
    : keepUseful(incoming.cart_items, existingRaw.cart_items || existingRaw.cartItems);

  const shopify = {
    ...(asObject(existingRaw.shopify) || {}),
    ...shopifyMetadata(payload, {
      topic,
      shopDomain,
      webhookId,
      ingestedVia: input.ingestedVia,
      existingShopify: existingRaw.shopify,
    }),
  };
  if (stale && asObject(existingRaw.shopify)?.updated_at) {
    shopify.updated_at = existingRaw.shopify.updated_at;
    shopify.created_at = existingRaw.shopify.created_at || shopify.created_at;
    if (!isShopifyCancelled(topic, payload)) {
      shopify.financial_status =
        existingRaw.shopify.financial_status || shopify.financial_status;
      shopify.fulfillment_status =
        existingRaw.shopify.fulfillment_status || shopify.fulfillment_status;
    }
  }

  let raw_data = {
    ...existingRaw,
    ...mergedCustomerAddressTotals,
    cart_items: Array.isArray(cart_items) ? cart_items : [],
    cartItems: Array.isArray(cart_items) ? cart_items : [],
    provider: "shopify",
    platform: "shopify",
    ingestion_source: "shopify",
    ingestionSource: "shopify",
    order_source: "store",
    orderSource: "store",
    order_type: existingRaw.order_type || existingRaw.orderType || "new",
    orderType: existingRaw.orderType || existingRaw.order_type || "new",
    shipping_status:
      existingRaw.shipping_status || existingRaw.shippingStatus || "in_progress",
    shippingStatus:
      existingRaw.shippingStatus || existingRaw.shipping_status || "in_progress",
    customer_status: existingRaw.customer_status || existingRaw.customerStatus || "pending",
    customerStatus: existingRaw.customerStatus || existingRaw.customer_status || "pending",
    status,
    orderStatus: status,
    source_integration_id: sourceIntegrationId,
    sourceIntegrationId: sourceIntegrationId,
    shopify,
  };

  delete raw_data.company_id;
  delete raw_data.companyId;
  delete raw_data.selectedSystem;
  raw_data.source_integration_id = sourceIntegrationId;
  raw_data.sourceIntegrationId = sourceIntegrationId;
  raw_data = preserveLocalFulfillment(existingRaw, raw_data);
  if (raw_data.phone) {
    raw_data.mobile = raw_data.phone;
  }

  return {
    companyId,
    sourceIntegrationId,
    externalOrderId: existingRow?.order_id || externalId,
    status,
    raw_data,
    customer_name: raw_data.full_name || null,
    customer_phone: raw_data.phone || null,
    total_amount: Number.isFinite(Number(raw_data.total_cost))
      ? Number(raw_data.total_cost)
      : Number.isFinite(Number(raw_data.cost))
        ? Number(raw_data.cost)
        : null,
    payment_method: raw_data.payment_method || null,
    cancelled: isShopifyCancelled(topic, payload),
  };
}

async function findExistingShopifyOrder(externalOrderId, sourceIntegrationId) {
  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .select("*")
    .eq("order_id", String(externalOrderId))
    .eq("source_integration_id", sourceIntegrationId);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length > 1) {
    throw shopifyPersistError(
      "ORDER_AMBIGUOUS",
      "Multiple local orders match this Shopify order id",
      409,
    );
  }
  return rows[0] || null;
}

function persistPayloadFromNormalized(normalized, { orderReference, createdAt } = {}) {
  const raw_data =
    orderReference != null
      ? applyOrderReferenceToRawData(normalized.raw_data, orderReference)
      : normalized.raw_data;
  const payload = {
    order_id: normalized.externalOrderId,
    status: normalized.status,
    raw_data,
    source_integration_id: normalized.sourceIntegrationId,
    ingestion_source: "shopify",
    is_manual: false,
    customer_name: normalized.customer_name,
    customer_phone: normalized.customer_phone,
    order_source: "store",
    order_type: raw_data.order_type || "new",
    shipping_status: raw_data.shipping_status || "in_progress",
    payment_method: normalized.payment_method,
  };
  if (normalized.total_amount != null) {
    payload.total_amount = normalized.total_amount;
  }
  if (orderReference != null) {
    payload.order_reference = orderReference;
  }
  if (createdAt) {
    payload.created_at = createdAt;
  }
  return payload;
}

async function persistShopifyOrder(input = {}) {
  const tenantId = requireActiveCompanyId();
  const companyId = String(input.companyId || "").trim();
  const sourceIntegrationId = String(input.sourceIntegrationId || "").trim();
  if (!companyId || String(companyId) !== String(tenantId)) {
    throw shopifyPersistError(
      "WEBHOOK_UNAUTHORIZED",
      "Shopify webhook tenant context is invalid",
      401,
    );
  }
  if (!sourceIntegrationId) {
    throw shopifyPersistError(
      "SHOPIFY_INTEGRATION_REQUIRED",
      "Shopify webhook source integration is required",
      400,
    );
  }

  const payload = asObject(input.payload) || {};
  const externalId = shopifyExternalOrderId(payload);
  if (!externalId) {
    throw shopifyPersistError(
      "SHOPIFY_ORDER_ID_REQUIRED",
      "Shopify order id is required",
      400,
    );
  }

  const existingRow = await findExistingShopifyOrder(externalId, sourceIntegrationId);
  const stale = existingRow ? isOlderShopifyPayload(existingRow.raw_data, payload) : false;
  const normalized = await normalizeShopifyOrder({
    ...input,
    companyId,
    sourceIntegrationId,
    existingRow,
    stale,
  });

  const { getWebhookOrderById } = require("./webhookOrders.service");

  if (existingRow?.id) {
    const orderReference = readOrderReferenceFromRow(existingRow);
    const persistPayload = persistPayloadFromNormalized(normalized, {
      orderReference,
    });
    delete persistPayload.created_at;
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .update(persistPayload)
      .eq("id", existingRow.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return getWebhookOrderById(data.id);
  }

  const createdAt = new Date().toISOString();
  let orderReference = null;
  if (shouldAssignOrderReference(createdAt)) {
    orderReference = await allocateNextOrderReference(companyId);
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const persistPayload = persistPayloadFromNormalized(normalized, {
      orderReference,
      createdAt,
    });
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .insert(persistPayload)
      .select()
      .single();
    if (!error) {
      return getWebhookOrderById(data.id);
    }
    const dup =
      String(error.message || "").includes("duplicate") ||
      String(error.code || "") === "23505";
    if (dup) {
      const raced = await findExistingShopifyOrder(externalId, sourceIntegrationId);
      if (raced?.id) {
        const retryPayload = persistPayloadFromNormalized(normalized, {
          orderReference: readOrderReferenceFromRow(raced),
        });
        delete retryPayload.created_at;
        const { data: updated, error: updateError } = await supabase
          .from(ORDERS_TABLE)
          .update(retryPayload)
          .eq("id", raced.id)
          .select()
          .single();
        if (updateError) throw new Error(updateError.message);
        return getWebhookOrderById(updated.id);
      }
      if (orderReference != null && attempt < 2) {
        orderReference = await allocateNextOrderReference(companyId);
        lastError = error;
        continue;
      }
    }
    throw new Error(error.message);
  }
  throw new Error(lastError?.message || "Failed to persist Shopify order");
}

module.exports = {
  persistShopifyOrder,
  normalizeShopifyOrder,
  findExistingShopifyOrder,
  shopifyExternalOrderId,
  isShopifyCancelled,
  numericShopifyId,
};
