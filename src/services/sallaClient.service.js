const axios = require("axios");
const {
  getSallaApiBaseUrl,
  getSallaApiTimeoutMs,
  getSallaTokenUrl,
  getSallaUserInfoUrl,
  getSallaOauthConfig,
  NEAR_EXPIRY_MS,
} = require("../config/salla");
const {
  sallaError,
  classifySallaAuthorization,
  persistSallaTokens,
  markSallaAuthorizationRevoked,
  extractMerchantIdentity,
  getConnectionRow,
  assertSallaConnection,
  settingsOf,
  decryptRowSecrets,
} = require("./sallaAuth.service");

const refreshLocks = new Map();
// In-process only: this mutex serializes refresh-token rotation on one Node
// instance. Multi-instance deployments will need a distributed lock later.

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function secretsOf(row) {
  return decryptRowSecrets(row);
}

function tokenExpiresAtMs(row) {
  const raw = firstNonEmpty(settingsOf(row).tokenExpiresAt, settingsOf(row).token_expires_at);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

function needsRefresh(row, secrets) {
  if (!firstNonEmpty(secrets.refreshToken, secrets.refresh_token)) return false;
  const exp = tokenExpiresAtMs(row);
  if (!Number.isFinite(exp)) return true;
  return exp - Date.now() <= NEAR_EXPIRY_MS;
}

function assertUsableSallaRow(row, { allowDisabled = false } = {}) {
  if (!allowDisabled && row.is_enabled === false) {
    throw sallaError(
      "INTEGRATION_DISABLED",
      "Salla integration is disabled for this company",
      409,
    );
  }
  const secrets = secretsOf(row);
  const status = classifySallaAuthorization(row, secrets);
  if (status === "revoked") {
    throw sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is revoked. Reconnect this store.",
      401,
    );
  }
  if (status === "pending") {
    throw sallaError(
      "SALLA_AUTHORIZATION_PENDING",
      "Salla authorization is pending",
      409,
    );
  }
  if (status === "legacy_unmanaged") {
    throw sallaError(
      "SALLA_AUTHORIZATION_LEGACY",
      "This Salla connection uses a legacy token and must be reconnected with OAuth",
      409,
    );
  }
  if (!firstNonEmpty(secrets.accessToken, secrets.access_token)) {
    throw sallaError(
      "INTEGRATION_NOT_CONFIGURED",
      "Salla integration is not configured for this company",
      409,
    );
  }
  return secrets;
}

async function refreshSallaAccessToken(integrationId) {
  const row = await getConnectionRow(integrationId);
  assertSallaConnection(row, row.company_id);
  const secrets = secretsOf(row);
  const refreshToken = firstNonEmpty(secrets.refreshToken, secrets.refresh_token);
  if (!refreshToken) {
    const marked = await markSallaAuthorizationRevoked(row);
    void marked;
    throw sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is revoked. Reconnect this store.",
      401,
    );
  }

  let oauth;
  try {
    oauth = getSallaOauthConfig();
  } catch (error) {
    throw error;
  }

  let response;
  try {
    response = await axios.post(
      getSallaTokenUrl(),
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: refreshToken,
        scope: "offline_access",
      }).toString(),
      {
        timeout: getSallaApiTimeoutMs(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        validateStatus: () => true,
      },
    );
  } catch {
    throw sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla authorization server is temporarily unavailable",
      502,
    );
  }

  if (response.status === 401 || response.status === 403) {
    await markSallaAuthorizationRevoked(row);
    throw sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is revoked. Reconnect this store.",
      401,
    );
  }
  if (response.status >= 500) {
    throw sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla authorization server is temporarily unavailable",
      502,
    );
  }
  if (response.status >= 400) {
    await markSallaAuthorizationRevoked(row);
    throw sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is revoked. Reconnect this store.",
      401,
    );
  }

  const payload = response.data && typeof response.data === "object" ? response.data : {};
  const merchant = {
    merchantId: firstNonEmpty(row.provider_account_id),
    merchantName: firstNonEmpty(settingsOf(row).merchantName),
  };
  return persistSallaTokens(row, payload, merchant);
}

function withSallaRefreshLock(integrationId, fn) {
  const key = String(integrationId);
  const existing = refreshLocks.get(key);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (refreshLocks.get(key) === pending) refreshLocks.delete(key);
    });
  refreshLocks.set(key, pending);
  return pending;
}

