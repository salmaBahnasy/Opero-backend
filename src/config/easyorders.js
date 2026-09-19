const DEFAULT_EASYORDERS_API_BASE =
  "https://api.easy-orders.net/api/v1/external-apps";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function looksLikeIpv4(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function looksLikeIpv6(hostname) {
  return hostname.includes(":");
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;
  if (looksLikeIpv4(host) || looksLikeIpv6(host)) return true;
  return false;
}

function easyOrdersBaseError(message) {
  const error = new Error(message);
  error.code = "EASYORDERS_API_BASE_INVALID";
  return error;
}

/**
 * Server-controlled EasyOrders Admin/external-apps origin.
 * Company credentials must never override host, protocol, port, or path.
 */
function getTrustedEasyOrdersApiBaseUrl(env = process.env) {
  const raw = firstNonEmpty(
    env.EASYORDERS_API_BASE_URL,
    env.EASYORDER_API_BASE_URL,
    DEFAULT_EASYORDERS_API_BASE,
  );
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw easyOrdersBaseError("EasyOrders API base URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw easyOrdersBaseError("EasyOrders API base URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw easyOrdersBaseError("EasyOrders API base URL must not include credentials");
  }
  if (parsed.port) {
    throw easyOrdersBaseError("EasyOrders API base URL must not include a port");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw easyOrdersBaseError("EasyOrders API base URL host is not allowed");
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "";
  return `${parsed.origin}${path}`;
}

module.exports = {
  DEFAULT_EASYORDERS_API_BASE,
  getTrustedEasyOrdersApiBaseUrl,
};
