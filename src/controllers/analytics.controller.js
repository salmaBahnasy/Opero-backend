const { getCompanyId } = require("../middlewares/tenant.middleware");
const { sendKnownServiceError } = require("../utils/httpErrors");
const {
  resolveEasyOrderDateRange,
  resolveEgyptPresetRange,
} = require("../utils/dateRange");
const {
  resolveSourceFilter,
  getAnalyticsOverview,
  getAnalyticsTrend,
  getAnalyticsStatuses,
  getAnalyticsStores,
  getAnalyticsProducts,
} = require("../services/analytics.service");

function optionalQuery(value) {
  if (value == null) return "";
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").trim();
}

function resolveAnalyticsRange(req) {
  const preset = optionalQuery(req.query.preset);
  const presetRange = resolveEgyptPresetRange(preset);
  if (presetRange) {
    return { ...presetRange, preset };
  }
  const { from, to } = resolveEasyOrderDateRange(req);
  if (!from || !to) {
    const err = new Error("from and to are required");
    err.code = "INVALID_FROM";
    throw err;
  }
  return { from, to, preset: preset || "custom" };
}

async function resolveAnalyticsScope(req) {
  if (optionalQuery(req.query.companyId) || optionalQuery(req.body?.companyId)) {
    // JWT tenant wins; ignore client companyId rather than treating it as authority.
  }
  const { from, to, preset } = resolveAnalyticsRange(req);
  if (from.getTime() > to.getTime()) {
    const err = new Error("from must be before to");
    err.code = "INVALID_FROM";
    throw err;
  }
  const source = await resolveSourceFilter(
    optionalQuery(
      req.query.source_integration_id || req.query.sourceIntegrationId,
    ),
  );
  return {
    companyId: getCompanyId(req),
    from,
    to,
    preset,
    source,
    granularity: optionalQuery(req.query.granularity).toLowerCase(),
  };
}

function sendAnalyticsError(res, error) {
  if (error?.code === "INVALID_FROM" || error?.code === "INVALID_TO") {
    res.status(400).json({ success: false, message: error.message });
    return true;
  }
  if (error?.code === "INVALID_SOURCE_INTEGRATION") {
    res.status(400).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return true;
  }
  if (sendKnownServiceError(res, error)) return true;
  if (error?.code === "ANALYTICS_QUERY_FAILED") {
    console.error("analytics query failed", error);
    res.status(500).json({
      success: false,
      message: error.publicMessage || "Failed to load analytics",
    });
    return true;
  }
  return false;
}

function ok(res, payload) {
  res.json({ success: true, ...payload });
}

async function getOverview(req, res) {
  try {
    const scope = await resolveAnalyticsScope(req);
    const overview = await getAnalyticsOverview(scope);
    ok(res, {
      filters: {
        from: scope.from.toISOString(),
        to: scope.to.toISOString(),
        preset: scope.preset,
        source_integration_id:
          scope.source.kind === "store"
            ? scope.source.id
            : scope.source.kind === "manual"
              ? "manual"
              : null,
      },
      overview,
    });
  } catch (error) {
    if (sendAnalyticsError(res, error)) return;
    console.error("analytics overview failed", error);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
}

async function getTrend(req, res) {
  try {
    const scope = await resolveAnalyticsScope(req);
    const trend = await getAnalyticsTrend(scope);
    ok(res, { trend });
  } catch (error) {
    if (sendAnalyticsError(res, error)) return;
    console.error("analytics trend failed", error);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
}

async function getStatuses(req, res) {
  try {
    const scope = await resolveAnalyticsScope(req);
    const statuses = await getAnalyticsStatuses(scope);
    ok(res, { statuses });
  } catch (error) {
    if (sendAnalyticsError(res, error)) return;
    console.error("analytics statuses failed", error);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
}

async function getStores(req, res) {
  try {
    const scope = await resolveAnalyticsScope(req);
    const stores = await getAnalyticsStores(scope);
    ok(res, { stores });
  } catch (error) {
    if (sendAnalyticsError(res, error)) return;
    console.error("analytics stores failed", error);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
}

async function getProducts(req, res) {
  try {
    const scope = await resolveAnalyticsScope(req);
    const products = await getAnalyticsProducts(scope);
    ok(res, { products });
  } catch (error) {
    if (sendAnalyticsError(res, error)) return;
    console.error("analytics products failed", error);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
}

module.exports = {
  getOverview,
  getTrend,
  getStatuses,
  getStores,
  getProducts,
};
