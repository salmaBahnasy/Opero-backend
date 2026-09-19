const { requireActiveCompanyId } = require("../utils/tenantScope");
const {
  sallaError,
  assertSallaConnection,
  settingsOf,
} = require("./sallaAuth.service");
const { sallaGetOrders, sallaGetOrder } = require("./sallaClient.service");
const {
  persistSallaOrder,
  findExistingSallaOrder,
  sallaExternalOrderId,
  isSallaCancelled,
  sallaLineItemsComplete,
  hasUsableTotals,
} = require("./sallaOrders.service");

const ORDER_PAGE_SIZE = 30;
const MAX_ORDER_PAGES = 5;
const MAX_DETAIL_FETCHES = ORDER_PAGE_SIZE * MAX_ORDER_PAGES;
const MAX_RANGE_DAYS = 31;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

function importError(code, message, statusCode = 400) {
  return sallaError(code, message, statusCode);
}

function parseCalendarDate(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    throw importError(
      "SALLA_IMPORT_RANGE_INVALID",
      `Import ${label} is required`,
    );
  }
  // Strict YYYY-MM-DD only. Do not Date.parse ISO timestamps — that shifts Egypt calendar days.
  const match = text.match(CALENDAR_DATE);
  if (!match) {
    throw importError(
      "SALLA_IMPORT_RANGE_INVALID",
      "Import from/to must be YYYY-MM-DD calendar dates",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw importError(
      "SALLA_IMPORT_RANGE_INVALID",
      "Import from/to must be valid calendar dates",
    );
  }
  return text;
}

function calendarDaysInclusive(fromYmd, toYmd) {
  const fromMatch = fromYmd.match(CALENDAR_DATE);
  const toMatch = toYmd.match(CALENDAR_DATE);
  const fromMs = Date.UTC(
    Number(fromMatch[1]),
    Number(fromMatch[2]) - 1,
    Number(fromMatch[3]),
  );
  const toMs = Date.UTC(
    Number(toMatch[1]),
    Number(toMatch[2]) - 1,
    Number(toMatch[3]),
  );
  return Math.round((toMs - fromMs) / 86400000) + 1;
}

function validateSallaImportRange(fromRaw, toRaw) {
  const from = parseCalendarDate(fromRaw, "from");
  const to = parseCalendarDate(toRaw, "to");
  const days = calendarDaysInclusive(from, to);
  if (days < 1) {
    throw importError(
      "SALLA_IMPORT_RANGE_INVALID",
      "Import from must be less than or equal to to",
    );
  }
  if (days > MAX_RANGE_DAYS) {
    throw importError(
      "SALLA_IMPORT_RANGE_TOO_LARGE",
      `Import range cannot exceed ${MAX_RANGE_DAYS} days. Import month-by-month.`,
    );
  }
  return { from, to, days, inclusive: true };
}

function unwrapSallaOrderList(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.data?.data)
      ? root.data.data
      : Array.isArray(root.orders)
        ? root.orders
        : null;
  const pagination = asObject(root.pagination) || asObject(root.data?.pagination) || {};
  return { list, pagination };
}

function paginationPage(pagination, fallback) {
  const current = Number(
    pagination?.currentPage ?? pagination?.current_page ?? fallback,
  );
  const totalPages = Number(
    pagination?.totalPages ?? pagination?.total_pages ?? current,
  );
  return {
    currentPage: Number.isFinite(current) && current > 0 ? current : fallback,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : fallback,
  };
}

function listedOrderNeedsDetail(data) {
  if (!sallaLineItemsComplete(data)) return true;
  if (!hasUsableTotals(data)) return true;
  const customer = asObject(data?.customer);
  const shipping = asObject(data?.shipping);
  const hasCustomer = Boolean(
    firstNonEmpty(customer?.mobile, customer?.phone, customer?.email, customer?.first_name),
  );
  const hasAddress = Boolean(
    asObject(shipping?.address) || asObject(data?.shipping_address) || asObject(data?.address),
  );
  return !(hasCustomer && hasAddress);
}

function isProviderAbort(error) {
  if (error?.httpStatus === 404 || error?.httpStatus === 400) return false;
  return (
    error?.code === "SALLA_CREDENTIALS_INVALID" ||
    error?.code === "SALLA_AUTHORIZATION_REVOKED" ||
    error?.code === "SALLA_PROVIDER_UNAVAILABLE" ||
    error?.code === "SALLA_RATE_LIMITED" ||
    error?.code === "SALLA_INTEGRATION_REQUIRED" ||
    error?.code === "SALLA_AUTHORIZATION_PENDING" ||
    error?.code === "SALLA_AUTHORIZATION_LEGACY" ||
    error?.code === "INTEGRATION_DISABLED" ||
    error?.code === "INTEGRATION_NOT_OWNED" ||
    error?.code === "INTEGRATION_NOT_FOUND" ||
    error?.code === "SALLA_IMPORT_RANGE_INVALID" ||
    error?.code === "SALLA_IMPORT_RANGE_TOO_LARGE"
  );
}

function safeOrderRef(data, fallbackId) {
  return firstNonEmpty(
    data?.reference_id,
    sallaExternalOrderId(data),
    fallbackId,
  );
}

function sanitizeImportError(error, { order, orderId } = {}) {
  return {
    code: error?.code || "SALLA_ORDER_PERSIST_FAILED",
    message: error?.message || "Failed to persist Salla order",
    order: order || undefined,
    orderId: orderId || undefined,
  };
}

