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
