const tenantSupabase = require("../config/tenantSupabase");
const supabase = require("../config/supabase");
const { requireActiveCompanyId } = require("../utils/tenantScope");
const {
  listEgyptTrendBucketKeys,
  egyptLocalToUtc,
  getZonedParts,
  previousEquivalentRange,
} = require("../utils/dateRange");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";
const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";

const MANUAL_SOURCE = "manual";
const MANUAL_DISPLAY_NAME = "يدوي / قديم";
const SOURCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_SELECT =
  "status, orders_count:count(), gross:total_amount.sum()";
const STORE_SELECT =
  "source_integration_id, orders_count:count(), gross:total_amount.sum()";
const TOTAL_SELECT = "orders_count:count(), gross:total_amount.sum()";

const TOP_PRODUCTS_LIMIT = 10;
const TOP_PRODUCTS_SCAN_CAP = 1500;
const MAX_TREND_BUCKETS = 32;
const LEGACY_AMOUNT_CAP = 2000;
const IN_CHUNK_SIZE = 120;

const KNOWN_STATUSES = [
  "canceled",
  "new",
  "pending",
  "no_replay",
  "follow up",
  "repeater",
  "Confirmed",
  "Shipped",
];

let queryLog = [];
let lastTiming = null;

function analyticsTimingEnabled() {
  return (
    process.env.NODE_ENV === "test" || process.env.ANALYTICS_TIMING === "1"
  );
}

function resetAnalyticsQueryLog() {
  queryLog = [];
  lastTiming = null;
}

function getAnalyticsQueryLog() {
  return queryLog.slice();
}

function getLastAnalyticsTiming() {
  return lastTiming;
}

function trackQuery(entry) {
  if (analyticsTimingEnabled()) {
    queryLog.push({ at: Date.now(), ...entry });
  }
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function roundRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toGross(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function averageOrderValue(gross, orders) {
  if (!orders) return 0;
  return roundMoney(gross / orders);
}

function cancellationRate(canceled, orders) {
  if (!orders) return 0;
  return roundRate(canceled / orders);
}

function percentChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0 && cur === 0) {
    return { current: cur, previous: prev, percentChange: 0, kind: "no_change" };
  }
  if (prev === 0 && cur > 0) {
    return {
      current: cur,
      previous: prev,
      percentChange: null,
      kind: "new_activity",
    };
  }
  const pct = ((cur - prev) / prev) * 100;
  const safe = Number.isFinite(pct) ? Math.round(pct * 10) / 10 : 0;
  let kind = "no_change";
  if (safe > 0) kind = "increase";
  if (safe < 0) kind = "decrease";
  return { current: cur, previous: prev, percentChange: safe, kind };
}

function invalidSourceError(message) {
  const error = new Error(message);
  error.code = "INVALID_SOURCE_INTEGRATION";
  return error;
}

function dbError(context) {
  const error = new Error(`Failed to load ${context}`);
  error.code = "ANALYTICS_QUERY_FAILED";
  error.publicMessage = "Failed to load analytics";
  return error;
}

async function resolveSourceFilter(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "all", id: null };
  if (value === MANUAL_SOURCE || value === "legacy") {
    return { kind: "manual", id: null };
  }
  if (!SOURCE_UUID.test(value)) {
    throw invalidSourceError("Invalid source_integration_id filter");
  }
  const companyId = requireActiveCompanyId();
  const started = process.hrtime.bigint();
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("id,company_id")
    .eq("id", value)
    .maybeSingle();
  trackQuery({
    table: INTEGRATIONS_TABLE,
    select: "id,company_id",
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    returned: data ? 1 : 0,
  });
  if (error) throw dbError("analytics");
  if (!data || String(data.company_id) !== String(companyId)) {
    const notFound = new Error("Integration connection not found");
    notFound.code = "INTEGRATION_NOT_FOUND";
    throw notFound;
  }
  return { kind: "store", id: value };
}

function applyOrderScope(query, { from, to, source }) {
  let q = query;
  if (from) q = q.gte("created_at", from.toISOString());
  if (to) q = q.lte("created_at", to.toISOString());
  if (source?.kind === "manual") {
    q = q.is("source_integration_id", null);
  } else if (source?.kind === "store" && source.id) {
    q = q.eq("source_integration_id", source.id);
  }
  return q;
}

