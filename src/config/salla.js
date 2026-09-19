const DEFAULT_API_BASE_URL = "https://api.salla.dev/admin/v2";
const DEFAULT_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
const DEFAULT_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";
const DEFAULT_USER_INFO_URL = "https://accounts.salla.sa/oauth2/user/info";
const DEFAULT_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 10 * 60 * 1000;
const NEAR_EXPIRY_MS = 60 * 1000;
const DEFAULT_ACCESS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OAUTH_SCOPES = "offline_access orders.read products.read settings.read";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function getSallaApiBaseUrl() {
  return firstNonEmpty(process.env.SALLA_API_BASE_URL, DEFAULT_API_BASE_URL).replace(
    /\/$/,
    "",
  );
}

function getSallaOauthClientId() {
  return firstNonEmpty(process.env.SALLA_OAUTH_CLIENT_ID);
}

function getSallaOauthClientSecret() {
  return firstNonEmpty(process.env.SALLA_OAUTH_CLIENT_SECRET);
}

function getSallaOauthRedirectUri() {
  return firstNonEmpty(process.env.SALLA_OAUTH_REDIRECT_URI);
}

function getSallaOauthStateSecret() {
  return firstNonEmpty(process.env.SALLA_OAUTH_STATE_SECRET);
}

function getSallaAppWebhookSecret() {
  return firstNonEmpty(process.env.SALLA_APP_WEBHOOK_SECRET);
}

function getPlatformAdminPublicBaseUrl() {
  return firstNonEmpty(
    process.env.PLATFORM_ADMIN_PUBLIC_BASE_URL,
    process.env.SUPER_ADMIN_PUBLIC_BASE_URL,
  ).replace(/\/$/, "");
}

function getSallaAuthorizeUrl() {
  return firstNonEmpty(process.env.SALLA_OAUTH_AUTHORIZE_URL, DEFAULT_AUTHORIZE_URL);
}

function getSallaTokenUrl() {
  return firstNonEmpty(process.env.SALLA_OAUTH_TOKEN_URL, DEFAULT_TOKEN_URL);
}

function getSallaUserInfoUrl() {
  return firstNonEmpty(process.env.SALLA_OAUTH_USER_INFO_URL, DEFAULT_USER_INFO_URL);
}

function getSallaApiTimeoutMs() {
  return DEFAULT_TIMEOUT_MS;
}

function getSallaOauthConfig() {
  const clientId = getSallaOauthClientId();
  const clientSecret = getSallaOauthClientSecret();
  const redirectUri = getSallaOauthRedirectUri();
  const stateSecret = getSallaOauthStateSecret();
  if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
    const error = new Error("Salla Partner App OAuth is not configured");
    error.code = "SALLA_OAUTH_NOT_CONFIGURED";
    error.statusCode = 500;
    throw error;
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    stateSecret,
    authorizeUrl: getSallaAuthorizeUrl(),
    tokenUrl: getSallaTokenUrl(),
    userInfoUrl: getSallaUserInfoUrl(),
    scopes: OAUTH_SCOPES,
  };
}

module.exports = {
  DEFAULT_API_BASE_URL,
  STATE_TTL_MS,
  NEAR_EXPIRY_MS,
  DEFAULT_ACCESS_TTL_MS,
  OAUTH_SCOPES,
  getSallaApiBaseUrl,
  getSallaOauthClientId,
  getSallaOauthClientSecret,
  getSallaOauthRedirectUri,
  getSallaOauthStateSecret,
  getSallaAppWebhookSecret,
  getPlatformAdminPublicBaseUrl,
  getSallaAuthorizeUrl,
  getSallaTokenUrl,
  getSallaUserInfoUrl,
  getSallaApiTimeoutMs,
  getSallaOauthConfig,
};