async function loadOrderForImport({ integration, listed, detailsFetched }) {
  const seed = asObject(listed) || {};
  const externalId = sallaExternalOrderId(seed);
  if (!externalId) {
    const error = importError(
      "SALLA_ORDER_ID_REQUIRED",
      "Salla order id is required",
    );
    error.skip = true;
    throw error;
  }
  if (!listedOrderNeedsDetail(seed)) {
    return seed;
  }
  if (detailsFetched.count >= MAX_DETAIL_FETCHES) {
    const error = importError(
      "SALLA_ORDER_DETAIL_FAILED",
      "Salla order detail fetch bound reached for this import request",
    );
    error.skip = true;
    throw error;
  }
  detailsFetched.count += 1;
  try {
    const fetched = await sallaGetOrder({
      integration,
      orderId: externalId,
    });
    const order = asObject(fetched.order) || {};
    return {
      ...seed,
      ...order,
      id: sallaExternalOrderId(order) || externalId,
    };
  } catch (error) {
    if (isProviderAbort(error)) throw error;
    const failed = importError(
      "SALLA_ORDER_DETAIL_FAILED",
      "Salla order detail could not be loaded",
    );
    failed.skip = true;
    throw failed;
  }
}

async function importOneSallaOrder({
  companyId,
  sourceIntegrationId,
  integration,
  merchantId,
  listed,
  detailsFetched,
  errors,
}) {
  let data;
  try {
    data = await loadOrderForImport({ integration, listed, detailsFetched });
  } catch (error) {
    if (isProviderAbort(error)) throw error;
    errors.push(
      sanitizeImportError(error, {
        order: safeOrderRef(listed),
        orderId: sallaExternalOrderId(listed) || undefined,
      }),
    );
    return "skipped";
  }

  const externalId = sallaExternalOrderId(data);
  if (!externalId) {
    errors.push({
      code: "SALLA_ORDER_ID_REQUIRED",
      message: "Salla order id is required",
      order: safeOrderRef(data, listed),
    });
    return "skipped";
  }
  if (!sallaLineItemsComplete(data)) {
    errors.push({
      code: "SALLA_ORDER_ITEMS_TRUNCATED",
      message: "Salla order items are incomplete and were not persisted",
      order: safeOrderRef(data),
      orderId: externalId,
    });
    return "skipped";
  }

  const cancelled = isSallaCancelled(null, data);
  const event = cancelled ? "order.cancelled" : "order.updated";
  try {
    const existing = await findExistingSallaOrder(externalId, sourceIntegrationId);
    await persistSallaOrder({
      companyId,
      sourceIntegrationId,
      integration,
      merchantId,
      event,
      data,
      ingestedVia: "historical_import",
    });
    return existing?.id ? "updated" : "created";
  } catch (error) {
    if (isProviderAbort(error)) throw error;
    errors.push(
      sanitizeImportError(error, {
        order: safeOrderRef(data),
        orderId: externalId,
      }),
    );
    return "skipped";
  }
}

async function importSallaOrders({ integration, from, to, page } = {}) {
  const companyId = requireActiveCompanyId();
  const row = assertSallaConnection(integration, companyId);
  if (String(row.company_id || companyId) !== String(companyId)) {
    throw importError(
      "INTEGRATION_NOT_OWNED",
      "Integration connection is not owned by this company",
      403,
    );
  }

  const range = validateSallaImportRange(from, to);
  const sourceIntegrationId = String(row.id);
  const merchantId = firstNonEmpty(row.provider_account_id, settingsOf(row).merchantId);
  let currentPage = Math.max(1, Number(page) || 1);
  let pagesFetched = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  const detailsFetched = { count: 0 };
  let lastHasMore = false;
  let nextPage = null;

  while (pagesFetched < MAX_ORDER_PAGES) {
    const result = await sallaGetOrders({
      integration: row,
      page: currentPage,
      perPage: ORDER_PAGE_SIZE,
      fromDate: range.from,
      toDate: range.to,
    });
    const { list, pagination } = unwrapSallaOrderList(result.payload);
    if (!Array.isArray(list)) {
      throw importError(
        "SALLA_PROVIDER_UNAVAILABLE",
        "Salla order list response is invalid",
        502,
      );
    }
    pagesFetched += 1;
    const pages = paginationPage(pagination, currentPage);

    for (const listed of list) {
      const outcome = await importOneSallaOrder({
        companyId,
        sourceIntegrationId,
        integration: row,
        merchantId,
        listed,
        detailsFetched,
        errors,
      });
      if (outcome === "created") created += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;
    }

    lastHasMore = pages.currentPage < pages.totalPages;
    nextPage = lastHasMore ? pages.currentPage + 1 : null;
    if (!lastHasMore) break;
    currentPage = pages.currentPage + 1;
  }

  return {
    provider: "salla",
    integrationId: sourceIntegrationId,
    from: range.from,
    to: range.to,
    processed: created + updated + skipped,
    created,
    updated,
    skipped,
    pagesFetched,
    pageSize: ORDER_PAGE_SIZE,
    maxPages: MAX_ORDER_PAGES,
    hasMore: Boolean(lastHasMore && nextPage),
    nextPage: lastHasMore ? nextPage : null,
    errors,
  };
}

module.exports = {
  importSallaOrders,
  validateSallaImportRange,
  parseCalendarDate,
  unwrapSallaOrderList,
  listedOrderNeedsDetail,
  ORDER_PAGE_SIZE,
  MAX_ORDER_PAGES,
  MAX_DETAIL_FETCHES,
  MAX_RANGE_DAYS,
};
