const rateLimit = require("express-rate-limit");

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function isTestEnv() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function tooManyAttempts(_req, res) {
  res.status(429).json({
    success: false,
    message: "Too many attempts. Try again later.",
  });
}

/**
 * In-memory stores are acceptable for MVP. Multi-instance production later needs
 * shared storage (Redis). Limiters are created per app instance so tests can
 * set LOGIN_RATE_MAX / SIGNUP_RATE_MAX before createApp().
 */
function limiterOptions({ windowMs, max }) {
  return {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooManyAttempts,
    validate: false,
  };
}

function createLoginLimiter() {
  return rateLimit(
    limiterOptions({
      windowMs: envInt("LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
      max: envInt("LOGIN_RATE_MAX", isTestEnv() ? 10000 : 10),
    }),
  );
}

function createPlatformLoginLimiter() {
  return rateLimit(
    limiterOptions({
      windowMs: envInt("PLATFORM_LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
      max: envInt("PLATFORM_LOGIN_RATE_MAX", isTestEnv() ? 10000 : 10),
    }),
  );
}

function createSignupLimiter() {
  return rateLimit(
    limiterOptions({
      windowMs: envInt("SIGNUP_RATE_WINDOW_MS", 60 * 60 * 1000),
      max: envInt("SIGNUP_RATE_MAX", isTestEnv() ? 10000 : 5),
    }),
  );
}

function createTokenWebhookLimiter() {
  return rateLimit(
    limiterOptions({
      windowMs: envInt("WEBHOOK_RATE_WINDOW_MS", 60 * 1000),
      max: envInt("WEBHOOK_RATE_MAX", isTestEnv() ? 10000 : 300),
    }),
  );
}

module.exports = {
  createLoginLimiter,
  createPlatformLoginLimiter,
  createSignupLimiter,
  createTokenWebhookLimiter,
};