async function runAggregate(select, { from, to, source, extra } = {}) {
  const started = process.hrtime.bigint();
  let query = applyOrderScope(
    tenantSupabase.from(ORDERS_TABLE).select(select),
    { from, to, source },
  );
  if (typeof extra === "function") query = extra(query);
  const { data, error, count } = await query;
  trackQuery({
    table: ORDERS_TABLE,
    select,
    source: source?.kind || "all",
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    returned: Array.isArray(data) ? data.length : 0,
    count: count ?? null,
  });
  if (error) throw dbError("analytics");
  return Array.isArray(data) ? data : [];
}

function emptyTotals() {
  return {
    totalOrders: 0,
    grossOrderValue: 0,
    averageOrderValue: 0,
    canceledOrders: 0,
    cancellationRate: 0,
  };
}

function totalsFromStatusRows(rows) {
  let totalOrders = 0;
  let grossOrderValue = 0;
  let canceledOrders = 0;
  for (const row of rows || []) {
    const orders = toCount(row.orders_count);
    const gross = toGross(row.gross);
    totalOrders += orders;
    grossOrderValue += gross;
    if (String(row.status || "").trim() === "canceled") {
      canceledOrders += orders;
    }
  }
  return {
    totalOrders,
    grossOrderValue: roundMoney(grossOrderValue),
    averageOrderValue: averageOrderValue(grossOrderValue, totalOrders),
    canceledOrders,
    cancellationRate: cancellationRate(canceledOrders, totalOrders),
  };
}

function pickLegacyTotal(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const total = Number(raw.total_cost);
  if (Number.isFinite(total)) return total;
  const cost = Number(raw.cost);
  if (Number.isFinite(cost)) return cost;
  return 0;
}

async function addLegacyNullAmountValue(totals, { from, to, source }) {
  const nullCountRows = await runAggregate("orders_count:count()", {
    from,
    to,
    source,
    extra: (q) => q.is("total_amount", null),
  });
  const missing = toCount(nullCountRows[0]?.orders_count);
  if (!missing) {
    return { ...totals, legacyJsonFallbackRows: 0, legacyJsonTruncated: false };
  }

  const started = process.hrtime.bigint();
  let query = applyOrderScope(
    tenantSupabase
      .from(ORDERS_TABLE)
      .select("status,raw_data")
      .is("total_amount", null)
      .limit(LEGACY_AMOUNT_CAP),
    { from, to, source },
  );
  const { data, error } = await query;
  trackQuery({
    table: ORDERS_TABLE,
    select: "status,raw_data",
    note: "legacy_total_amount_null",
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    returned: Array.isArray(data) ? data.length : 0,
  });
  if (error) throw dbError("analytics");

  let extraGross = 0;
  let extraCanceled = 0;
  for (const row of data || []) {
    extraGross += pickLegacyTotal(row.raw_data);
    if (String(row.status || "").trim() === "canceled") extraCanceled += 1;
  }
  const truncated = missing > (data || []).length;
  const totalOrders = totals.totalOrders;
  const grossOrderValue = roundMoney(totals.grossOrderValue + extraGross);
  const canceledOrders = totals.canceledOrders + extraCanceled;
  return {
    totalOrders,
    grossOrderValue,
    averageOrderValue: averageOrderValue(grossOrderValue, totalOrders),
    canceledOrders,
    cancellationRate: cancellationRate(canceledOrders, totalOrders),
    legacyJsonFallbackRows: (data || []).length,
    legacyJsonTruncated: truncated,
  };
}

async function loadPeriodTotals({ from, to, source }) {
  const rows = await runAggregate(STATUS_SELECT, { from, to, source });
  const base = totalsFromStatusRows(rows);
  return addLegacyNullAmountValue(base, { from, to, source });
}

function withComparison(current, previous) {
  return {
    totalOrders: percentChange(current.totalOrders, previous.totalOrders),
    grossOrderValue: percentChange(
      current.grossOrderValue,
      previous.grossOrderValue,
    ),
    averageOrderValue: percentChange(
      current.averageOrderValue,
      previous.averageOrderValue,
    ),
    canceledOrders: percentChange(
      current.canceledOrders,
      previous.canceledOrders,
    ),
    cancellationRate: percentChange(
      current.cancellationRate,
      previous.cancellationRate,
    ),
  };
}

async function loadSafeIntegrations(companyId) {
  const started = process.hrtime.bigint();
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("id,name,provider,category,is_enabled")
    .eq("company_id", companyId);
  trackQuery({
    table: INTEGRATIONS_TABLE,
    select: "id,name,provider,category,is_enabled",
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    returned: Array.isArray(data) ? data.length : 0,
  });
  if (error) throw dbError("store analytics");
  return data || [];
}

