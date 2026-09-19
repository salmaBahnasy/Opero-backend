const { isRecognizedDevEnv } = require("./jwt");

function getNodeEnv() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase();
}

function isProductionEnv(env = getNodeEnv()) {
  return env === "production";
}

function trimEnv(name) {
  return String(process.env[name] || "").trim();
}

function productionConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Fail-fast checks for NODE_ENV=production.
 * Provider credentials are per-company and are NOT required globally.
 */
function assertProductionConfig(env = process.env) {
  if (String(env.NODE_ENV || "").trim().toLowerCase() !== "production") {
    return;
  }

  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "JWT_SECRET",
    "INTEGRATION_ENCRYPTION_KEY",
    "APP_PUBLIC_BASE_URL",
    "CORS_ALLOWED_ORIGINS",
  ];

  for (const key of required) {
    if (!String(env[key] || "").trim()) {
      throw productionConfigError(
        "PRODUCTION_CONFIG_MISSING",
        `${key} is required when NODE_ENV=production.`,
      );
    }
  }

  const publicBase = String(env.APP_PUBLIC_BASE_URL || "").trim();
  let publicUrl;
  try {
    publicUrl = new URL(publicBase);
  } catch {
    throw productionConfigError(
      "PRODUCTION_PUBLIC_URL_INVALID",
      "APP_PUBLIC_BASE_URL must be a valid absolute URL in production.",
    );
  }
  if (publicUrl.protocol !== "https:") {
    throw productionConfigError(
      "PRODUCTION_PUBLIC_URL_INSECURE",
      "APP_PUBLIC_BASE_URL must use https:// in production.",
    );
  }
  if (/^(localhost|127\.0\.0\.1)$/i.test(publicUrl.hostname)) {
    throw productionConfigError(
      "PRODUCTION_PUBLIC_URL_LOCALHOST",
      "APP_PUBLIC_BASE_URL must not be localhost in production.",
    );
  }

  const origins = String(env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!origins.length) {
    throw productionConfigError(
      "PRODUCTION_CORS_EMPTY",
      "CORS_ALLOWED_ORIGINS must list at least one https origin in production.",
    );
  }
  if (origins.some((origin) => origin === "*" || origin.includes("*"))) {
    throw productionConfigError(
      "PRODUCTION_CORS_WILDCARD",
      "CORS_ALLOWED_ORIGINS must not use wildcards in production.",
    );
  }
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw productionConfigError(
        "PRODUCTION_CORS_INVALID",
        `CORS_ALLOWED_ORIGINS entry is not a valid origin: ${origin}`,
      );
    }
    if (parsed.protocol !== "https:") {
      throw productionConfigError(
        "PRODUCTION_CORS_INSECURE",
        `CORS_ALLOWED_ORIGINS entries must use https:// (${origin}).`,
      );
    }
  }
}

function getPackageVersion() {
  try {
    return require("../../package.json").version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

module.exports = {
  getNodeEnv,
  isProductionEnv,
  isRecognizedDevEnv,
  trimEnv,
  assertProductionConfig,
  getPackageVersion,
};
