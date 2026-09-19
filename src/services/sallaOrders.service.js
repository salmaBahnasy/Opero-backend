const supabase = require("../config/tenantSupabase");
const { requireActiveCompanyId } = require("../utils/tenantScope");
const {
  readOrderReferenceFromRow,
  shouldAssignOrderReference,
  applyOrderReferenceToRawData,
  allocateNextOrderReference,
} = require("../utils/orderReference");
const { sallaError } = require("./sallaAuth.service");
const { sallaGetOrder } = require("./sallaClient.service");

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

const SECRET_KEYS = new Set([
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "authorization",
  "Authorization",
  "webhook_secret",
  "webhookSecret",
  "signature",
  "x-salla-signature",
  "X-Salla-Signature",
  "client_secret",
  "clientSecret",
  "code",
  "oauth_code",
]);

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

function asIdString(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    return asIdString(value.id ?? value.order_id ?? value.product_id);
  }
  return String(value).trim();
}

function sallaExternalOrderId(data) {
  return asIdString(data?.id);
}

function moneyString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") {
    return moneyString(value.amount ?? value.value ?? value.price);
  }
  const text = String(value).trim();
  return text || null;
}

function moneyFromAmounts(amounts, key) {
  const obj = asObject(amounts);
  if (!obj) return null;
  return moneyString(obj[key]);
}

function sallaDateRaw(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value.trim();
  const obj = asObject(value);
  if (!obj) return "";
  return firstNonEmpty(obj.date, obj.datetime, obj.iso);
}

function parseSallaInstant(value) {
  const raw = sallaDateRaw(value);
  if (!raw) return NaN;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.parse(raw);
}

function statusInfo(data) {
  const status = asObject(data?.status);
  if (status) {
    return {
      slug: firstNonEmpty(status.slug, status.code, status.id).toLowerCase(),
      name: firstNonEmpty(status.name, status.label, status.slug),
    };
  }
  const slug = firstNonEmpty(data?.status_slug, data?.order_status, data?.status).toLowerCase();
  return { slug, name: firstNonEmpty(data?.status_name, slug) };
}

function isSallaCancelled(event, data) {
  const ev = String(event || "").trim().toLowerCase();
  if (ev === "order.cancelled" || ev === "order.canceled") return true;
  const slug = statusInfo(data).slug;
  if (!slug) return false;
  return slug === "canceled" || slug === "cancelled";
}

function resolveSallaErpStatus({ event, data, existingStatus }) {
  if (isSallaCancelled(event, data)) return "canceled";
  if (existingStatus) return existingStatus;
  return "new";
}