function daysInMonth(year, month) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const firstNext = egyptLocalToUtc(nextYear, nextMonth, 1, 0, 0, 0, 0);
  return getZonedParts(new Date(firstNext.getTime() - 1)).day;
}

function clampRange(innerFrom, innerTo, outerFrom, outerTo) {
  const fromMs = Math.max(innerFrom.getTime(), outerFrom.getTime());
  const toMs = Math.min(innerTo.getTime(), outerTo.getTime());
  if (fromMs > toMs) return null;
  return { from: new Date(fromMs), to: new Date(toMs) };
}

function utcRangeForBucket(key, granularity, outerFrom, outerTo) {
  if (granularity === "month") {
    const m = String(key).match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const last = daysInMonth(year, month);
    return clampRange(
      egyptLocalToUtc(year, month, 1, 0, 0, 0, 0),
      egyptLocalToUtc(year, month, last, 23, 59, 59, 999),
      outerFrom,
      outerTo,
    );
  }
  const day = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!day) return null;
  const year = Number(day[1]);
  const month = Number(day[2]);
  const d = Number(day[3]);
  if (granularity === "week") {
    const sunday = new Date(
      egyptLocalToUtc(year, month, d, 12, 0, 0, 0).getTime() + 6 * 86400000,
    );
    const end = getZonedParts(sunday);
    return clampRange(
      egyptLocalToUtc(year, month, d, 0, 0, 0, 0),
      egyptLocalToUtc(end.year, end.month, end.day, 23, 59, 59, 999),
      outerFrom,
      outerTo,
    );
  }
  return clampRange(
    egyptLocalToUtc(year, month, d, 0, 0, 0, 0),
    egyptLocalToUtc(year, month, d, 23, 59, 59, 999),
    outerFrom,
    outerTo,
  );
}

