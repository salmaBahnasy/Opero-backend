const { requireActiveCompanyId } = require("../utils/tenantScope");
const { shopifyGraphql, assertShopifyIntegration } = require("./shopify.service");
const {
  persistShopifyOrder,
  findExistingShopifyOrder,
  numericShopifyId,
} = require("./shopifyOrders.service");

const ORDER_PAGE_SIZE = 50;
const MAX_ORDER_PAGES = 5;
const LINE_PAGE_SIZE = 100;
const MAX_LINE_PAGES = 10;
const MAX_RANGE_DAYS = 31;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

const MONEY_SET = `shopMoney { amount currencyCode }`;

const LINE_ITEM_FIELDS = `
  id
  sku
  name
  title
  variantTitle
  quantity
  originalUnitPriceSet { ${MONEY_SET} }
  discountedUnitPriceSet { ${MONEY_SET} }
  totalDiscountSet { ${MONEY_SET} }
  product {
    id
    legacyResourceId
  }
  variant {
    id
    legacyResourceId
    sku
    title
  }
`;

const SHOPIFY_ORDERS_QUERY = `query ShopifyHistoricalOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      legacyResourceId
      name
      createdAt
      updatedAt
      processedAt
      cancelledAt
      cancelReason
      email
      phone
      note
      tags
      displayFinancialStatus
      displayFulfillmentStatus
      currencyCode
      paymentGatewayNames
      currentSubtotalPriceSet { ${MONEY_SET} }
      currentTotalDiscountsSet { ${MONEY_SET} }
      currentTotalPriceSet { ${MONEY_SET} }
      currentTotalTaxSet { ${MONEY_SET} }
      totalShippingPriceSet { ${MONEY_SET} }
      customer {
        id
        legacyResourceId
        firstName
        lastName
        email
        phone
      }
      shippingAddress {
        name
        firstName
        lastName
        phone
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        company
      }
      billingAddress {
        name
        firstName
        lastName
        phone
        address1
        address2
        city
        province
        provinceCode
        country
        countryCodeV2
        zip
        company
      }
      lineItems(first: ${LINE_PAGE_SIZE}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${LINE_ITEM_FIELDS}
        }
      }
    }
  }
}`;

const SHOPIFY_ORDER_LINE_ITEMS_QUERY = `query ShopifyOrderLineItems($id: ID!, $first: Int!, $after: String) {
  order(id: $id) {
    id
    lineItems(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${LINE_ITEM_FIELDS}
      }
    }
  }
}`;

