const CATEGORIES = ["commerce", "shipping"];

const REMOTE_PRODUCT_SYNC_PROVIDERS = ["easyorders", "shopify", "salla"];
const HISTORICAL_API_IMPORT_PROVIDERS = ["shopify", "salla"];

const PROVIDERS = {
  easyorders: {
    provider: "easyorders",
    category: "commerce",
    webhookSuffix: "order-created",
    secretKeys: ["apiKey", "api_key"],
  },
  salla: {
    provider: "salla",
    category: "commerce",
    webhookSuffix: "orders",
    secretKeys: ["accessToken", "access_token"],
  },
  shopify: {
    provider: "shopify",
    category: "commerce",
    webhookSuffix: "orders",
    secretKeys: ["accessToken", "access_token", "apiKey", "api_key"],
  },
  spreadsheet: {
    provider: "spreadsheet",
    category: "commerce",
    ingestionOnly: true,
    webhookSuffix: null,
    secretKeys: [],
  },
  bosta: {
    provider: "bosta",
    category: "shipping",
    webhookSuffix: "order-status",
    secretKeys: ["fulfillmentApiKey", "fulfillment_api_key", "apiKey", "api_key"],
  },
  mylerz: {
    provider: "mylerz",
    category: "shipping",
    webhookSuffix: "order-status",
    secretKeys: ["apiKey", "api_key", "accessToken", "access_token"],
  },
};

function normalizeProvider(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function normalizeCategory(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function getProviderDefinition(provider) {
  return PROVIDERS[normalizeProvider(provider)] || null;
}

function assertProvider(provider) {
  const def = getProviderDefinition(provider);
  if (!def) {
    const error = new Error(`Unsupported integration provider: ${provider}`);
    error.code = "UNSUPPORTED_PROVIDER";
    throw error;
  }
  return def;
}

function assertCategory(category) {
  const value = normalizeCategory(category);
  if (!CATEGORIES.includes(value)) {
    const error = new Error("category must be commerce or shipping");
    error.code = "UNSUPPORTED_CATEGORY";
    throw error;
  }
  return value;
}

function assertProviderCategory(provider, category) {
  const def = assertProvider(provider);
  const cat = assertCategory(category || def.category);
  if (cat !== def.category) {
    const error = new Error(
      `${def.provider} is a ${def.category} provider, not ${cat}`,
    );
    error.code = "PROVIDER_CATEGORY_MISMATCH";
    throw error;
  }
  return def;
}

function isIngestionOnlyProvider(provider) {
  return getProviderDefinition(provider)?.ingestionOnly === true;
}

function isRemoteProductSyncProvider(provider) {
  return REMOTE_PRODUCT_SYNC_PROVIDERS.includes(normalizeProvider(provider));
}

function isHistoricalApiImportProvider(provider) {
  return HISTORICAL_API_IMPORT_PROVIDERS.includes(normalizeProvider(provider));
}

function webhookPath(provider, token) {
  const def = assertProvider(provider);
  if (def.ingestionOnly || !def.webhookSuffix) {
    const error = new Error("Historical spreadsheet sources do not use webhooks");
    error.code = "SPREADSHEET_WEBHOOK_UNSUPPORTED";
    throw error;
  }
  return `/webhooks/${def.provider}/${encodeURIComponent(token)}/${def.webhookSuffix}`;
}

module.exports = {
  CATEGORIES,
  PROVIDERS,
  REMOTE_PRODUCT_SYNC_PROVIDERS,
  HISTORICAL_API_IMPORT_PROVIDERS,
  normalizeProvider,
  normalizeCategory,
  getProviderDefinition,
  assertProvider,
  assertCategory,
  assertProviderCategory,
  isIngestionOnlyProvider,
  isRemoteProductSyncProvider,
  isHistoricalApiImportProvider,
  webhookPath,
};