function chooseGranularity(from, to, requested) {
  const allowed = new Set(["day", "week", "month"]);
  let gran = allowed.has(requested) ? requested : null;
  const dayKeys = listEgyptTrendBucketKeys(from, to, "day");
  if (!gran) {
    if (dayKeys.length <= 1) gran = "day";
    else if (dayKeys.length <= 31) gran = "day";
    else if (dayKeys.length <= 180) gran = "week";
    else gran = "month";
  }
  let keys = listEgyptTrendBucketKeys(from, to, gran);
  if (keys.length > MAX_TREND_BUCKETS) {
    if (gran === "day") gran = "week";
    else if (gran === "week") gran = "month";
    keys = listEgyptTrendBucketKeys(from, to, gran);
    if (keys.length > MAX_TREND_BUCKETS) {
      keys = keys.slice(0, MAX_TREND_BUCKETS);
    }
  }
  return { granularity: gran, keys };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function parseCartItems(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  let cart = raw.cart_items ?? raw.cartItems;
  if (cart == null) return [];
  if (typeof cart === "string") {
    try {
      const parsed = JSON.parse(cart);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(cart) ? cart : [];
}

function pickLineQuantity(line) {
  if (!line || typeof line !== "object") return 0;
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  for (const candidate of [
    line.quantity,
    line.qty,
    line.count,
    variant.quantity,
    variant.qty,
    variant.count,
  ]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (
    line.product_id != null ||
    line.productId != null ||
    (line.product && typeof line.product === "object" && line.product.id != null)
  ) {
    return 1;
  }
  return 0;
}

function pickLineUnitPrice(line) {
  if (!line || typeof line !== "object") return 0;
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  for (const candidate of [
    line.price,
    line.unit_price,
    line.unitPrice,
    line.total_price,
    variant.sale_price,
    variant.price,
    product.sale_price,
    product.price,
  ]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function resolveLineProductId(line) {
  if (!line || typeof line !== "object") return "";
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  for (const candidate of [
    line.product_id,
    line.productId,
    line.easyorder_id,
    line.easyorderId,
    product.id,
    product.product_id,
    product.productId,
    product.easyorder_id,
    product.easyorderId,
  ]) {
    if (candidate == null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }
  const sku = firstNonEmpty(product.sku, line.sku, line.variant?.sku);
  return sku ? `sku:${sku}` : "";
}

function resolveLineProductLabel(line) {
  if (!line || typeof line !== "object") return { name: "", sku: "" };
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  return {
    name: firstNonEmpty(
      product.name,
      line.name,
      line.product_name,
      product.title,
      line.title,
    ),
    sku: firstNonEmpty(
      product.sku,
      line.sku,
      variant.sku,
      product.code,
      line.product_sku,
    ),
  };
}

function productIdentityKey(sourceIntegrationId, externalId) {
  const pid = String(externalId || "").trim();
  if (!pid) return "";
  return `${String(sourceIntegrationId || "").trim()}::${pid}`;
}

async function loadProductCatalogMeta(identities) {
  const ids = [
    ...new Set(identities.map((item) => item.externalId).filter(Boolean)),
  ];
  if (!ids.length) return new Map();
  const map = new Map();
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CHUNK_SIZE);
    const started = process.hrtime.bigint();
    const { data, error } = await tenantSupabase
      .from(PRODUCTS_TABLE)
      .select("easyorder_id,name,sku,source_integration_id")
      .in("easyorder_id", chunk);
    trackQuery({
      table: PRODUCTS_TABLE,
      select: "easyorder_id,name,sku,source_integration_id",
      ms: Number(process.hrtime.bigint() - started) / 1e6,
      returned: Array.isArray(data) ? data.length : 0,
    });
    if (error) continue;
    for (const row of data || []) {
      const key = productIdentityKey(
        row.source_integration_id,
        row.easyorder_id,
      );
      if (!key || map.has(key)) continue;
      map.set(key, { name: row.name || "", sku: row.sku || "" });
    }
  }
  return map;
}

async function timed(name, fn) {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (analyticsTimingEnabled()) {
      lastTiming = {
        ...(lastTiming && typeof lastTiming === "object" ? lastTiming : {}),
        [name]: Math.round(ms * 100) / 100,
      };
    }
  }
}

async function getAnalyticsOverview({ from, to, source, preset }) {
  return timed("overview", async () => {
    const previous = previousEquivalentRange({ preset, from, to });
    const [current, prior] = await Promise.all([
      loadPeriodTotals({ from, to, source }),
      loadPeriodTotals({
        from: previous.from,
        to: previous.to,
        source,
      }),
    ]);
    return {
      dateBasis: "orders.created_at",
      dateBasisLabel: "first persisted in this SaaS",
      current: {
        from: from.toISOString(),
        to: to.toISOString(),
        ...current,
      },
      previous: {
        from: previous.from.toISOString(),
        to: previous.to.toISOString(),
        ...prior,
      },
      comparison: withComparison(current, prior),
    };
  });
}

async function getAnalyticsTrend({ from, to, source, granularity }) {
  // TREND_BOUNDED_FALLBACK_RETAINED: PostgREST cannot date_trunc-group without RPC/migration.
  return timed("trend", async () => {
    const chosen = chooseGranularity(from, to, granularity);
    const points = await Promise.all(
      chosen.keys.map(async (date) => {
        const range = utcRangeForBucket(date, chosen.granularity, from, to);
        if (!range) {
          return {
            date,
            ordersCount: 0,
            grossOrderValue: 0,
            averageOrderValue: 0,
          };
        }
        const rows = await runAggregate(TOTAL_SELECT, {
          from: range.from,
          to: range.to,
          source,
        });
        const ordersCount = toCount(rows[0]?.orders_count);
        const grossOrderValue = roundMoney(toGross(rows[0]?.gross));
        return {
          date,
          ordersCount,
          grossOrderValue,
          averageOrderValue: averageOrderValue(grossOrderValue, ordersCount),
        };
      }),
    );
    return {
      dateBasis: "orders.created_at",
      granularity: chosen.granularity,
      from: from.toISOString(),
      to: to.toISOString(),
      points,
    };
  });
}

async function getAnalyticsStatuses({ from, to, source }) {
  return timed("statuses", async () => {
    const rows = await runAggregate(STATUS_SELECT, { from, to, source });
    const byStatus = new Map();
    for (const row of rows) {
      const status = String(row.status || "").trim() || "unknown";
      byStatus.set(status, {
        status,
        ordersCount: toCount(row.orders_count),
        grossOrderValue: roundMoney(toGross(row.gross)),
      });
    }
    const items = [];
    for (const status of KNOWN_STATUSES) {
      if (byStatus.has(status)) items.push(byStatus.get(status));
    }
    for (const [status, item] of byStatus.entries()) {
      if (!KNOWN_STATUSES.includes(status)) items.push(item);
    }
    const totalOrders = items.reduce((sum, item) => sum + item.ordersCount, 0);
    return {
      dateBasis: "orders.created_at",
      label: "حالات الطلبات داخل النظام",
      totalOrders,
      items,
    };
  });
}

async function getAnalyticsStores({ from, to, source }) {
  return timed("stores", async () => {
    const companyId = requireActiveCompanyId();
    const [rows, integrations] = await Promise.all([
      runAggregate(STORE_SELECT, { from, to, source }),
      loadSafeIntegrations(companyId),
    ]);
    const byId = new Map(
      integrations.map((row) => [String(row.id), row]),
    );
    const items = (rows || []).map((row) => {
      const id = row.source_integration_id
        ? String(row.source_integration_id)
        : null;
      const connection = id ? byId.get(id) : null;
      const ordersCount = toCount(row.orders_count);
      const grossOrderValue = roundMoney(toGross(row.gross));
      return {
        integrationId: id,
        displayName: connection?.name || (id ? "متجر" : MANUAL_DISPLAY_NAME),
        provider: connection?.provider || (id ? null : "manual"),
        ordersCount,
        grossOrderValue,
        averageOrderValue: averageOrderValue(grossOrderValue, ordersCount),
      };
    });
    items.sort((a, b) => b.grossOrderValue - a.grossOrderValue);
    return {
      dateBasis: "orders.created_at",
      items,
    };
  });
}

async function getAnalyticsProducts({ from, to, source }) {
  return timed("products", async () => {
    const countRows = await runAggregate("orders_count:count()", {
      from,
      to,
      source,
    });
    const matchedOrders = toCount(countRows[0]?.orders_count);
    const started = process.hrtime.bigint();
    let query = applyOrderScope(
      tenantSupabase
        .from(ORDERS_TABLE)
        .select("source_integration_id,raw_data")
        .order("created_at", { ascending: false })
        .limit(TOP_PRODUCTS_SCAN_CAP),
      { from, to, source },
    );
    const { data, error } = await query;
    trackQuery({
      table: ORDERS_TABLE,
      select: "source_integration_id,raw_data",
      note: "top_products_bounded",
      ms: Number(process.hrtime.bigint() - started) / 1e6,
      returned: Array.isArray(data) ? data.length : 0,
    });
    if (error) throw dbError("product analytics");

    const scanned = data || [];
    const truncated = matchedOrders > scanned.length;
    const productMap = new Map();

    for (const row of scanned) {
      const seenInOrder = new Set();
      const sourceId = row.source_integration_id || "";
      for (const line of parseCartItems(row.raw_data)) {
        const externalId = resolveLineProductId(line);
        if (!externalId) continue;
        const key = productIdentityKey(sourceId, externalId);
        if (!productMap.has(key)) {
          const label = resolveLineProductLabel(line);
          productMap.set(key, {
            identity: key,
            externalId,
            sourceIntegrationId: sourceId || null,
            displayName: label.name,
            sku: label.sku,
            unitsSold: 0,
            ordersCount: 0,
            grossLineValue: 0,
          });
        }
        const entry = productMap.get(key);
        const label = resolveLineProductLabel(line);
        if (!entry.displayName && label.name) entry.displayName = label.name;
        if (!entry.sku && label.sku) entry.sku = label.sku;
        const units = pickLineQuantity(line);
        entry.unitsSold += units;
        entry.grossLineValue += units * pickLineUnitPrice(line);
        if (!seenInOrder.has(key)) {
          seenInOrder.add(key);
          entry.ordersCount += 1;
        }
      }
    }

    const catalog = await loadProductCatalogMeta(
      [...productMap.values()].map((item) => ({
        externalId: item.externalId,
        sourceIntegrationId: item.sourceIntegrationId,
      })),
    );

    const items = [...productMap.values()]
      .map((item) => {
        const meta = catalog.get(item.identity);
        return {
          displayName:
            meta?.name || item.displayName || item.externalId || item.identity,
          sku: meta?.sku || item.sku || null,
          unitsSold: item.unitsSold,
          ordersCount: item.ordersCount,
          grossLineValue: roundMoney(item.grossLineValue),
        };
      })
      .sort((a, b) => b.grossLineValue - a.grossLineValue)
      .slice(0, TOP_PRODUCTS_LIMIT);

    return {
      dateBasis: "orders.created_at",
      bound: TOP_PRODUCTS_SCAN_CAP,
      scannedOrders: scanned.length,
      matchedOrders,
      truncated,
      items,
    };
  });
}

module.exports = {
  MANUAL_SOURCE,
  TOP_PRODUCTS_LIMIT,
  TOP_PRODUCTS_SCAN_CAP,
  MAX_TREND_BUCKETS,
  resolveSourceFilter,
  getAnalyticsOverview,
  getAnalyticsTrend,
  getAnalyticsStatuses,
  getAnalyticsStores,
  getAnalyticsProducts,
  resetAnalyticsQueryLog,
  getAnalyticsQueryLog,
  getLastAnalyticsTiming,
  percentChange,
};