function importError(code, message, statusCode = 400) {
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

function numericLegacyResourceId(value) {
  const text = firstNonEmpty(value);
  return /^\d+$/.test(text) ? text : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function connectionNodes(connection) {
  const obj = asObject(connection);
  if (!obj) return [];
  if (Array.isArray(obj.nodes)) return obj.nodes;
  if (Array.isArray(obj.edges)) {
    return obj.edges.map((edge) => edge?.node).filter((node) => asObject(node));
  }
  return [];
}

function moneyAmount(set) {
  const obj = asObject(set);
  return firstNonEmpty(
    asObject(obj?.shopMoney)?.amount,
    asObject(obj?.shop_money)?.amount,
  );
}

function lowerStatus(value) {
  const text = firstNonEmpty(value).toLowerCase();
  if (!text || text === "unfulfilled" || text === "none") return null;
  return text;
}

function mapAddress(address) {
  const obj = asObject(address);
  if (!obj) return null;
  const first = firstNonEmpty(obj.firstName, obj.first_name);
  const last = firstNonEmpty(obj.lastName, obj.last_name);
  return {
    name: firstNonEmpty(obj.name, [first, last].filter(Boolean).join(" ")),
    first_name: first || null,
    last_name: last || null,
    phone: firstNonEmpty(obj.phone) || null,
    address1: firstNonEmpty(obj.address1) || null,
    address2: firstNonEmpty(obj.address2) || null,
    city: firstNonEmpty(obj.city) || null,
    province: firstNonEmpty(obj.province) || null,
    province_code: firstNonEmpty(obj.provinceCode, obj.province_code) || null,
    country: firstNonEmpty(obj.country) || null,
    country_code: firstNonEmpty(obj.countryCodeV2, obj.country_code, obj.countryCode) || null,
    zip: firstNonEmpty(obj.zip) || null,
    company: firstNonEmpty(obj.company) || null,
  };
}

function mapCustomer(customer) {
  const obj = asObject(customer);
  if (!obj) return null;
  return {
    id: numericShopifyId(obj.legacyResourceId || obj.id) || null,
    email: firstNonEmpty(obj.email) || null,
    first_name: firstNonEmpty(obj.firstName, obj.first_name) || null,
    last_name: firstNonEmpty(obj.lastName, obj.last_name) || null,
    phone: firstNonEmpty(obj.phone) || null,
  };
}

function mapLineItem(node) {
  const obj = asObject(node) || {};
  const product = asObject(obj.product);
  const variant = asObject(obj.variant);
  const productId = numericShopifyId(product?.legacyResourceId || product?.id);
  const variantId = numericShopifyId(variant?.legacyResourceId || variant?.id);
  const price =
    moneyAmount(obj.discountedUnitPriceSet) || moneyAmount(obj.originalUnitPriceSet);
  return {
    id: numericShopifyId(obj.id) || null,
    admin_graphql_api_id: firstNonEmpty(obj.id) || null,
    product_id: productId || null,
    variant_id: variantId || null,
    sku: firstNonEmpty(obj.sku, variant?.sku) || null,
    title: firstNonEmpty(obj.title, obj.name) || null,
    name: firstNonEmpty(obj.name, obj.title) || null,
    variant_title: firstNonEmpty(obj.variantTitle, variant?.title) || null,
    quantity: Number(obj.quantity) || 0,
    price: price || null,
    total_discount: moneyAmount(obj.totalDiscountSet) || null,
  };
}

function graphqlOrderToWebhookPayload(node, lineItems) {
  const obj = asObject(node) || {};
  const id = numericLegacyResourceId(obj.legacyResourceId);
  const currency = firstNonEmpty(
    obj.currencyCode,
    asObject(asObject(obj.currentTotalPriceSet)?.shopMoney)?.currencyCode,
  );
  const gateways = Array.isArray(obj.paymentGatewayNames)
    ? obj.paymentGatewayNames
    : [];
  const tags = Array.isArray(obj.tags) ? obj.tags.join(", ") : obj.tags;
  return {
    id,
    admin_graphql_api_id: firstNonEmpty(obj.id) || null,
    email: firstNonEmpty(obj.email) || null,
    contact_email: firstNonEmpty(obj.email) || null,
    phone: firstNonEmpty(obj.phone) || null,
    created_at: firstNonEmpty(obj.createdAt, obj.created_at) || null,
    updated_at: firstNonEmpty(obj.updatedAt, obj.updated_at) || null,
    processed_at: firstNonEmpty(obj.processedAt) || null,
    cancelled_at: firstNonEmpty(obj.cancelledAt) || null,
    cancel_reason: firstNonEmpty(obj.cancelReason) || null,
    name: firstNonEmpty(obj.name) || null,
    note: obj.note == null ? null : String(obj.note),
    tags: tags == null ? null : String(tags),
    financial_status: lowerStatus(obj.displayFinancialStatus),
    fulfillment_status: lowerStatus(obj.displayFulfillmentStatus),
    currency: currency || null,
    total_price: moneyAmount(obj.currentTotalPriceSet) || null,
    subtotal_price: moneyAmount(obj.currentSubtotalPriceSet) || null,
    total_discounts: moneyAmount(obj.currentTotalDiscountsSet) || null,
    total_tax: moneyAmount(obj.currentTotalTaxSet) || null,
    total_shipping_price_set: {
      shop_money: {
        amount: moneyAmount(obj.totalShippingPriceSet) || "0.00",
        currency_code: currency || null,
      },
    },
    payment_gateway_names: gateways,
    gateway: firstNonEmpty(gateways[0]) || null,
    customer: mapCustomer(obj.customer),
    shipping_address: mapAddress(obj.shippingAddress),
    billing_address: mapAddress(obj.billingAddress),
    line_items: (lineItems || []).map(mapLineItem),
  };
}

function parseInstant(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    throw importError(
      "SHOPIFY_IMPORT_RANGE_INVALID",
      `Import ${label} is required`,
    );
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw importError(
      "SHOPIFY_IMPORT_RANGE_INVALID",
      "Import from/to must be valid timestamps",
    );
  }
  return { ms, iso: new Date(ms).toISOString() };
}

function validateImportRange(fromRaw, toRaw) {
  const from = parseInstant(fromRaw, "from");
  const to = parseInstant(toRaw, "to");
  if (from.ms > to.ms) {
    throw importError(
      "SHOPIFY_IMPORT_RANGE_INVALID",
      "Import from must be less than or equal to to",
    );
  }
  if (to.ms - from.ms > MAX_RANGE_MS) {
    throw importError(
      "SHOPIFY_IMPORT_RANGE_TOO_LARGE",
      `Import range cannot exceed ${MAX_RANGE_DAYS} days. Import month-by-month.`,
    );
  }
  return { from: from.iso, to: to.iso };
}

function shopifyCreatedAtQuery(fromIso, toIso) {
  return `created_at:>='${fromIso}' AND created_at:<='${toIso}'`;
}

function safeOrderRef(node, payload) {
  return firstNonEmpty(
    payload?.name,
    numericLegacyResourceId(node?.legacyResourceId),
    node?.name,
  );
}

function isProviderAbort(error) {
  return (
    error?.code === "SHOPIFY_CREDENTIALS_INVALID" ||
    error?.code === "SHOPIFY_PROVIDER_UNAVAILABLE" ||
    error?.code === "SHOPIFY_GRAPHQL_ERROR" ||
    error?.code === "SHOPIFY_RATE_LIMITED" ||
    error?.code === "SHOPIFY_SHOP_DOMAIN_REQUIRED" ||
    error?.code === "SHOPIFY_INTEGRATION_REQUIRED" ||
    error?.code === "INTEGRATION_DISABLED"
  );
}

async function fetchRemainingLineItems({
  integration,
  secrets,
  orderGid,
  after,
  collected,
}) {
  let cursor = after || null;
  for (let page = 0; page < MAX_LINE_PAGES; page += 1) {
    const payload = await shopifyGraphql({
      integration,
      secrets,
      query: SHOPIFY_ORDER_LINE_ITEMS_QUERY,
      variables: {
        id: orderGid,
        first: LINE_PAGE_SIZE,
        after: cursor,
      },
    });
    const connection = payload?.data?.order?.lineItems || {};
    collected.push(...connectionNodes(connection));
    if (!connection?.pageInfo?.hasNextPage) {
      return { lineItems: collected, complete: true };
    }
    cursor = connection.pageInfo.endCursor || null;
    if (!cursor) {
      return { lineItems: collected, complete: false };
    }
  }
  return { lineItems: collected, complete: false };
}

async function loadOrderPage({ integration, secrets, query, after }) {
  const payload = await shopifyGraphql({
    integration,
    secrets,
    query: SHOPIFY_ORDERS_QUERY,
    variables: {
      first: ORDER_PAGE_SIZE,
      after: after || null,
      query,
    },
  });
  return payload?.data?.orders || { nodes: [], pageInfo: {} };
}

async function importShopifyOrders({
  integration,
  secrets,
  from,
  to,
  cursor,
} = {}) {
  const companyId = requireActiveCompanyId();
  const resolved = assertShopifyIntegration(integration, secrets);
  if (String(integration.company_id || companyId) !== String(companyId)) {
    throw importError(
      "INTEGRATION_NOT_OWNED",
      "Integration connection is not owned by this company",
      403,
    );
  }

  const range = validateImportRange(from, to);
  const search = shopifyCreatedAtQuery(range.from, range.to);
  const sourceIntegrationId = String(integration.id);
  let after = firstNonEmpty(cursor) || null;
  let pageCount = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  let lastPageInfo = { hasNextPage: false, endCursor: null };

  while (pageCount < MAX_ORDER_PAGES) {
    const connection = await loadOrderPage({
      integration,
      secrets,
      query: search,
      after,
    });
    lastPageInfo = connection.pageInfo || {};
    const nodes = connectionNodes(connection);
    pageCount += 1;

    for (const node of nodes) {
      const externalId = numericLegacyResourceId(node?.legacyResourceId);
      if (!externalId) {
        skipped += 1;
        errors.push({
          code: "SHOPIFY_ORDER_ID_REQUIRED",
          message: "Shopify order is missing a usable numeric legacyResourceId",
          order: safeOrderRef(node, { name: node?.name }),
        });
        continue;
      }

      let lineNodes = connectionNodes(node.lineItems);
      let linesComplete = !node?.lineItems?.pageInfo?.hasNextPage;
      if (!linesComplete) {
        const extra = await fetchRemainingLineItems({
          integration,
          secrets,
          orderGid: node.id,
          after: node.lineItems.pageInfo.endCursor,
          collected: lineNodes,
        });
        lineNodes = extra.lineItems;
        linesComplete = extra.complete;
      }
      if (!linesComplete) {
        skipped += 1;
        errors.push({
          code: "SHOPIFY_ORDER_LINES_TRUNCATED",
          message: "Not all Shopify line items were fetched for this order",
          order: safeOrderRef(node, { name: node.name }),
          orderId: externalId,
        });
        continue;
      }

      const payload = graphqlOrderToWebhookPayload(node, lineNodes);
      const topic = payload.cancelled_at ? "orders/cancelled" : "orders/updated";
      try {
        const existing = await findExistingShopifyOrder(
          externalId,
          sourceIntegrationId,
        );
        await persistShopifyOrder({
          companyId,
          sourceIntegrationId,
          topic,
          shopDomain: resolved.shopDomain,
          payload,
          ingestedVia: "historical_import",
        });
        if (existing?.id) updated += 1;
        else created += 1;
      } catch (error) {
        if (isProviderAbort(error)) throw error;
        skipped += 1;
        errors.push({
          code: error.code || "SHOPIFY_ORDER_IMPORT_FAILED",
          message: error.message || "Failed to persist Shopify order",
          order: safeOrderRef(node, payload),
          orderId: externalId,
        });
      }
    }

    if (!lastPageInfo.hasNextPage) {
      after = lastPageInfo.endCursor || null;
      break;
    }
    after = lastPageInfo.endCursor || null;
    if (!after) break;
  }

  const hasMore = Boolean(lastPageInfo.hasNextPage && after);
  return {
    provider: "shopify",
    integrationId: sourceIntegrationId,
    shopDomain: resolved.shopDomain,
    from: range.from,
    to: range.to,
    processed: created + updated + skipped,
    created,
    updated,
    skipped,
    hasMore,
    nextCursor: hasMore ? after : null,
    pagesFetched: pageCount,
    pageSize: ORDER_PAGE_SIZE,
    maxPages: MAX_ORDER_PAGES,
    errors,
  };
}

module.exports = {
  importShopifyOrders,
  graphqlOrderToWebhookPayload,
  validateImportRange,
  shopifyCreatedAtQuery,
  numericLegacyResourceId,
  SHOPIFY_ORDERS_QUERY,
  SHOPIFY_ORDER_LINE_ITEMS_QUERY,
  ORDER_PAGE_SIZE,
  MAX_ORDER_PAGES,
  LINE_PAGE_SIZE,
  MAX_LINE_PAGES,
  MAX_RANGE_DAYS,
};
