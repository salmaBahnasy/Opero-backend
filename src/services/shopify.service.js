const axios = require("axios");
const {
  getShopifyAdminApiTimeoutMs,
  getShopifyAdminApiMaxRetries,
  getShopifyAdminApiVersion,
  shopifyGraphqlUrl,
} = require("../config/shopify");
const { normalizeShopifyShopDomain, shopifyShopDomainsEqual } = require("../utils/shopifyDomain");

const SHOP_QUERY = `query ShopifyConnectionTest {
  shop {
    name
    myshopifyDomain
  }
}`;

function shopifyError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(header) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 10000);
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), 10000);
  }
  return null;
}

function backoffMs(attempt) {
  return Math.min(250 * 2 ** attempt, 2000);
}

function readSecret(secrets, ...keys) {
  if (!secrets || typeof secrets !== "object") return "";
  for (const key of keys) {
    const value = secrets[key];
    if (value != null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function shopDomainFromIntegration(integration, secrets = {}) {
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

/**
 * Validate an already-resolved Shopify connection. Never picks a connection.
 */
function assertShopifyIntegration(integration, secrets = {}, options = {}) {
  if (!integration || typeof integration !== "object" || !integration.id) {
    throw shopifyError(
      "SHOPIFY_INTEGRATION_REQUIRED",
      "An exact Shopify integration is required",
      400,
    );
  }
  if (String(integration.provider || "").toLowerCase() !== "shopify") {
    throw shopifyError(
      "SHOPIFY_PROVIDER_MISMATCH",
      "Integration is not a Shopify commerce connection",
      400,
    );
  }
  const category = String(integration.category || "commerce").toLowerCase();
  if (category && category !== "commerce") {
    throw shopifyError(
      "SHOPIFY_PROVIDER_MISMATCH",
      "Shopify connections must be commerce integrations",
      400,
    );
  }
  if (options.requireEnabled !== false && integration.is_enabled === false) {
    throw shopifyError(
      "INTEGRATION_DISABLED",
      "Shopify integration is disabled for this company",
      409,
    );
  }

  let shopDomain;
  try {
    shopDomain = normalizeShopifyShopDomain(
      shopDomainFromIntegration(integration, secrets),
    );
  } catch (error) {
    if (error.code === "SHOPIFY_SHOP_DOMAIN_INVALID") {
      throw shopifyError(
        "SHOPIFY_SHOP_DOMAIN_REQUIRED",
        "Shopify shop domain is missing or invalid",
        400,
      );
    }
    throw error;
  }

  const accessToken = readSecret(secrets, "accessToken", "access_token");
  if (!accessToken) {
    throw shopifyError(
      "SHOPIFY_CREDENTIALS_INVALID",
      "Shopify Admin API access token is not configured",
      401,
    );
  }

  return {
    integration,
    shopDomain,
    accessToken,
    webhookSecret: readSecret(
      secrets,
      "webhookSecret",
      "webhook_secret",
      "clientSecret",
      "apiSecret",
    ),
  };
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) {
    return shopifyError(
      "SHOPIFY_CREDENTIALS_INVALID",
      "Shopify Admin API credentials are invalid or revoked",
      401,
    );
  }
  if (status === 429) {
    const error = shopifyError(
      "SHOPIFY_RATE_LIMITED",
      "Shopify Admin API rate limit reached",
      429,
    );
    error.retryable = true;
    return error;
  }
  if (status >= 500) {
    const error = shopifyError(
      "SHOPIFY_PROVIDER_UNAVAILABLE",
      "Shopify Admin API is temporarily unavailable",
      502,
    );
    error.retryable = true;
    return error;
  }
  return shopifyError(
    "SHOPIFY_PROVIDER_UNAVAILABLE",
    "Shopify Admin API request failed",
    502,
  );
}

function graphqlThrottleError(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors.some((entry) => {
    const code = String(entry?.extensions?.code || entry?.code || "").toUpperCase();
    return code === "THROTTLED" || code === "MAX_COST_EXCEEDED";
  });
}

function graphqlUserErrors(payload) {
  const data = payload?.data;
  if (!data || typeof data !== "object") return [];
  const collected = [];
  for (const value of Object.values(data)) {
    if (value && typeof value === "object" && Array.isArray(value.userErrors)) {
      collected.push(...value.userErrors);
    }
  }
  return collected;
}

async function postGraphqlOnce({ url, accessToken, query, variables, timeout }) {
  let response;
  try {
    response = await axios.post(
      url,
      { query, variables },
      {
        timeout,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        validateStatus: () => true,
      },
    );
  } catch (error) {
    const retryable =
      error.code === "ECONNABORTED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "ENOTFOUND" ||
      !error.response;
    const wrapped = shopifyError(
      "SHOPIFY_PROVIDER_UNAVAILABLE",
      "Shopify Admin API is temporarily unavailable",
      502,
    );
    wrapped.retryable = retryable;
    throw wrapped;
  }

  const retryAfterMs = parseRetryAfterMs(
    response.headers?.["retry-after"] || response.headers?.["Retry-After"],
  );
  if (response.status !== 200) {
    const classified = classifyHttpStatus(response.status);
    if (classified.retryable && retryAfterMs != null) {
      classified.retryAfterMs = retryAfterMs;
    }
    throw classified;
  }

  const payload = response.data && typeof response.data === "object" ? response.data : {};
  if (graphqlThrottleError(payload)) {
    const error = shopifyError(
      "SHOPIFY_RATE_LIMITED",
      "Shopify Admin API rate limit reached",
      429,
    );
    error.retryable = true;
    error.retryAfterMs = retryAfterMs;
    throw error;
  }
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw shopifyError(
      "SHOPIFY_GRAPHQL_ERROR",
      "Shopify Admin API returned a GraphQL error",
      502,
    );
  }
  const userErrors = graphqlUserErrors(payload);
  if (userErrors.length) {
    throw shopifyError(
      "SHOPIFY_GRAPHQL_ERROR",
      "Shopify Admin API returned a user error",
      502,
    );
  }
  return payload;
}

/**
 * Low-level Shopify Admin GraphQL client.
 * Callers must pass the exact resolved integration. This never selects a store.
 */
async function shopifyGraphql({
  integration,
  secrets,
  query,
  variables,
  allowDisabled = false,
} = {}) {
  const resolved = assertShopifyIntegration(integration, secrets, {
    requireEnabled: !allowDisabled,
  });
  const url = shopifyGraphqlUrl(resolved.shopDomain, getShopifyAdminApiVersion());
  const timeout = getShopifyAdminApiTimeoutMs();
  const maxRetries = getShopifyAdminApiMaxRetries();

  let attempt = 0;
  while (true) {
    try {
      return await postGraphqlOnce({
        url,
        accessToken: resolved.accessToken,
        query,
        variables,
        timeout,
      });
    } catch (error) {
      const retryable = Boolean(error.retryable);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = error.retryAfterMs != null ? error.retryAfterMs : backoffMs(attempt);
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

async function testShopifyConnection({
  integration,
  secrets,
  allowDisabled = false,
} = {}) {
  const resolved = assertShopifyIntegration(integration, secrets, {
    requireEnabled: !allowDisabled,
  });
  const payload = await shopifyGraphql({
    integration,
    secrets,
    query: SHOP_QUERY,
    allowDisabled,
  });
  const shop = payload?.data?.shop;
  const remoteDomain = shop?.myshopifyDomain;
  if (!remoteDomain) {
    throw shopifyError(
      "SHOPIFY_GRAPHQL_ERROR",
      "Shopify Admin API did not return shop metadata",
      502,
    );
  }
  if (!shopifyShopDomainsEqual(remoteDomain, resolved.shopDomain)) {
    throw shopifyError(
      "SHOPIFY_SHOP_DOMAIN_MISMATCH",
      "Shopify shop domain does not match this connection",
      401,
    );
  }
  return {
    ok: true,
    connected: true,
    configured: true,
    enabled: integration.is_enabled !== false,
    provider: "shopify",
    integrationId: integration.id,
    shopName: shop.name || null,
    shopDomain: resolved.shopDomain,
  };
}

module.exports = {
  SHOP_QUERY,
  assertShopifyIntegration,
  shopifyGraphql,
  testShopifyConnection,
  shopifyError,
};
