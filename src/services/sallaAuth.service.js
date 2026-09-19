const crypto = require("crypto");
const axios = require("axios");
const supabase = require("../config/supabase");
const {
  encryptJson,
  decryptJson,
  isEncryptedEnvelope,
} = require("../config/integrationSecrets");
const {
  STATE_TTL_MS,
  DEFAULT_ACCESS_TTL_MS,
  getSallaOauthConfig,
  getSallaTokenUrl,
  getSallaUserInfoUrl,
  getSallaApiTimeoutMs,
  getPlatformAdminPublicBaseUrl,
} = require("../config/salla");
const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";

function sallaError(code, message, statusCode = 400) {
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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function settingsOf(row) {
  return asObject(row?.settings);
}

function classifySallaAuthorization(row, secrets = {}) {
  const settings = settingsOf(row);
  const stored = firstNonEmpty(settings.authorizationStatus, settings.authorization_status);
  const accessToken = firstNonEmpty(secrets.accessToken, secrets.access_token);
  const refreshToken = firstNonEmpty(secrets.refreshToken, secrets.refresh_token);
  if (stored === "revoked") return "revoked";
  if (stored === "connected" && accessToken && refreshToken) return "connected";
  if (accessToken && refreshToken) return "connected";
  if (accessToken && !refreshToken) return "legacy_unmanaged";
  return "pending";
}

function isSallaOperational(row, secrets = {}) {
  return (
    String(row?.provider || "").toLowerCase() === "salla" &&
    row?.is_enabled !== false &&
    classifySallaAuthorization(row, secrets) === "connected"
  );
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function hmacState(encoded, secret) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signSallaOauthState({ companyId, integrationId, nonce, exp }, secret) {
  const encoded = base64UrlEncode(
    JSON.stringify({
      v: 1,
      companyId: String(companyId),
      integrationId: String(integrationId),
      nonce: String(nonce),
      exp: Number(exp),
    }),
  );
  return `${encoded}.${hmacState(encoded, secret)}`;
}

function verifySallaOauthState(rawState, secret, { ignoreExpiry = false } = {}) {
  const text = String(rawState || "").trim();
  const dot = text.lastIndexOf(".");
  if (dot <= 0) {
    throw sallaError("SALLA_OAUTH_STATE_INVALID", "Salla OAuth state is invalid", 400);
  }
  const encoded = text.slice(0, dot);
  const signature = text.slice(dot + 1);
  const expected = hmacState(encoded, secret);
  if (!timingSafeEqualText(signature, expected)) {
    throw sallaError("SALLA_OAUTH_STATE_INVALID", "Salla OAuth state is invalid", 400);
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    throw sallaError("SALLA_OAUTH_STATE_INVALID", "Salla OAuth state is invalid", 400);
  }
  if (!payload || payload.v !== 1) {
    throw sallaError("SALLA_OAUTH_STATE_INVALID", "Salla OAuth state is invalid", 400);
  }
  if (
    !ignoreExpiry &&
    (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Date.now())
  ) {
    throw sallaError("SALLA_OAUTH_STATE_EXPIRED", "Salla OAuth state has expired", 400);
  }
  const companyId = firstNonEmpty(payload.companyId);
  const integrationId = firstNonEmpty(payload.integrationId);
  const nonce = firstNonEmpty(payload.nonce);
  if (!companyId || !integrationId || !nonce) {
    throw sallaError("SALLA_OAUTH_STATE_INVALID", "Salla OAuth state is invalid", 400);
  }
  return { companyId, integrationId, nonce, exp: Number(payload.exp) };
}

function expiryIsoFromProvider(payload = {}) {
  const raw = payload.expires_in ?? payload.expires;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return new Date(Date.now() + DEFAULT_ACCESS_TTL_MS).toISOString();
  }
  if (n > 1e12) return new Date(n).toISOString();
  if (n > 1e9) return new Date(n * 1000).toISOString();
  return new Date(Date.now() + n * 1000).toISOString();
}

function extractMerchantIdentity(payload) {
  const root = asObject(payload?.data || payload);
  const merchant = asObject(root.merchant || root.store);
  const merchantId = firstNonEmpty(
    merchant.id,
    merchant.merchant_id,
    merchant.merchantId,
    root.merchant_id,
    root.merchantId,
  );
  const merchantName = firstNonEmpty(
    merchant.name,
    merchant.username,
    merchant.store_name,
    root.name,
    root.store_name,
    root.email,
  );
  return {
    merchantId,
    merchantName,
  };
}

async function getConnectionRow(integrationId) {
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function assertSallaConnection(row, companyId) {
  if (!row) {
    throw sallaError("INTEGRATION_NOT_FOUND", "Integration connection not found", 404);
  }
  if (String(row.company_id) !== String(companyId)) {
    throw sallaError(
      "INTEGRATION_NOT_OWNED",
      "Integration connection does not belong to this company",
      403,
    );
  }
  if (String(row.provider || "").toLowerCase() !== "salla") {
    throw sallaError(
      "SALLA_PROVIDER_MISMATCH",
      "Integration is not a Salla commerce connection",
      400,
    );
  }
  const category = String(row.category || "commerce").toLowerCase();
  if (category && category !== "commerce") {
    throw sallaError(
      "SALLA_PROVIDER_MISMATCH",
      "Salla connections must be commerce integrations",
      400,
    );
  }
  return row;
}

function oauthSettings(row) {
  return asObject(settingsOf(row).sallaOauth || settingsOf(row).salla_oauth);
}

async function updateConnectionFields(row, fields) {
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .update(fields)
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function persistSallaOauthNonce(row, nonce, exp) {
  const current = classifySallaAuthorization(row, decryptRowSecrets(row));
  const settings = {
    ...settingsOf(row),
    authorizationStatus:
      current === "connected" || current === "revoked"
        ? current
        : settingsOf(row).authorizationStatus || "pending",
    sallaOauth: { nonce, exp },
  };
  delete settings.accessToken;
  delete settings.refreshToken;
  return updateConnectionFields(row, { settings });
}

async function clearSallaOauthNonce(row) {
  const settings = { ...settingsOf(row) };
  delete settings.sallaOauth;
  delete settings.salla_oauth;
  return updateConnectionFields(row, { settings });
}

function decryptRowSecrets(row) {
  const envelope = row?.credentials;
  if (!envelope || (typeof envelope === "object" && !Object.keys(envelope).length)) {
    return {};
  }
  if (!isEncryptedEnvelope(envelope)) return {};
  try {
    const decrypted = decryptJson(envelope);
    return decrypted && typeof decrypted === "object" ? decrypted : {};
  } catch {
    return {};
  }
}

function mergeEncryptedSecrets(row, patch) {
  let previous = {};
  try {
    previous = decryptRowSecrets(row);
  } catch {
    previous = {};
  }
  const next = { ...previous, ...patch };
  delete next.shopDomain;
  delete next.shop_domain;
  return encryptJson(next);
}

async function persistSallaTokens(row, tokenPayload, merchant) {
  const previous = decryptRowSecrets(row);
  const accessToken = firstNonEmpty(tokenPayload.access_token, tokenPayload.accessToken);
  const refreshToken = firstNonEmpty(
    tokenPayload.refresh_token,
    tokenPayload.refreshToken,
    previous.refreshToken,
    previous.refresh_token,
  );
  if (!accessToken || !refreshToken) {
    throw sallaError(
      "SALLA_OAUTH_TOKEN_INVALID",
      "Salla did not return access and refresh tokens",
      502,
    );
  }
  const existingMerchant = firstNonEmpty(row.provider_account_id);
  if (existingMerchant && merchant.merchantId && existingMerchant !== merchant.merchantId) {
    throw sallaError(
      "SALLA_MERCHANT_MISMATCH",
      "Salla merchant does not match this connection",
      409,
    );
  }

  const settings = {
    ...settingsOf(row),
    authorizationStatus: "connected",
    tokenExpiresAt: expiryIsoFromProvider(tokenPayload),
    merchantName: merchant.merchantName || settingsOf(row).merchantName || null,
  };
  delete settings.sallaOauth;
  delete settings.salla_oauth;
  delete settings.accessToken;
  delete settings.refreshToken;

  return updateConnectionFields(row, {
    credentials: mergeEncryptedSecrets(row, {
      accessToken,
      refreshToken,
      tokenType:
        firstNonEmpty(tokenPayload.token_type, previous.tokenType, "bearer") ||
        "bearer",
      scope: firstNonEmpty(tokenPayload.scope, previous.scope),
    }),
    settings,
    provider_account_id: merchant.merchantId || row.provider_account_id || null,
  });
}

async function markSallaAuthorizationRevoked(row) {
  const settings = {
    ...settingsOf(row),
    authorizationStatus: "revoked",
  };
  delete settings.sallaOauth;
  delete settings.salla_oauth;
  delete settings.accessToken;
  delete settings.refreshToken;
  delete settings.tokenExpiresAt;
  delete settings.token_expires_at;
  return updateConnectionFields(row, {
    settings,
    credentials: encryptJson({}),
  });
}

async function findSallaConnectionsByMerchantId(merchantId) {
  const id = firstNonEmpty(merchantId);
  if (!id) return [];
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("provider", "salla");
  if (error) throw new Error(error.message);
  return (data || []).filter((row) => {
    const category = String(row.category || "commerce").toLowerCase();
    return category === "commerce" && firstNonEmpty(row.provider_account_id) === id;
  });
}

async function applySallaUninstallByMerchant(merchantId) {
  const rows = await findSallaConnectionsByMerchantId(merchantId);
  if (!rows.length) {
    return { ignored: true, reason: "unknown_merchant" };
  }
  if (rows.length > 1) {
    throw sallaError(
      "SALLA_MERCHANT_AMBIGUOUS",
      "Multiple Salla connections match this merchant",
      409,
    );
  }
  const updated = await markSallaAuthorizationRevoked(rows[0]);
  return {
    ignored: false,
    integrationId: updated.id,
    companyId: updated.company_id,
    merchantId: firstNonEmpty(updated.provider_account_id) || String(merchantId),
  };
}

async function createSallaAuthorizationUrl(companyId, integrationId) {
  const oauth = getSallaOauthConfig();
  const row = assertSallaConnection(await getConnectionRow(integrationId), companyId);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const exp = Date.now() + STATE_TTL_MS;
  await persistSallaOauthNonce(row, nonce, exp);
  const state = signSallaOauthState(
    { companyId: row.company_id, integrationId: row.id, nonce, exp },
    oauth.stateSecret,
  );
  const url = new URL(oauth.authorizeUrl);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", oauth.redirectUri);
  url.searchParams.set("scope", oauth.scopes);
  url.searchParams.set("state", state);
  return {
    provider: "salla",
    integrationId: row.id,
    companyId: row.company_id,
    authorizationUrl: url.toString(),
  };
}

async function exchangeSallaAuthorizationCode(code) {
  const oauth = getSallaOauthConfig();
  let response;
  try {
    response = await axios.post(
      getSallaTokenUrl(),
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        redirect_uri: oauth.redirectUri,
        code: String(code),
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
    throw sallaError(
      "SALLA_OAUTH_TOKEN_INVALID",
      "Salla rejected the authorization code",
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
    throw sallaError(
      "SALLA_OAUTH_TOKEN_INVALID",
      "Salla authorization code exchange failed",
      400,
    );
  }
  const payload = asObject(response.data);
  if (!firstNonEmpty(payload.access_token, payload.accessToken)) {
    throw sallaError(
      "SALLA_OAUTH_TOKEN_INVALID",
      "Salla did not return an access token",
      502,
    );
  }
  return payload;
}

async function fetchSallaUserInfoWithToken(accessToken) {
  let response;
  try {
    response = await axios.get(getSallaUserInfoUrl(), {
      timeout: getSallaApiTimeoutMs(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      validateStatus: () => true,
    });
  } catch {
    throw sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla user info is temporarily unavailable",
      502,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw sallaError(
      "SALLA_AUTHORIZATION_REVOKED",
      "Salla authorization is invalid or revoked",
      401,
    );
  }
  if (response.status >= 400) {
    throw sallaError(
      "SALLA_PROVIDER_UNAVAILABLE",
      "Salla user info request failed",
      502,
    );
  }
  return response.data;
}

function callbackRedirectUrl(companyId, query) {
  const base = getPlatformAdminPublicBaseUrl();
  if (!base || !companyId) return null;
  const url = new URL(`${base}/platform/companies/${companyId}`);
  url.searchParams.set("tab", "integrations");
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function completeSallaOauthCallback({ code, state, forgedCompanyId } = {}) {
  void forgedCompanyId;
  const oauth = getSallaOauthConfig();
  if (!firstNonEmpty(code) || !firstNonEmpty(state)) {
    throw sallaError(
      "SALLA_OAUTH_CALLBACK_INVALID",
      "Salla OAuth callback requires code and state",
      400,
    );
  }
  const verified = verifySallaOauthState(state, oauth.stateSecret);
  const row = assertSallaConnection(
    await getConnectionRow(verified.integrationId),
    verified.companyId,
  );
  const pending = oauthSettings(row);
  if (!firstNonEmpty(pending.nonce) || !timingSafeEqualText(pending.nonce, verified.nonce)) {
    throw sallaError("SALLA_OAUTH_STATE_INVALID", "Salla OAuth state is invalid", 400);
  }

  const afterNonce = await clearSallaOauthNonce(row);
  const tokenPayload = await exchangeSallaAuthorizationCode(code);
  const userInfo = await fetchSallaUserInfoWithToken(
    firstNonEmpty(tokenPayload.access_token, tokenPayload.accessToken),
  );
  const merchant = extractMerchantIdentity(userInfo);
  if (!merchant.merchantId) {
    throw sallaError(
      "SALLA_MERCHANT_REQUIRED",
      "Salla did not return a merchant id",
      502,
    );
  }
  const saved = await persistSallaTokens(afterNonce, tokenPayload, merchant);
  return {
    companyId: saved.company_id,
    integrationId: saved.id,
    merchantId: saved.provider_account_id,
    merchantName: settingsOf(saved).merchantName || merchant.merchantName || null,
  };
}

function safeCallbackErrorCode(error) {
  const code = firstNonEmpty(error?.code);
  if (
    code.startsWith("SALLA_") ||
    code === "INTEGRATION_NOT_FOUND" ||
    code === "INTEGRATION_NOT_OWNED"
  ) {
    return code;
  }
  return "SALLA_OAUTH_FAILED";
}

module.exports = {
  sallaError,
  classifySallaAuthorization,
  isSallaOperational,
  decryptRowSecrets,
  signSallaOauthState,
  verifySallaOauthState,
  expiryIsoFromProvider,
  extractMerchantIdentity,
  createSallaAuthorizationUrl,
  completeSallaOauthCallback,
  persistSallaTokens,
  markSallaAuthorizationRevoked,
  findSallaConnectionsByMerchantId,
  applySallaUninstallByMerchant,
  fetchSallaUserInfoWithToken,
  callbackRedirectUrl,
  safeCallbackErrorCode,
  getConnectionRow,
  assertSallaConnection,
  settingsOf,
};
