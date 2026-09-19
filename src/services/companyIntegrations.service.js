const supabase = require("../config/supabase");
const {
  encryptJson,
  decryptJson,
  hashWebhookToken,
  generateWebhookToken,
  maskSecret,
  isEncryptedEnvelope,
} = require("../config/integrationSecrets");
const { buildWebhookUrl } = require("../utils/publicUrl");
const {
  integrationNotConfigured,
  integrationDisabled,
} = require("../utils/httpErrors");
const {
  requireActiveCompanyId,
  getActiveIntegration,
} = require("../utils/tenantScope");
const {
  assertProviderCategory,
  assertProvider,
  getProviderDefinition,
  isIngestionOnlyProvider,
} = require("../integrations/catalog");

function spreadsheetUnsupported(code, message) {
  const error = new Error(message);
  error.code = code;
  error.provider = "spreadsheet";
  return error;
}

const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";
const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";
const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";

function pickPrimarySecret(provider, secrets = {}) {
  const def = getProviderDefinition(provider);
  const keys = def?.secretKeys || ["apiKey"];
  for (const key of keys) {
    const value = secrets[key];
    if (value != null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function isMaskedSecretPlaceholder(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/^\*+$/.test(text)) return true;
  if (/^\*{4}.{1,8}$/.test(text)) return true;
  return false;
}

function normalizeIncomingSecrets(provider, body = {}) {
  const credentials =
    body.credentials && typeof body.credentials === "object"
      ? body.credentials
      : {};
  const secrets = {};
  const apiKey = credentials.apiKey ?? credentials.api_key;
  const fulfillmentApiKey =
    credentials.fulfillmentApiKey ?? credentials.fulfillment_api_key;
  const accessToken = credentials.accessToken ?? credentials.access_token;
  const webhookSecret =
    credentials.webhookSecret ??
    credentials.webhook_secret ??
    credentials.clientSecret ??
    credentials.apiSecret;

  if (apiKey != null && !isMaskedSecretPlaceholder(apiKey)) {
    secrets.apiKey = String(apiKey).trim();
  }
  if (fulfillmentApiKey != null && !isMaskedSecretPlaceholder(fulfillmentApiKey)) {
    secrets.fulfillmentApiKey = String(fulfillmentApiKey).trim();
  }
  if (accessToken != null && !isMaskedSecretPlaceholder(accessToken)) {
    secrets.accessToken = String(accessToken).trim();
  }
  if (webhookSecret != null && !isMaskedSecretPlaceholder(webhookSecret)) {
    secrets.webhookSecret = String(webhookSecret).trim();
  }
  return secrets;
}

function readSetting(source, ...keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (source[key] != null && String(source[key]).trim() !== "") {
      return String(source[key]).trim();
    }
  }
  return undefined;
}

function pickShopDomain(body = {}) {
  const settings = body.settings && typeof body.settings === "object" ? body.settings : {};
  const credentials =
    body.credentials && typeof body.credentials === "object" ? body.credentials : {};
  return (
    readSetting(settings, "shopDomain", "shop_domain") ||
    readSetting(body, "shopDomain", "shop_domain") ||
    readSetting(credentials, "shopDomain", "shop_domain") ||
    null
  );
}

function canonicalizeShopDomainForProvider(provider, shopDomain) {
  if (!shopDomain) return shopDomain;
  if (String(provider || "").toLowerCase() !== "shopify") return shopDomain;
  const { normalizeShopifyShopDomain } = require("../utils/shopifyDomain");
  return normalizeShopifyShopDomain(shopDomain);
}

function mergeConnectionSettings(existingSettings, body = {}, provider = null) {
  const current =
    existingSettings && typeof existingSettings === "object" ? { ...existingSettings } : {};
  const incoming =
    body.settings && typeof body.settings === "object" ? { ...body.settings } : {};
  delete incoming.apiKey;
  delete incoming.api_key;
  delete incoming.accessToken;
  delete incoming.access_token;
  delete incoming.fulfillmentApiKey;
  delete incoming.fulfillment_api_key;
  delete incoming.webhookSecret;
  delete incoming.webhook_secret;
  delete incoming.clientSecret;
  delete incoming.apiSecret;
  delete incoming.refreshToken;
  delete incoming.refresh_token;
  delete incoming.tokenType;
  if (String(provider || "").toLowerCase() === "salla") {
    delete incoming.authorizationStatus;
    delete incoming.authorization_status;
    delete incoming.tokenExpiresAt;
    delete incoming.token_expires_at;
    delete incoming.sallaOauth;
    delete incoming.salla_oauth;
    delete incoming.merchantName;
    delete incoming.merchant_name;
  }
  const settings = { ...current, ...incoming };
  const shopDomain = pickShopDomain(body);
  if (shopDomain) {
    settings.shopDomain = canonicalizeShopDomainForProvider(provider, shopDomain);
  }
  delete settings.apiKey;
  delete settings.api_key;
  delete settings.accessToken;
  delete settings.access_token;
  delete settings.fulfillmentApiKey;
  delete settings.fulfillment_api_key;
  delete settings.webhookSecret;
  delete settings.webhook_secret;
  delete settings.clientSecret;
  delete settings.apiSecret;
  delete settings.refreshToken;
  delete settings.refresh_token;
  delete settings.tokenType;
  return settings;
}

function settingsTouched(body = {}) {
  return (
    (body.settings && typeof body.settings === "object") ||
    body.shopDomain != null ||
    body.shop_domain != null ||
    (body.credentials &&
      typeof body.credentials === "object" &&
      (body.credentials.shopDomain != null || body.credentials.shop_domain != null))
  );
}

function shopDomainFromRow(row, secrets = {}) {
  const settings = row?.settings && typeof row.settings === "object" ? row.settings : {};
  return (
    readSetting(settings, "shopDomain", "shop_domain") ||
    readSetting(secrets, "shopDomain", "shop_domain") ||
    null
  );
}

function decryptSecrets(envelope) {
  if (!envelope || (typeof envelope === "object" && !Object.keys(envelope).length)) {
    return {};
  }
  if (!isEncryptedEnvelope(envelope)) {
    const error = new Error("Stored credentials are not encrypted");
    error.code = "INTEGRATION_SECRET_INVALID";
    throw error;
  }
  const decrypted = decryptJson(envelope);
  return decrypted && typeof decrypted === "object" ? decrypted : {};
}

function decryptWebhookToken(row) {
  if (!row?.webhook_token_encrypted) return null;
  try {
    const payload = decryptJson(row.webhook_token_encrypted);
    const token = payload?.token;
    return token ? String(token) : null;
  } catch {
    return null;
  }
}

function sallaPublicFields(row, secrets = {}) {
  if (String(row?.provider || "").toLowerCase() !== "salla") return {};
  const {
    classifySallaAuthorization,
  } = require("./sallaAuth.service");
  const settings =
    row?.settings && typeof row.settings === "object" ? row.settings : {};
  const authorizationStatus = classifySallaAuthorization(row, secrets);
  return {
    authorizationStatus,
    merchantName: settings.merchantName || settings.merchant_name || null,
    tokenExpiresAt: settings.tokenExpiresAt || settings.token_expires_at || null,
  };
}

function publicConnectionView(row, revealedWebhookToken = null) {
  let secrets = {};
  try {
    secrets = decryptSecrets(row?.credentials);
  } catch {
    secrets = {};
  }
  const ingestionOnly = isIngestionOnlyProvider(row?.provider);
  const primary = pickPrimarySecret(row?.provider, secrets);
  const salla = sallaPublicFields(row, secrets);
  const webhookSecret = String(secrets.webhookSecret || secrets.webhook_secret || "").trim();
  const revealedToken =
    ingestionOnly || !revealedWebhookToken ? null : String(revealedWebhookToken);
  const sallaConfigured = salla.authorizationStatus
    ? salla.authorizationStatus === "connected"
    : Boolean(primary);
  const configured =
    ingestionOnly
      ? true
      : String(row.provider || "").toLowerCase() === "salla"
        ? sallaConfigured
        : Boolean(primary);
  return {
    id: row.id,
    companyId: row.company_id,
    category: row.category,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.is_enabled),
    configured,
    apiKeyMasked: ingestionOnly ? null : maskSecret(primary),
    webhookSecretConfigured: ingestionOnly ? false : Boolean(webhookSecret),
    webhookSecretMasked: ingestionOnly ? null : maskSecret(webhookSecret),
    providerAccountId: ingestionOnly ? null : row.provider_account_id || null,
    shopDomain: ingestionOnly ? null : shopDomainFromRow(row, secrets),
    authorizationStatus: salla.authorizationStatus || null,
    merchantName: salla.merchantName || null,
    tokenExpiresAt: salla.tokenExpiresAt || null,
    webhookUrl: revealedToken ? buildWebhookUrl(row.provider, revealedToken) : null,
    webhookConfigured: ingestionOnly ? false : Boolean(row.webhook_token_hash),
    webhookTokenCreatedAt: ingestionOnly ? null : row.webhook_token_created_at || null,
    webhookTokenRotatedAt: ingestionOnly ? null : row.webhook_token_rotated_at || null,
    lastWebhookAt: ingestionOnly ? null : row.last_webhook_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function getCompanyOrThrow(companyId) {
  const id = String(companyId || "").trim();
  if (!id) {
    const error = new Error("Company not found");
    error.code = "COMPANY_NOT_FOUND";
    throw error;
  }
  const { data, error } = await supabase
    .from(COMPANIES_TABLE)
    .select("id,name,slug,is_active,deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const notFound = new Error("Company not found");
    notFound.code = "COMPANY_NOT_FOUND";
    throw notFound;
  }
  return data;
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

function buildWebhookColumns(provider, { rotate = false, existing = null } = {}) {
  if (isIngestionOnlyProvider(provider)) {
    return {};
  }
  assertProvider(provider);
  if (!rotate && existing?.webhook_token_hash) {
    return {};
  }
  const token = generateWebhookToken();
  const now = new Date().toISOString();
  return {
    webhookToken: token,
    webhook_token_hash: hashWebhookToken(token),
    webhook_token_encrypted: encryptJson({ token }),
    webhook_token_created_at: existing?.webhook_token_created_at || now,
    webhook_token_rotated_at: existing?.webhook_token_hash ? now : null,
  };
}

async function listConnections(companyId) {
  await getCompanyOrThrow(companyId);
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => publicConnectionView(row));
}

const PLATFORM_INTEGRATION_OVERVIEW_SELECT =
  "id,company_id,category,provider,name,is_enabled,provider_account_id,settings,webhook_token_hash,created_at,updated_at";

async function listAllConnectionsOverview() {
  const [{ data: companies, error: companyError }, { data: rows, error }] =
    await Promise.all([
      supabase.from(COMPANIES_TABLE).select("id,name").order("name", {
        ascending: true,
      }),
      supabase.from(INTEGRATIONS_TABLE).select(PLATFORM_INTEGRATION_OVERVIEW_SELECT),
    ]);
  if (companyError) throw new Error(companyError.message);
  if (error) throw new Error(error.message);

  const names = new Map(
    (companies || []).map((row) => [String(row.id), String(row.name || "")]),
  );
  return (rows || []).map((row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: names.get(String(row.company_id)) || "",
    category: row.category,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.is_enabled),
    providerAccountId: row.provider_account_id || null,
    shopDomain:
      row.settings && typeof row.settings === "object"
        ? row.settings.shopDomain || row.settings.shop_domain || null
        : null,
    webhookConfigured: Boolean(row.webhook_token_hash),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));
}

async function getConnection(companyId, integrationId) {
  await getCompanyOrThrow(companyId);
  const row = await getConnectionRow(integrationId);
  if (!row || row.company_id !== companyId) {
    const error = new Error("Integration connection not found");
    error.code = "INTEGRATION_NOT_FOUND";
    throw error;
  }
  return publicConnectionView(row);
}

async function createConnection(companyId, body = {}) {
  await getCompanyOrThrow(companyId);
  const name = String(body.name || body.label || "").trim();
  if (!name) {
    const error = new Error("name is required");
    error.code = "INTEGRATION_NAME_REQUIRED";
    throw error;
  }
  const def = assertProviderCategory(body.provider, body.category);
  const incomingSecrets = def.ingestionOnly
    ? {}
    : normalizeIncomingSecrets(def.provider, body);
  const webhookFields = def.ingestionOnly
    ? {}
    : buildWebhookColumns(def.provider, { rotate: true });
  const webhookToken = webhookFields.webhookToken || null;
  const webhookColumns = { ...webhookFields };
  delete webhookColumns.webhookToken;
  let settings = def.ingestionOnly
    ? {}
    : mergeConnectionSettings({}, body, def.provider);
  if (def.provider === "salla") {
    const hasRefresh = Boolean(
      String(incomingSecrets.refreshToken || incomingSecrets.refresh_token || "").trim(),
    );
    const hasAccess = Boolean(String(incomingSecrets.accessToken || "").trim());
    settings.authorizationStatus = hasRefresh
      ? "connected"
      : hasAccess
        ? "legacy_unmanaged"
        : "pending";
  }

  const payload = {
    company_id: companyId,
    category: def.category,
    provider: def.provider,
    name,
    is_enabled: body.enabled != null || body.is_enabled != null
      ? Boolean(body.enabled ?? body.is_enabled)
      : true,
    credentials: encryptJson(incomingSecrets),
    settings,
    provider_account_id: def.ingestionOnly
      ? null
      : body.providerAccountId || body.provider_account_id || null,
    ...webhookColumns,
  };

  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return publicConnectionView(data, webhookToken);
}

async function updateConnection(companyId, integrationId, body = {}) {
  await getCompanyOrThrow(companyId);
  const existing = await getConnectionRow(integrationId);
  if (!existing || existing.company_id !== companyId) {
    const error = new Error("Integration connection not found");
    error.code = "INTEGRATION_NOT_FOUND";
    throw error;
  }

  const updates = {};
  if (body.name != null || body.label != null) {
    const name = String(body.name || body.label || "").trim();
    if (!name) {
      const error = new Error("name is required");
      error.code = "INTEGRATION_NAME_REQUIRED";
      throw error;
    }
    updates.name = name;
  }
  if (body.enabled != null || body.is_enabled != null) {
    updates.is_enabled = Boolean(body.enabled ?? body.is_enabled);
  }
  const ingestionOnly = isIngestionOnlyProvider(existing.provider);
  if (
    !ingestionOnly &&
    (body.providerAccountId !== undefined || body.provider_account_id !== undefined)
  ) {
    updates.provider_account_id =
      body.providerAccountId || body.provider_account_id || null;
  }
  if (!ingestionOnly && settingsTouched(body)) {
    updates.settings = mergeConnectionSettings(
      existing.settings,
      body,
      existing.provider,
    );
  }

  const incomingSecrets = ingestionOnly
    ? {}
    : normalizeIncomingSecrets(existing.provider, body);
  if (Object.keys(incomingSecrets).length) {
    const previous = existing.credentials ? decryptSecrets(existing.credentials) : {};
    const nextSecrets = { ...previous, ...incomingSecrets };
    delete nextSecrets.apiBaseUrl;
    delete nextSecrets.api_base_url;
    const legacyDomain = nextSecrets.shopDomain || nextSecrets.shop_domain;
    delete nextSecrets.shopDomain;
    delete nextSecrets.shop_domain;
    updates.credentials = encryptJson(nextSecrets);
    if (legacyDomain && !shopDomainFromRow({ settings: updates.settings || existing.settings })) {
      updates.settings = mergeConnectionSettings(
        updates.settings || existing.settings,
        {
          settings: { shopDomain: String(legacyDomain).trim() },
        },
        existing.provider,
      );
    }
  }

  if (!Object.keys(updates).length) {
    return publicConnectionView(existing);
  }

  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .update(updates)
    .eq("id", integrationId)
    .eq("company_id", companyId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return publicConnectionView(data);
}

async function rotateWebhookToken(companyId, integrationId) {
  await getCompanyOrThrow(companyId);
  const existing = await getConnectionRow(integrationId);
  if (!existing || existing.company_id !== companyId) {
    const error = new Error("Integration connection not found");
    error.code = "INTEGRATION_NOT_FOUND";
    throw error;
  }
  if (isIngestionOnlyProvider(existing.provider)) {
    throw spreadsheetUnsupported(
      "SPREADSHEET_WEBHOOK_UNSUPPORTED",
      "Historical spreadsheet sources do not use webhooks",
    );
  }
  const webhookFields = buildWebhookColumns(existing.provider, {
    rotate: true,
    existing,
  });
  const { webhookToken, ...webhookColumns } = webhookFields;
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .update(webhookColumns)
    .eq("id", integrationId)
    .eq("company_id", companyId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return publicConnectionView(data, webhookToken);
}

function integrationInUse() {
  const error = new Error(
    "This integration still has attributed orders, products, or shipping data and cannot be deleted. Disable it instead.",
  );
  error.code = "INTEGRATION_IN_USE";
  return error;
}

async function hasAttributedRows(table, column, companyId, integrationId) {
  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("company_id", companyId)
    .eq(column, integrationId)
    .limit(1);
  if (error) throw new Error(error.message);
  return Boolean(data?.length);
}

async function deleteConnection(companyId, integrationId) {
  await getCompanyOrThrow(companyId);
  const existing = await getConnectionRow(integrationId);
  if (!existing || existing.company_id !== companyId) {
    const error = new Error("Integration connection not found");
    error.code = "INTEGRATION_NOT_FOUND";
    throw error;
  }

  const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";
  const MAPPINGS_TABLE =
    process.env.SUPABASE_BOSTA_SKU_MAPPINGS_TABLE || "bosta_sku_mappings";
  const UNMAPPED_TABLE =
    process.env.SUPABASE_BOSTA_UNMAPPED_PRODUCTS_TABLE || "bosta_unmapped_products";
  const CATALOG_SOURCE_MAPPINGS_TABLE = "catalog_source_mappings";
  const FULFILLMENT_ITEM_MAPPINGS_TABLE = "fulfillment_item_mappings";
  const ORDER_ITEMS_TABLE = process.env.SUPABASE_ORDER_ITEMS_TABLE || "order_items";

  if (
    (await hasAttributedRows(ORDERS_TABLE, "source_integration_id", companyId, integrationId)) ||
    (await hasAttributedRows(ORDERS_TABLE, "shipping_integration_id", companyId, integrationId)) ||
    (await hasAttributedRows(PRODUCTS_TABLE, "source_integration_id", companyId, integrationId)) ||
    (await hasAttributedRows(MAPPINGS_TABLE, "shipping_integration_id", companyId, integrationId)) ||
    (await hasAttributedRows(UNMAPPED_TABLE, "shipping_integration_id", companyId, integrationId)) ||
    (await hasAttributedRows(
      CATALOG_SOURCE_MAPPINGS_TABLE,
      "integration_id",
      companyId,
      integrationId,
    )) ||
    (await hasAttributedRows(
      FULFILLMENT_ITEM_MAPPINGS_TABLE,
      "shipping_integration_id",
      companyId,
      integrationId,
    )) ||
    (await hasAttributedRows(
      ORDER_ITEMS_TABLE,
      "source_integration_id",
      companyId,
      integrationId,
    ))
  ) {
    throw integrationInUse();
  }

  const { error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .delete()
    .eq("id", integrationId)
    .eq("company_id", companyId);
  if (error) {
    if (
      error.code === "23503" ||
      String(error.message || "").toLowerCase().includes("foreign key")
    ) {
      throw integrationInUse();
    }
    throw new Error(error.message);
  }
  return { id: integrationId, deleted: true };
}

function assertUsableConnection(row, { provider, category, companyId } = {}) {
  if (!row) {
    throw integrationNotConfigured(provider || "integration");
  }
  if (companyId && row.company_id !== companyId) {
    const error = new Error("Integration connection does not belong to this company");
    error.code = "INTEGRATION_NOT_OWNED";
    throw error;
  }
  if (provider && row.provider !== provider) {
    const error = new Error("Integration connection provider mismatch");
    error.code = "PROVIDER_MISMATCH";
    throw error;
  }
  if (category && row.category !== category) {
    const error = new Error("Integration connection category mismatch");
    error.code = "PROVIDER_CATEGORY_MISMATCH";
    throw error;
  }
  if (!row.is_enabled) {
    throw integrationDisabled(row.provider);
  }
  return row;
}

async function resolveOwnedConnection({
  integrationId,
  provider,
  category,
} = {}) {
  const companyId = requireActiveCompanyId();
  const active = getActiveIntegration();
  const id = String(integrationId || active?.id || "").trim();

  if (id) {
    const row = await getConnectionRow(id);
    return assertUsableConnection(row, { provider, category, companyId });
  }

  if (!provider) {
    throw integrationNotConfigured("integration");
  }

  if (String(provider || "").toLowerCase() === "salla") {
    const error = new Error("An exact Salla integrationId is required");
    error.code = "SALLA_INTEGRATION_REQUIRED";
    throw error;
  }

  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("company_id", companyId)
    .eq("provider", provider)
    .eq("is_enabled", true);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) throw integrationNotConfigured(provider);
  if (rows.length > 1) {
    const err = new Error(
      `Multiple ${provider} connections exist. Pass integrationId to select one.`,
    );
    err.code = "INTEGRATION_AMBIGUOUS";
    err.provider = provider;
    throw err;
  }
  return rows[0];
}

async function getTenantProviderSecrets(provider, options = {}) {
  const row = await resolveOwnedConnection({
    provider,
    category: options.category,
    integrationId: options.integrationId,
  });
  let secrets;
  try {
    secrets = decryptSecrets(row.credentials);
  } catch {
    throw integrationNotConfigured(provider);
  }
  if (!pickPrimarySecret(provider, secrets)) {
    throw integrationNotConfigured(provider);
  }
  const shopDomain = shopDomainFromRow(row, secrets);
  if (shopDomain) {
    secrets = { ...secrets, shopDomain };
  }
  return { companyId: row.company_id, row, secrets };
}

async function resolveWebhookByToken(provider, rawToken) {
  const def = assertProvider(provider);
  const token = String(rawToken || "").trim();
  if (!token) {
    const error = new Error("Webhook token is required");
    error.code = "WEBHOOK_TOKEN_REQUIRED";
    throw error;
  }
  const hash = hashWebhookToken(token);
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select("*")
    .eq("provider", def.provider)
    .eq("webhook_token_hash", hash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.is_enabled) {
    const unauthorized = new Error("Invalid webhook token");
    unauthorized.code = "WEBHOOK_UNAUTHORIZED";
    throw unauthorized;
  }
  const company = await getCompanyOrThrow(data.company_id);
  if (company.is_active === false || company.deleted_at) {
    const unauthorized = new Error("Invalid webhook token");
    unauthorized.code = "WEBHOOK_UNAUTHORIZED";
    throw unauthorized;
  }
  return { integration: data, company };
}

async function markWebhookReceived(integrationId) {
  if (!integrationId) return;
  await supabase
    .from(INTEGRATIONS_TABLE)
    .update({ last_webhook_at: new Date().toISOString() })
    .eq("id", integrationId);
}

async function testConnection(companyId, integrationId) {
  await getCompanyOrThrow(companyId);
  const row = await getConnectionRow(integrationId);
  if (!row || row.company_id !== companyId) {
    const error = new Error("Integration connection not found");
    error.code = "INTEGRATION_NOT_FOUND";
    throw error;
  }

  if (isIngestionOnlyProvider(row.provider)) {
    throw spreadsheetUnsupported(
      "SPREADSHEET_REMOTE_TEST_UNSUPPORTED",
      "Historical spreadsheet sources do not support remote connection tests",
    );
  }

  if (String(row.provider || "").toLowerCase() === "shopify") {
    let secrets = {};
    try {
      secrets = decryptSecrets(row.credentials);
    } catch {
      secrets = {};
    }
    const { testShopifyConnection } = require("./shopify.service");
    return testShopifyConnection({
      integration: row,
      secrets,
      allowDisabled: true,
    });
  }

  if (String(row.provider || "").toLowerCase() === "salla") {
    const { testSallaConnection } = require("./sallaClient.service");
    return testSallaConnection({
      integration: row,
      allowDisabled: true,
    });
  }

  const view = publicConnectionView(row);
  return {
    ok: view.configured && view.enabled,
    configured: view.configured,
    enabled: view.enabled,
    provider: view.provider,
    integrationId: view.id,
  };
}

module.exports = {
  listConnections,
  listAllConnectionsOverview,
  getConnection,
  createConnection,
  updateConnection,
  rotateWebhookToken,
  deleteConnection,
  resolveOwnedConnection,
  getTenantProviderSecrets,
  resolveWebhookByToken,
  markWebhookReceived,
  testConnection,
  publicConnectionView,
  decryptWebhookToken,
  decryptSecrets,
};