async function ensureSallaAccessToken(integration, { allowDisabled = false } = {}) {
  if (!integration || !integration.id) {
    throw sallaError(
      "SALLA_INTEGRATION_REQUIRED",
      "An exact Salla integration is required",
      400,
    );
  }
  let row = assertSallaConnection(integration, integration.company_id);
  let secrets = assertUsableSallaRow(row, { allowDisabled });
  if (needsRefresh(row, secrets)) {
    row = await withSallaRefreshLock(row.id, () => refreshSallaAccessToken(row.id));
    secrets = secretsOf(row);
  }
  return {
    row,
    secrets,
    accessToken: firstNonEmpty(secrets.accessToken, secrets.access_token),
  };
}

const MAX_SALLA_HTTP_RETRIES = 2;

async function waitForSallaRetry(response) {
  if (process.env.NODE_ENV === "test") return;
  const header =
    response?.headers?.["retry-after"] || response?.headers?.["Retry-After"];
  const seconds = Number(header);
  const ms =
    Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1000, 2000)
      : 250;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sallaAuthorizedGet(url, accessToken) {
  try {
    return await axios.get(url, {
      timeout: getSallaApiTimeoutMs(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      validateStatus: () => true,
    });
  } catch {
    const error = sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla API is temporarily unavailable",
      502,
    );
    error.retryable = true;
    throw error;
  }
}

function classifySallaHttpStatus(status) {
  if (status === 401) {
    const error = sallaError(
      "SALLA_CREDENTIALS_INVALID",
      "Salla API credentials are invalid or revoked",
      401,
    );
    error.httpStatus = status;
    return error;
  }
  if (status === 403) {
    const error = sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is revoked. Reconnect this store.",
      401,
    );
    error.httpStatus = status;
    return error;
  }
  if (status === 429) {
    const error = sallaError(
      "SALLA_RATE_LIMITED",
      "Salla API rate limit reached",
      429,
    );
    error.retryable = true;
    error.httpStatus = status;
    return error;
  }
  if (status >= 500) {
    const error = sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla API is temporarily unavailable",
      502,
    );
    error.retryable = true;
    error.httpStatus = status;
    return error;
  }
  const error = sallaError(
    "SALLA_PROVIDER_UNAVAILABLE",
    "Salla API request failed",
    status === 404 ? 404 : 502,
  );
  error.httpStatus = status;
  return error;
}

async function sallaGetJson({ integration, url, allowDisabled = false } = {}) {
  const first = await ensureSallaAccessToken(integration, { allowDisabled });
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_SALLA_HTTP_RETRIES; attempt += 1) {
    let response;
    try {
      response = await sallaAuthorizedGet(url, first.accessToken);
      if (response.status === 401 && firstNonEmpty(first.secrets.refreshToken)) {
        const refreshed = await withSallaRefreshLock(first.row.id, () =>
          refreshSallaAccessToken(first.row.id),
        );
        const secrets = secretsOf(refreshed);
        response = await sallaAuthorizedGet(
          url,
          firstNonEmpty(secrets.accessToken, secrets.access_token),
        );
        first.row = refreshed;
        first.secrets = secrets;
      }
    } catch (error) {
      lastError = error;
      if (error.retryable && attempt < MAX_SALLA_HTTP_RETRIES) {
        await waitForSallaRetry();
        continue;
      }
      throw error;
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = classifySallaHttpStatus(response.status);
      if (attempt < MAX_SALLA_HTTP_RETRIES) {
        await waitForSallaRetry(response);
        continue;
      }
      throw lastError;
    }

    if (response.status >= 400) {
      const classified = classifySallaHttpStatus(response.status);
      if (
        classified.code === "SALLA_AUTHORIZATION_REVOKED" ||
        classified.code === "SALLA_CREDENTIALS_INVALID"
      ) {
        await markSallaAuthorizationRevoked(first.row);
        throw sallaError(
          "SALLA_AUTHORIZATION_REVOKED",
          "Salla authorization is revoked. Reconnect this store.",
          401,
        );
      }
      throw classified;
    }
    return { row: first.row, payload: response.data };
  }
  throw (
    lastError ||
    sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla API is temporarily unavailable",
      502,
    )
  );
}

