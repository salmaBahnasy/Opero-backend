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
} = require("../integrations/catalog");

const INTEGRATIONS_TABLE =
  process.env.SUPABASE_COMPANY_INTEGRATIONS_TABLE || "company_integrations";
const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";

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
  const apiBaseUrl = credentials.apiBaseUrl ?? credentials.api_base_url;

  if (apiKey != null && String(apiKey).trim() !== "") {
    secrets.apiKey = String(apiKey).trim();
  }
  if (fulfillmentApiKey != null && String(fulfillmentApiKey).trim() !== "") {
    secrets.fulfillmentApiKey = String(fulfillmentApiKey).trim();
  }
  if (accessToken != null && String(accessToken).trim() !== "") {
    secrets.accessToken = String(accessToken).trim();
  }
  if (apiBaseUrl != null && String(apiBaseUrl).trim() !== "") {
    secrets.apiBaseUrl = String(apiBaseUrl).trim().replace(/\/$/, "");
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

function mergeConnectionSettings(existingSettings, body = {}) {
  const current =
    existingSettings && typeof existingSettings === "object" ? { ...existingSettings } : {};
  const incoming = body.settings && typeof body.settings === "object" ? body.settings : {};
  const settings = { ...current, ...incoming };
  const shopDomain = pickShopDomain(body);
  if (shopDomain) settings.shopDomain = shopDomain;
  delete settings.apiKey;
  delete settings.api_key;
  delete settings.accessToken;
  delete settings.access_token;
  delete settings.fulfillmentApiKey;
  delete settings.fulfillment_api_key;
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

function publicConnectionView(row, decryptedToken = null) {
  let secrets = {};
  try {
    secrets = decryptSecrets(row?.credentials);
  } catch {
    secrets = {};
  }
  const primary = pickPrimarySecret(row?.provider, secrets);
  const token = decryptedToken || decryptWebhookToken(row);
  return {
    id: row.id,
    companyId: row.company_id,
    category: row.category,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.is_enabled),
    configured: Boolean(primary),
    apiKeyMasked: maskSecret(primary),
    providerAccountId: row.provider_account_id || null,
    shopDomain: shopDomainFromRow(row, secrets),
    webhookUrl: token ? buildWebhookUrl(row.provider, token) : null,
    webhookConfigured: Boolean(row.webhook_token_hash),
    webhookTokenCreatedAt: row.webhook_token_created_at || null,
    webhookTokenRotatedAt: row.webhook_token_rotated_at || null,
    lastWebhookAt: row.last_webhook_at || null,
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
  const incomingSecrets = normalizeIncomingSecrets(def.provider, body);
  const webhookFields = buildWebhookColumns(def.provider, { rotate: true });
  const { webhookToken, ...webhookColumns } = webhookFields;

  const payload = {
    company_id: companyId,
    category: def.category,
    provider: def.provider,
    name,
    is_enabled: body.enabled != null || body.is_enabled != null
      ? Boolean(body.enabled ?? body.is_enabled)
      : true,
    credentials: encryptJson(incomingSecrets),
    settings: mergeConnectionSettings({}, body),
    provider_account_id:
      body.providerAccountId || body.provider_account_id || null,
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
  if (body.providerAccountId !== undefined || body.provider_account_id !== undefined) {
    updates.provider_account_id =
      body.providerAccountId || body.provider_account_id || null;
  }
  if (settingsTouched(body)) {
    updates.settings = mergeConnectionSettings(existing.settings, body);
  }

  const incomingSecrets = normalizeIncomingSecrets(existing.provider, body);
  if (Object.keys(incomingSecrets).length) {
    const previous = existing.credentials ? decryptSecrets(existing.credentials) : {};
    const nextSecrets = { ...previous, ...incomingSecrets };
    const legacyDomain = nextSecrets.shopDomain || nextSecrets.shop_domain;
    delete nextSecrets.shopDomain;
    delete nextSecrets.shop_domain;
    updates.credentials = encryptJson(nextSecrets);
    if (legacyDomain && !shopDomainFromRow({ settings: updates.settings || existing.settings })) {
      updates.settings = mergeConnectionSettings(updates.settings || existing.settings, {
        settings: { shopDomain: String(legacyDomain).trim() },
      });
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

async function deleteConnection(companyId, integrationId) {
  await getCompanyOrThrow(companyId);
  const existing = await getConnectionRow(integrationId);
  if (!existing || existing.company_id !== companyId) {
    const error = new Error("Integration connection not found");
    error.code = "INTEGRATION_NOT_FOUND";
    throw error;
  }
  const { error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .delete()
    .eq("id", integrationId)
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
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
  const view = await getConnection(companyId, integrationId);
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
