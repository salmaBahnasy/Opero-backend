const crypto = require("crypto");
const { decryptSecrets, resolveWebhookByToken } = require("./companyIntegrations.service");
const {
  sallaError,
  classifySallaAuthorization,
} = require("./sallaAuth.service");
const { getSallaAppWebhookSecret } = require("../config/salla");

const ALLOWED_SALLA_ORDER_EVENTS = new Set([
  "order.created",
  "order.updated",
  "order.status.updated",
  "order.cancelled",
  "order.canceled",
]);

const SALLA_UNINSTALL_EVENT = "app.uninstalled";

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

function headerValue(req, name) {
  return firstNonEmpty(req.get?.(name), req.headers?.[name.toLowerCase()]);
}

function normalizeSallaEvent(value) {
  return String(value || "").trim().toLowerCase();
}

function verifySallaHmac(rawBody, signatureHeader, secret) {
  const header = String(signatureHeader || "").trim().toLowerCase();
  const key = String(secret || "").trim();
  if (!header || !key) return false;
  const digest = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
  const left = Buffer.from(digest, "utf8");
  const right = Buffer.from(header, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseSallaJson(rawBody) {
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    if (!text.trim()) {
      throw sallaError("SALLA_WEBHOOK_INVALID_JSON", "Salla webhook JSON is invalid", 400);
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw sallaError("SALLA_WEBHOOK_INVALID_JSON", "Salla webhook JSON is invalid", 400);
    }
    return parsed;
  } catch (error) {
    if (error.code === "SALLA_WEBHOOK_INVALID_JSON") throw error;
    throw sallaError("SALLA_WEBHOOK_INVALID_JSON", "Salla webhook JSON is invalid", 400);
  }
}

function assertConnectedSallaRow(integration) {
  if (String(integration.provider || "").toLowerCase() !== "salla") {
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
  const status = classifySallaAuthorization(integration, secrets);
  if (status === "revoked") {
    throw sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is revoked. Reconnect this store.",
      401,
    );
  }
  if (status === "pending") {
    throw sallaError("SALLA_AUTHORIZATION_PENDING", "Salla authorization is pending", 409);
  }
  if (status === "legacy_unmanaged") {
    throw sallaError(
      "SALLA_AUTHORIZATION_LEGACY",
      "This Salla connection uses a legacy token and must be reconnected with OAuth",
      409,
    );
  }
  if (status !== "connected") {
    throw sallaError("SALLA_AUTHORIZATION_PENDING", "Salla authorization is pending", 409);
  }
  return secrets;
}

function verifySallaSignedPayload(req) {
  const webhookSecret = getSallaAppWebhookSecret();
  if (!webhookSecret) {
    throw sallaError(
      "SALLA_WEBHOOK_SECRET_MISSING",
      "Salla Partner App webhook secret is not configured",
      401,
    );
  }

  const strategy = headerValue(req, "X-Salla-Security-Strategy");
  if (strategy && strategy.toLowerCase() !== "signature") {
    throw sallaError(
      "SALLA_WEBHOOK_STRATEGY_INVALID",
      "Salla webhook security strategy is not supported",
      401,
    );
  }

  const signature = headerValue(req, "X-Salla-Signature");
  if (!signature) {
    throw sallaError(
      "SALLA_WEBHOOK_HMAC_INVALID",
      "Salla webhook signature is required",
      401,
    );
  }

  const rawBody = rawBodyBuffer(req);
  if (!verifySallaHmac(rawBody, signature, webhookSecret)) {
    throw sallaError(
      "SALLA_WEBHOOK_HMAC_INVALID",
      "Salla webhook signature is invalid",
      401,
    );
  }

  const payload = parseSallaJson(rawBody);
  const merchantId = firstNonEmpty(payload.merchant, payload.merchant_id);
  const event = normalizeSallaEvent(payload.event || payload.type);
  const data = asObject(payload.data) || {};
  const requestId = firstNonEmpty(
    headerValue(req, "X-Salla-Request-Id"),
    payload.id,
    payload.request_id,
  );
  return {
    payload,
    merchantId,
    event,
    data,
    requestId,
    createdAt: firstNonEmpty(payload.created_at, payload.createdAt),
  };
}

/**
 * Resolve the tokenized Salla webhook URL, then verify Partner App HMAC + merchant.
 * Does not persist orders. Tenant identity comes from the connection row only.
 */
async function verifySallaWebhookRequest(req) {
  const { integration, company } = await resolveWebhookByToken(
    "salla",
    req.params.webhookToken,
  );
  const signed = verifySallaSignedPayload(req);
  const isUninstall = signed.event === SALLA_UNINSTALL_EVENT;
  if (!isUninstall) {
    assertConnectedSallaRow(integration);
  } else if (String(integration.provider || "").toLowerCase() !== "salla") {
    throw webhookUnauthorized();
  }

  const boundMerchant = firstNonEmpty(integration.provider_account_id);
  if (
    !signed.merchantId ||
    !boundMerchant ||
    String(signed.merchantId) !== String(boundMerchant)
  ) {
    throw sallaError(
      "SALLA_MERCHANT_MISMATCH",
      "Salla merchant does not match this connection",
      401,
    );
  }

  return {
    companyId: company.id,
    sourceIntegrationId: integration.id,
    integrationId: integration.id,
    integration,
    company,
    event: signed.event,
    merchantId: String(boundMerchant),
    createdAt: signed.createdAt,
    requestId: signed.requestId,
    data: signed.data,
    payload: signed.payload,
    allowedEvent: ALLOWED_SALLA_ORDER_EVENTS.has(signed.event),
    uninstallEvent: isUninstall,
  };
}

/**
 * App-level Partner App lifecycle webhook. HMAC first, then merchant lookup.
 * Never trusts payload company_id and never creates a tenant.
 */
function verifySallaLifecycleWebhookRequest(req) {
  const signed = verifySallaSignedPayload(req);
  return {
    event: signed.event,
    merchantId: signed.merchantId,
    createdAt: signed.createdAt,
    requestId: signed.requestId,
    data: signed.data,
    payload: signed.payload,
    uninstallEvent: signed.event === SALLA_UNINSTALL_EVENT,
  };
}

module.exports = {
  ALLOWED_SALLA_ORDER_EVENTS,
  SALLA_UNINSTALL_EVENT,
  verifySallaHmac,
  verifySallaWebhookRequest,
  verifySallaLifecycleWebhookRequest,
  verifySallaSignedPayload,
  rawBodyBuffer,
  parseSallaJson,
  normalizeSallaEvent,
};