function unwrapSallaOrderPayload(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const candidates = [root.data, root.order, root.data?.data, root.data?.order, root];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && candidate.id != null) {
      return candidate;
    }
  }
  return root.data && typeof root.data === "object" ? root.data : root;
}

async function sallaGetOrder({ integration, orderId, allowDisabled = false } = {}) {
  const id = firstNonEmpty(orderId);
  if (!id) {
    throw sallaError("SALLA_ORDER_ID_REQUIRED", "Salla order id is required", 400);
  }
  const result = await sallaGetJson({
    integration,
    url: sallaAdminUrl(`orders/${encodeURIComponent(id)}`),
    allowDisabled,
  });
  return {
    row: result.row,
    order: unwrapSallaOrderPayload(result.payload),
  };
}

async function sallaGetOrders({
  integration,
  page = 1,
  perPage = 30,
  fromDate,
  toDate,
  allowDisabled = false,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePerPage = Math.min(60, Math.max(1, Number(perPage) || 30));
  const params = new URLSearchParams();
  params.set("page", String(safePage));
  params.set("per_page", String(safePerPage));
  if (firstNonEmpty(fromDate)) params.set("from_date", firstNonEmpty(fromDate));
  if (firstNonEmpty(toDate)) params.set("to_date", firstNonEmpty(toDate));
  return sallaGetJson({
    integration,
    url: sallaAdminUrl(`orders?${params.toString()}`),
    allowDisabled,
  });
}

async function sallaGetProducts({
  integration,
  page = 1,
  perPage = 50,
  allowDisabled = false,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePerPage = Math.min(65, Math.max(1, Number(perPage) || 50));
  return sallaGetJson({
    integration,
    url: sallaAdminUrl(
      `products?page=${encodeURIComponent(safePage)}&per_page=${encodeURIComponent(safePerPage)}`,
    ),
    allowDisabled,
  });
}

async function sallaGetProduct({ integration, productId, allowDisabled = false } = {}) {
  const id = firstNonEmpty(productId);
  if (!id) {
    throw sallaError("SALLA_PRODUCT_ID_REQUIRED", "Salla product id is required", 400);
  }
  const result = await sallaGetJson({
    integration,
    url: sallaAdminUrl(`products/${encodeURIComponent(id)}`),
    allowDisabled,
  });
  const root = result.payload && typeof result.payload === "object" ? result.payload : {};
  const product =
    root.data && typeof root.data === "object" && !Array.isArray(root.data) && root.data.id != null
      ? root.data
      : root.id != null
        ? root
        : root.data || root;
  return { row: result.row, product };
}

async function sallaUserInfo({ integration, allowDisabled = false } = {}) {
  const result = await sallaGetJson({
    integration,
    url: getSallaUserInfoUrl(),
    allowDisabled,
  });
  return {
    row: result.row,
    payload: result.payload,
    merchant: extractMerchantIdentity(result.payload),
  };
}

async function testSallaConnection({ integration, allowDisabled = true } = {}) {
  const row = assertSallaConnection(integration, integration.company_id);
  const result = await sallaUserInfo({ integration: row, allowDisabled });
  const bound = firstNonEmpty(result.row.provider_account_id);
  if (bound && result.merchant.merchantId && bound !== result.merchant.merchantId) {
    throw sallaError(
      "SALLA_MERCHANT_MISMATCH",
      "Salla merchant does not match this connection",
      409,
    );
  }
  return {
    ok: true,
    connected: true,
    configured: true,
    enabled: result.row.is_enabled !== false,
    provider: "salla",
    integrationId: result.row.id,
    merchantId: result.merchant.merchantId || bound || null,
    merchantName:
      result.merchant.merchantName ||
      firstNonEmpty(settingsOf(result.row).merchantName) ||
      null,
  };
}

function sallaAdminUrl(pathName) {
  const base = getSallaApiBaseUrl();
  const path = String(pathName || "").replace(/^\//, "");
  return `${base}/${path}`;
}

function resetSallaRefreshLocksForTests() {
  refreshLocks.clear();
}

module.exports = {
  ensureSallaAccessToken,
  sallaUserInfo,
  sallaGetOrder,
  sallaGetOrders,
  sallaGetProducts,
  sallaGetProduct,
  sallaGetJson,
  testSallaConnection,
  refreshSallaAccessToken,
  withSallaRefreshLock,
  sallaAdminUrl,
  resetSallaRefreshLocksForTests,
};
