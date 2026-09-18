/**
 * Short-lived in-memory cache for dashboard endpoints (stats / trend / order-cost).
 * Keyed by stable JSON of filters. Default TTL 60s.
 */

const DEFAULT_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS) || 60_000;

/** @type {Map<string, { expiresAt: number, value: any }>} */
const store = new Map();

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function buildCacheKey(namespace, payload) {
  const companyId = String(payload?.companyId || "").trim();
  if (!companyId) {
    const error = new Error("Dashboard cache payload must include companyId");
    error.code = "TENANT_CONTEXT_MISSING";
    throw error;
  }
  return `${namespace}:${companyId}:${stableStringify(payload)}`;
}

function getCached(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, {
    expiresAt: Date.now() + Math.max(1_000, ttlMs),
    value,
  });
  // Opportunistic prune when large
  if (store.size > 200) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now > v.expiresAt) store.delete(k);
    }
  }
}

async function withCache(namespace, payload, fn, ttlMs = DEFAULT_TTL_MS) {
  const key = buildCacheKey(namespace, payload);
  const hit = getCached(key);
  if (hit != null) {
    return { value: hit, cacheHit: true };
  }
  const value = await fn();
  setCached(key, value, ttlMs);
  return { value, cacheHit: false };
}

function clearDashboardCache(companyId) {
  const scoped = String(companyId || "").trim();
  if (!scoped) {
    store.clear();
    return;
  }
  const needle = `:${scoped}:`;
  for (const key of [...store.keys()]) {
    if (key.includes(needle)) {
      store.delete(key);
    }
  }
}

module.exports = {
  withCache,
  getCached,
  setCached,
  buildCacheKey,
  clearDashboardCache,
  DEFAULT_TTL_MS,
};
