const crypto = require("crypto");
const { decryptSecrets, resolveWebhookByToken } = require("./companyIntegrations.service");
const {
  normalizeShopifyShopDomain,
  shopifyShopDomainsEqual,
} = require("../utils/shopifyDomain");

const ALLOWED_SHOPIFY_ORDER_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/cancelled",
]);

function webhookUnauthorized(message = "Invalid webhook token") {
  const error = new Error(message);
  error.code = "WEBHOOK_UNAUTHORIZED";
  error.statusCode = 401;
  return error;
}

function rawBodyBuffer(req) {
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req?.body)) return req.body;
  if (typeof req?.body === "string") return Buffer.from(req.body);
  return Buffer.alloc(0);
}

function readWebhookSecret(secrets = {}) {
  const value =
    secrets.webhookSecret ||
    secrets.webhook_secret ||
    secrets.clientSecret ||
    secrets.apiSecret ||
    "";
  return String(value || "").trim();
}

function storedShopDomain(integration, secrets = {}) {
  const settings =
    integration?.settings && typeof integration.settings === "object"
      ? integration.settings
      : {};
  return (
    settings.shopDomain ||
    settings.shop_domain ||
    secrets.shopDomain ||
    secrets.shop_domain ||
    ""
  );
}

function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  const header = String(hmacHeader || "").trim();
  const key = String(secret || "").trim();
  if (!header || !key) return false;
  const digest = crypto
    .createHmac("sha256", key)
    .update(rawBody)
    .digest("base64");
  const left = Buffer.from(digest, "utf8");
  const right = Buffer.from(header, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const MAX_SAFE_INTEGER_DIGITS = "9007199254740991";

function quoteUnsafeJsonIntegers(text) {
  return String(text).replace(/:\s*(-?\d+)([,\s}\]])/g, (full, digits, tail) => {
    const abs = digits.charAt(0) === "-" ? digits.slice(1) : digits;
    if (
      abs.length > 16 ||
      (abs.length === 16 && abs > MAX_SAFE_INTEGER_DIGITS)
    ) {
      return `:"${digits}"${tail}`;
    }
    return full;
  });
}

function parseShopifyJson(rawBody) {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    if (!text.trim()) return {};
    const parsed = JSON.parse(quoteUnsafeJsonIntegers(text));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("Shopify webhook JSON is invalid");
      error.code = "SHOPIFY_WEBHOOK_INVALID_JSON";
      error.statusCode = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.code === "SHOPIFY_WEBHOOK_INVALID_JSON") throw error;
    const invalid = new Error("Shopify webhook JSON is invalid");
    invalid.code = "SHOPIFY_WEBHOOK_INVALID_JSON";
    invalid.statusCode = 400;
    throw invalid;
  }
}

/**
 * Resolve the tokenized Shopify webhook URL, then verify HMAC + shop domain.
 * Does not persist orders.
 */
async function verifyShopifyWebhookRequest(req) {
  const { integration, company } = await resolveWebhookByToken(
    "shopify",
    req.params.webhookToken,
  );

  if (String(integration.provider || "").toLowerCase() !== "shopify") {
    throw webhookUnauthorized();
  }
  if (String(integration.category || "commerce").toLowerCase() !== "commerce") {
    throw webhookUnauthorized();
  }
  if (integration.is_enabled === false) {
    throw webhookUnauthorized();
  }

  let secrets = {};
  try {
    secrets = decryptSecrets(integration.credentials);
  } catch {
    secrets = {};
  }
  const webhookSecret = readWebhookSecret(secrets);
  if (!webhookSecret) {
    const error = new Error("Shopify webhook secret is not configured");
    error.code = "SHOPIFY_WEBHOOK_SECRET_MISSING";
    error.statusCode = 401;
    throw error;
  }

  const hmacHeader =
    req.get?.("X-Shopify-Hmac-SHA256") ||
    req.headers?.["x-shopify-hmac-sha256"] ||
    "";
  if (!String(hmacHeader || "").trim()) {
    const error = new Error("Shopify webhook HMAC is required");
    error.code = "SHOPIFY_WEBHOOK_HMAC_INVALID";
    error.statusCode = 401;
    throw error;
  }

  const rawBody = rawBodyBuffer(req);
  if (!verifyShopifyHmac(rawBody, hmacHeader, webhookSecret)) {
    const error = new Error("Shopify webhook HMAC is invalid");
    error.code = "SHOPIFY_WEBHOOK_HMAC_INVALID";
    error.statusCode = 401;
    throw error;
  }

  const headerShop =
    req.get?.("X-Shopify-Shop-Domain") ||
    req.headers?.["x-shopify-shop-domain"] ||
    "";
  if (!String(headerShop || "").trim()) {
    const error = new Error("Shopify shop domain header is required");
    error.code = "SHOPIFY_SHOP_DOMAIN_MISMATCH";
    error.statusCode = 401;
    throw error;
  }

  let storedDomain;
  try {
    storedDomain = normalizeShopifyShopDomain(storedShopDomain(integration, secrets));
  } catch {
    const error = new Error("Shopify shop domain does not match this connection");
    error.code = "SHOPIFY_SHOP_DOMAIN_MISMATCH";
    error.statusCode = 401;
    throw error;
  }

  try {
    if (!shopifyShopDomainsEqual(headerShop, storedDomain)) {
      const error = new Error("Shopify shop domain does not match this connection");
      error.code = "SHOPIFY_SHOP_DOMAIN_MISMATCH";
      error.statusCode = 401;
      throw error;
    }
  } catch (error) {
    if (error.code === "SHOPIFY_SHOP_DOMAIN_MISMATCH") throw error;
    const mismatch = new Error("Shopify shop domain does not match this connection");
    mismatch.code = "SHOPIFY_SHOP_DOMAIN_MISMATCH";
    mismatch.statusCode = 401;
    throw mismatch;
  }

  const topic = String(
    req.get?.("X-Shopify-Topic") || req.headers?.["x-shopify-topic"] || "",
  )
    .trim()
    .toLowerCase();

  const payload = parseShopifyJson(rawBody);

  return {
    companyId: company.id,
    sourceIntegrationId: integration.id,
    integrationId: integration.id,
    integration,
    company,
    topic,
    shopDomain: storedDomain,
    payload,
    allowedTopic: ALLOWED_SHOPIFY_ORDER_TOPICS.has(topic),
  };
}

module.exports = {
  ALLOWED_SHOPIFY_ORDER_TOPICS,
  verifyShopifyHmac,
  verifyShopifyWebhookRequest,
  rawBodyBuffer,
  parseShopifyJson,
  quoteUnsafeJsonIntegers,
};
