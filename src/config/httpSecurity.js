const cors = require("cors");
const helmet = require("helmet");
const { isRecognizedDevEnv } = require("./jwt");

function parseAllowedOrigins(raw = process.env.CORS_ALLOWED_ORIGINS) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isLocalDevOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || ""));
}

function isOriginAllowed(origin, env = process.env) {
  if (!origin) return true;
  const allowed = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  if (allowed.includes(origin)) return true;
  if (isRecognizedDevEnv() && isLocalDevOrigin(origin)) return true;
  return false;
}

function createCorsMiddleware() {
  return cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: false,
  });
}

function createHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 15552000,
      includeSubDomains: true,
    },
  });
}

function applyTrustProxy(app) {
  const raw = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") {
    app.set("trust proxy", 1);
    return;
  }
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
    app.set("trust proxy", 1);
  }
}

module.exports = {
  parseAllowedOrigins,
  isOriginAllowed,
  createCorsMiddleware,
  createHelmetMiddleware,
  applyTrustProxy,
};