function isOlderSallaPayload(existingRaw, data) {
  const previous = parseSallaInstant(asObject(existingRaw?.salla)?.updated_at);
  const incoming = parseSallaInstant(data?.updated_at);
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

function personName(entity) {
  const obj = asObject(entity);
  if (!obj) return "";
  const combined = firstNonEmpty(obj.name, obj.full_name, obj.fullName);
  if (combined) return combined;
  return firstNonEmpty([obj.first_name, obj.last_name].filter(Boolean).join(" ").trim());
}

function sanitizeMeta(value, depth = 0) {
  if (value == null || depth > 4) return value == null ? null : undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 30)
      .map((item) => sanitizeMeta(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    const clean = sanitizeMeta(nested, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function snapshotAddress(address) {
  const obj = asObject(address);
  if (!obj) return null;
  return sanitizeMeta({
    country: firstNonEmpty(obj.country) || null,
    country_code: firstNonEmpty(obj.country_code, obj.countryCode) || null,
    city: firstNonEmpty(obj.city) || null,
    shipping_address: firstNonEmpty(obj.shipping_address, obj.address, obj.street) || null,
    street_number: firstNonEmpty(obj.street_number) || null,
    block: firstNonEmpty(obj.block) || null,
    postal_code: firstNonEmpty(obj.postal_code, obj.zip, obj.postcode) || null,
    geo_coordinates: asObject(obj.geo_coordinates) || null,
  });
}

function snapshotCustomer(customer) {
  const obj = asObject(customer);
  if (!obj) return null;
  return sanitizeMeta({
    id: asIdString(obj.id) || null,
    first_name: firstNonEmpty(obj.first_name) || null,
    last_name: firstNonEmpty(obj.last_name) || null,
    mobile: firstNonEmpty(obj.mobile, obj.phone) || null,
    email: firstNonEmpty(obj.email) || null,
  });
}

function joinSallaStreet(address) {
  const obj = asObject(address);
  if (!obj) return "";
  return [
    obj.shipping_address,
    obj.address,
    obj.street,
    obj.street_number,
    obj.block,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeCustomer(data) {
  const shipping = asObject(data?.shipping);
  const receiver = asObject(shipping?.receiver) || asObject(data?.receiver);
  const customer = asObject(data?.customer);
  const full_name = firstNonEmpty(personName(receiver), personName(customer), data?.full_name);
  const phone = firstNonEmpty(
    receiver?.phone,
    receiver?.mobile,
    customer?.mobile,
    customer?.phone,
    data?.phone,
    data?.mobile,
  );
  const email = firstNonEmpty(
    data?.email,
    data?.contact_email,
    customer?.email,
    receiver?.email,
  );
  return { full_name, phone, email };
}

function normalizeAddress(data) {
  const shipping = asObject(data?.shipping);
  const chosen =
    asObject(shipping?.address) ||
    asObject(data?.shipping_address) ||
    asObject(data?.address) ||
    {};
  const address = joinSallaStreet(chosen);
  const city = firstNonEmpty(chosen.city);
  const province = firstNonEmpty(
    chosen.province,
    chosen.region,
    chosen.state,
    chosen.government,
  );
  const country = firstNonEmpty(chosen.country);
  const country_code = firstNonEmpty(chosen.country_code, chosen.countryCode);
  const zip = firstNonEmpty(chosen.postal_code, chosen.zip, chosen.postcode);
  return {
    address,
    address1: firstNonEmpty(chosen.shipping_address, chosen.address, chosen.street),
    address2: firstNonEmpty(chosen.street_number, chosen.block, chosen.address2),
    city,
    government: province || city,
    province,
    country,
    country_code,
    zip,
  };
}

function normalizeTotals(data) {
  const amounts = asObject(data?.amounts) || {};
  const subtotal = moneyFromAmounts(amounts, "sub_total") || moneyString(data?.sub_total);
  const shipping = moneyFromAmounts(amounts, "shipping_cost") || moneyString(data?.shipping_cost);
  const tax = moneyFromAmounts(amounts, "tax") || moneyString(data?.tax);
  const discounts = moneyFromAmounts(amounts, "total_discount") || moneyString(data?.discounts);
  const total =
    moneyFromAmounts(amounts, "total") ||
    moneyString(data?.total) ||
    moneyString(data?.total_cost);
  const currency = firstNonEmpty(
    data?.currency,
    asObject(amounts.total)?.currency,
    asObject(amounts.sub_total)?.currency,
  );
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

function lineItemsFrom(data) {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.cart_items)) return data.cart_items;
  return null;
}

function optionTitle(line) {
  const options = Array.isArray(line?.options) ? line.options : [];
  return options
    .map((option) => firstNonEmpty(option?.value, option?.name, option?.label))
    .filter(Boolean)
    .join(" / ");
}

function normalizeLineItem(line, sourceIntegrationId, catalogMap) {
  const product = asObject(line?.product) || {};
  const productId = asIdString(product.id ?? line?.product_id ?? line?.productId);
  const variantId = asIdString(
    line?.product_sku_id ??
      line?.sku_id ??
      line?.variant_id ??
      asObject(line?.sku)?.id,
  );
  const sku = firstNonEmpty(line?.sku, product.sku, asObject(line?.sku)?.sku);
  const title = firstNonEmpty(line?.name, product.name, line?.title);
  const variantTitle = firstNonEmpty(line?.variant_title, optionTitle(line));
  const name = firstNonEmpty(line?.name, [title, variantTitle].filter(Boolean).join(" - "));
  const quantity = Number(line?.quantity);
  const unitPrice =
    moneyFromAmounts(line?.amounts, "price_without_tax") ||
    moneyFromAmounts(line?.amounts, "price") ||
    moneyString(line?.price);
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
    total_discount: moneyFromAmounts(line?.amounts, "total_discount") || moneyString(line?.total_discount),
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
    salla: {
      line_item_id: asIdString(line?.id) || null,
      product_sku_id: variantId || null,
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

function sallaMetadata(
  data,
  { event, merchantId, createdAt, requestId, ingestedVia, existingSalla } = {},
) {
  const previous = asObject(existingSalla) || {};
  const status = statusInfo(data);
  return {
    order_id: sallaExternalOrderId(data) || null,
    reference_id: asIdString(data?.reference_id) || null,
    merchant: merchantId ? String(merchantId) : firstNonEmpty(previous.merchant) || null,
    event: event || null,
    provider_status: status.slug || null,
    provider_status_name: status.name || null,
    created_at: sallaDateRaw(data?.date || data?.created_at) || previous.created_at || null,
    updated_at: sallaDateRaw(data?.updated_at) || previous.updated_at || null,
    webhook_created_at: firstNonEmpty(createdAt, previous.webhook_created_at) || null,
    request_id: firstNonEmpty(requestId) || previous.request_id || null,
    ingested_via: firstNonEmpty(previous.ingested_via, ingestedVia) || null,
    last_ingested_via: firstNonEmpty(ingestedVia, previous.last_ingested_via) || null,
    payment_method: firstNonEmpty(data?.payment_method, data?.paymentMethod) || null,
    source: firstNonEmpty(data?.source) || null,
    shipping_address: snapshotAddress(asObject(data?.shipping)?.address || data?.shipping_address),
    customer: snapshotCustomer(data?.customer),
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

function declaredItemCount(data) {
  const n = Number(
    data?.items_count ?? data?.itemsCount ?? data?.products_count ?? data?.productsCount,
  );
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sallaLineItemsComplete(data) {
  const items = lineItemsFrom(data);
  if (!Array.isArray(items)) return false;
  const declared = declaredItemCount(data);
  if (declared != null && declared > items.length) return false;
  if (!items.length) return declared == null || declared === 0;
  return items.every((line) => {
    const productId = asIdString(asObject(line?.product)?.id ?? line?.product_id ?? line?.productId);
    return Boolean(productId);
  });
}

function hasUsableCart(data) {
  const items = lineItemsFrom(data);
  return Array.isArray(items) && items.length > 0;
}

function hasUsableTotals(data) {
  const amounts = asObject(data?.amounts);
  return Boolean(
    moneyFromAmounts(amounts, "total") ||
      moneyString(data?.total) ||
      moneyString(data?.total_cost),
  );
}

function needsSallaOrderEnrichment(event, data) {
  const ev = String(event || "").trim().toLowerCase();
  if (ev !== "order.created" && ev !== "order.updated") return false;
  if (!sallaExternalOrderId(data)) return false;
  return !(hasUsableCart(data) && hasUsableTotals(data));
}

async function maybeEnrichSallaOrderData(input, data, existingRow) {
  if (!needsSallaOrderEnrichment(input.event, data)) return data;
  if (!input.integration || !input.integration.id) {
    if (existingRow) return data;
    throw sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla order payload is incomplete and cannot be enriched",
      502,
    );
  }
  try {
    const fetched = await sallaGetOrder({
      integration: input.integration,
      orderId: sallaExternalOrderId(data),
    });
    const order = asObject(fetched.order) || {};
    const fetchedId = sallaExternalOrderId(order);
    const webhookId = sallaExternalOrderId(data);
    return {
      ...data,
      ...order,
      id: webhookId || fetchedId,
    };
  } catch (error) {
    if (existingRow) return data;
    throw error;
  }
}

async function normalizeSallaOrder(input = {}) {
  const companyId = String(input.companyId || "").trim();
  const sourceIntegrationId = String(input.sourceIntegrationId || "").trim();
  const event = String(input.event || "").trim().toLowerCase();
  const merchantId = firstNonEmpty(input.merchantId);
  const data = asObject(input.data) || {};
  const existingRow = input.existingRow || null;
  const existingRaw = asObject(existingRow?.raw_data) || {};
  const stale = Boolean(input.stale);

  if (!companyId || !sourceIntegrationId) {
    throw sallaError(
      "SALLA_INTEGRATION_REQUIRED",
      "Salla order persistence requires company and source integration context",
      400,
    );
  }

  const externalId = sallaExternalOrderId(data);
  if (!externalId) {
    throw sallaError("SALLA_ORDER_ID_REQUIRED", "Salla order id is required", 400);
  }

  const lineItems = lineItemsFrom(data);
  const productIds = (lineItems || [])
    .map((line) => asIdString(asObject(line?.product)?.id ?? line?.product_id))
    .filter(Boolean);
  const catalogMap =
    input.catalogMap instanceof Map
      ? input.catalogMap
      : await loadCatalogProductMap(sourceIntegrationId, productIds);

  const customer = normalizeCustomer(data);
  const address = normalizeAddress(data);
  const totals = normalizeTotals(data);
  const incomingCart = lineItems
    ? lineItems.map((line) => normalizeLineItem(line, sourceIntegrationId, catalogMap))
    : null;
  const existingStatus = existingRow?.status || existingRaw.status || null;
  const status = resolveSallaErpStatus({ event, data, existingStatus });
  const pay = firstNonEmpty(data?.payment_method, data?.paymentMethod);

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
  ];
  for (const key of mergeKeys) {
    mergedCustomerAddressTotals[key] = stale
      ? keepUseful(undefined, existingRaw[key])
      : keepUseful(incoming[key], existingRaw[key]);
  }

  const cart_items = stale
    ? keepUseful(undefined, existingRaw.cart_items || existingRaw.cartItems)
    : keepUseful(incoming.cart_items, existingRaw.cart_items || existingRaw.cartItems);

  const salla = {
    ...(asObject(existingRaw.salla) || {}),
    ...sallaMetadata(data, {
      event,
      merchantId,
      createdAt: input.createdAt,
      requestId: input.requestId,
      ingestedVia: input.ingestedVia,
      existingSalla: existingRaw.salla,
    }),
  };
  if (stale && asObject(existingRaw.salla)?.updated_at) {
    salla.updated_at = existingRaw.salla.updated_at;
    salla.created_at = existingRaw.salla.created_at || salla.created_at;
    if (!isSallaCancelled(event, data)) {
      salla.provider_status = existingRaw.salla.provider_status || salla.provider_status;
      salla.provider_status_name =
        existingRaw.salla.provider_status_name || salla.provider_status_name;
    }
  }

  let raw_data = {
    ...existingRaw,
    ...mergedCustomerAddressTotals,
    cart_items: Array.isArray(cart_items) ? cart_items : [],
    cartItems: Array.isArray(cart_items) ? cart_items : [],
    provider: "salla",
    platform: "salla",
    ingestion_source: "salla",
    ingestionSource: "salla",
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
    salla,
  };

  delete raw_data.company_id;
  delete raw_data.companyId;
  delete raw_data.selectedSystem;
  delete raw_data.event;
  delete raw_data.merchant;
  delete raw_data.data;
  delete raw_data.easyorders_status;
  delete raw_data.easyOrdersStatus;
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
    cancelled: isSallaCancelled(event, data),
  };
}

async function findExistingSallaOrder(externalOrderId, sourceIntegrationId) {
  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .select("*")
    .eq("order_id", String(externalOrderId))
    .eq("source_integration_id", sourceIntegrationId);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length > 1) {
    const ambiguous = new Error("Multiple local orders match this Salla order id");
    ambiguous.code = "ORDER_AMBIGUOUS";
    ambiguous.statusCode = 409;
    throw ambiguous;
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
    ingestion_source: "salla",
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

async function persistSallaOrder(input = {}) {
  const tenantId = requireActiveCompanyId();
  const companyId = String(input.companyId || "").trim();
  const sourceIntegrationId = String(input.sourceIntegrationId || "").trim();
  if (!companyId || String(companyId) !== String(tenantId)) {
    throw sallaError("WEBHOOK_UNAUTHORIZED", "Salla webhook tenant context is invalid", 401);
  }
  if (!sourceIntegrationId) {
    throw sallaError(
      "SALLA_INTEGRATION_REQUIRED",
      "Salla webhook source integration is required",
      400,
    );
  }

  const seedData = asObject(input.data) || {};
  const seedId = sallaExternalOrderId(seedData);
  if (!seedId) {
    throw sallaError("SALLA_ORDER_ID_REQUIRED", "Salla order id is required", 400);
  }

  const existingRow = await findExistingSallaOrder(seedId, sourceIntegrationId);
  const data = await maybeEnrichSallaOrderData(input, seedData, existingRow);
  const stale = existingRow ? isOlderSallaPayload(existingRow.raw_data, data) : false;
  const normalized = await normalizeSallaOrder({
    ...input,
    companyId,
    sourceIntegrationId,
    data,
    existingRow,
    stale,
  });

  const { getWebhookOrderById } = require("./webhookOrders.service");

  if (existingRow?.id) {
    const orderReference = readOrderReferenceFromRow(existingRow);
    const persistPayload = persistPayloadFromNormalized(normalized, { orderReference });
    delete persistPayload.created_at;
    const { data: updated, error } = await supabase
      .from(ORDERS_TABLE)
      .update(persistPayload)
      .eq("id", existingRow.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return getWebhookOrderById(updated.id);
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
    const { data: inserted, error } = await supabase
      .from(ORDERS_TABLE)
      .insert(persistPayload)
      .select()
      .single();
    if (!error) {
      return getWebhookOrderById(inserted.id);
    }
    const dup =
      String(error.message || "").includes("duplicate") ||
      String(error.code || "") === "23505";
    if (dup) {
      const raced = await findExistingSallaOrder(seedId, sourceIntegrationId);
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
  throw new Error(lastError?.message || "Failed to persist Salla order");
}

module.exports = {
  persistSallaOrder,
  normalizeSallaOrder,
  findExistingSallaOrder,
  sallaExternalOrderId,
  isSallaCancelled,
  needsSallaOrderEnrichment,
  sallaLineItemsComplete,
  hasUsableCart,
  hasUsableTotals,
  lineItemsFrom,
};
