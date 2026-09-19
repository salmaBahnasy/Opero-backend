function getPublicApiBaseUrl() {
  const raw = (
    process.env.APP_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.API_PUBLIC_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
  if (raw) return raw;

  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
    const error = new Error(
      "APP_PUBLIC_BASE_URL is required in production for webhook and OAuth URLs.",
    );
    error.code = "PUBLIC_BASE_URL_MISSING";
    throw error;
  }

  const port = process.env.PORT || 5050;
  return `http://localhost:${port}`;
}

function buildWebhookUrl(provider, token) {
  const { webhookPath } = require("../integrations/catalog");
  const base = getPublicApiBaseUrl();
  return `${base}${webhookPath(provider, token)}`;
}

module.exports = {
  getPublicApiBaseUrl,
  buildWebhookUrl,
};
