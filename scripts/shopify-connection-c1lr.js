#!/usr/bin/env node
/**
 * C1L-R Shopify Egypt connection diagnosis.
 * SaaS Development / Phase 5 Demo only. Read-only. NOT an operational command.
 *
 * Usage: NODE_ENV=development node scripts/shopify-connection-c1lr.js
 */

process.env.NODE_ENV = "development";

const dns = require("dns").promises;
const path = require("path");
const axios = require("axios");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ALLOWED_HOST = "iydepmuniwybqgejawhf.supabase.co";
const DEMO_COMPANY_ID = "c214b992-640e-45fb-a0a4-c67edde6da2d";
const TARGET_INTEGRATION_ID = "cc7a8e2e-cd3d-46d3-988f-88ce9a96a62b";
function fail(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function hostOf(urlText) {
  try {
    return new URL(String(urlText || "").trim()).hostname;
  } catch {
    return "";
  }
}

function maskShopDomain(domain) {
  const text = String(domain || "").trim();
  if (!text) return null;
  const host = text.replace(/^https?:\/\//, "").split("/")[0];
  const [name, ...rest] = host.split(".");
  if (!name) return "***";
  return `${name.slice(0, 3)}***${rest.length ? `.${rest.join(".")}` : ""}`;
}

function sanitizeText(value) {
  let text = String(value == null ? "" : value);
  if (!text) return "";
  text = text.replace(/shpat_[A-Za-z0-9]+/gi, "[redacted]");
  text = text.replace(/shpua_[A-Za-z0-9]+/gi, "[redacted]");
  text = text.replace(/shpca_[A-Za-z0-9]+/gi, "[redacted]");
  text = text.replace(/shpss_[A-Za-z0-9]+/gi, "[redacted]");
  text = text.replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted]");
  text = text.replace(/sb_secret_[A-Za-z0-9]+/gi, "[redacted]");
  return text.slice(0, 240);
}

function tokenShape(token) {
  const text = String(token || "");
  if (!text) return "absent";
  if (/^shpat_/i.test(text)) return "shopify_admin_api_access_token";
  if (/^shpca_/i.test(text)) return "shopify_custom_app_token";
  if (/^shpua_/i.test(text)) return "shopify_user_access_token";
  if (/^shptka_/i.test(text)) return "shopify_unknown_prefixed_token";
  return "unknown_shape";
}

function classifyFailure({ network, httpStatus, graphqlErrors, errorsText }) {
  if (network) {
    if (network.code === "ENOTFOUND" || network.code === "EAI_AGAIN") {
      return "SHOPIFY_DNS_FAILURE";
    }
    if (network.code === "ECONNABORTED" || network.code === "ETIMEDOUT") {
      return "SHOPIFY_NETWORK_TIMEOUT";
    }
    if (String(network.code || "").includes("TLS") || network.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      return "SHOPIFY_TLS_FAILURE";
    }
    return "SHOPIFY_PROVIDER_UNAVAILABLE";
  }
  if (httpStatus === 401) return "SHOPIFY_TOKEN_INVALID";
  if (httpStatus === 403) return "SHOPIFY_PERMISSION_DENIED";
  if (httpStatus === 429) return "SHOPIFY_RATE_LIMITED";
  if (httpStatus >= 500) return "SHOPIFY_PROVIDER_5XX";
  if (httpStatus === 404) {
    const blob = `${errorsText || ""} ${JSON.stringify(graphqlErrors || [])}`.toLowerCase();
    if (blob.includes("version") && (blob.includes("invalid") || blob.includes("unsupported"))) {
      return "SHOPIFY_API_VERSION_UNSUPPORTED";
    }
    return "SHOPIFY_SHOP_UNAVAILABLE";
  }
  if (graphqlErrors && graphqlErrors.length) return "SHOPIFY_GRAPHQL_ERROR";
  if (httpStatus && httpStatus !== 200) return "UNKNOWN_SHOPIFY_CONNECTION_FAILURE";
  return null;
}

async function main() {
  const host = hostOf(process.env.SUPABASE_URL);
  if (host !== ALLOWED_HOST) fail("TARGET_UNVERIFIED", "SUPABASE_URL is not SaaS Development", { host });

  const {
    isShopifyCatalogDualWriteEnabled,
    isCatalogDualWriteShopifyConfigured,
    catalogDualWriteCompanyAllowlist,
  } = require("../src/services/catalogDualWrite.gate");
  const gate = {
    configured: isCatalogDualWriteShopifyConfigured(process.env),
    allowlist: catalogDualWriteCompanyAllowlist(process.env),
    demoEnabled: isShopifyCatalogDualWriteEnabled(DEMO_COMPANY_ID, process.env),
  };
  if (gate.configured || gate.demoEnabled || gate.allowlist.length) {
    fail("GATE_NOT_OFF", "CATALOG_DUAL_WRITE_SHOPIFY must remain OFF for C1L-R", gate);
  }

  const supabase = require("../src/config/supabase");
  const tenantSupabase = require("../src/config/tenantSupabase");
  const { runWithCompanyId } = require("../src/utils/tenantScope");
  const { getTenantProviderSecrets } = require("../src/services/companyIntegrations.service");
  const {
    getShopifyAdminApiVersion,
    shopifyGraphqlUrl,
    getShopifyAdminApiTimeoutMs,
  } = require("../src/config/shopify");
  const { normalizeShopifyShopDomain } = require("../src/utils/shopifyDomain");
  const { SHOP_QUERY, assertShopifyIntegration } = require("../src/services/shopify.service");

  const company = await supabase
    .from("companies")
    .select("id,name,slug")
    .eq("id", DEMO_COMPANY_ID)
    .maybeSingle();
  if (company.error) fail("COMPANY_LOOKUP_FAILED", company.error.message);
  if (!company.data) fail("COMPANY_NOT_FOUND", "Phase 5 Demo company was not found");

  const integration = await supabase
    .from("company_integrations")
    .select("id,name,provider,category,is_enabled,company_id,settings")
    .eq("id", TARGET_INTEGRATION_ID)
    .maybeSingle();
  if (integration.error) fail("INTEGRATION_LOOKUP_FAILED", integration.error.message);
  const rowMeta = integration.data;
  if (!rowMeta) fail("INTEGRATION_NOT_FOUND", "Shopify Egypt was not found");
  if (rowMeta.company_id !== DEMO_COMPANY_ID) fail("TARGET_UNVERIFIED", "Integration is not owned by Phase 5 Demo");
  if (String(rowMeta.provider || "").toLowerCase() !== "shopify") {
    fail("TARGET_UNVERIFIED", "Integration provider is not shopify");
  }
  if (rowMeta.is_enabled === false) fail("TARGET_UNVERIFIED", "Shopify Egypt is not enabled");

  const counts = {};
  await runWithCompanyId(DEMO_COMPANY_ID, async () => {
    for (const table of [
      "products",
      "product_variants",
      "product_options",
      "product_option_values",
      "variant_option_values",
      "catalog_source_mappings",
    ]) {
      const { count, error } = await tenantSupabase
        .from(table)
        .select("*", { count: "exact", head: true });
      if (error) fail("COUNT_FAILED", error.message);
      counts[table] = count;
    }
  });

  const { row, secrets } = await runWithCompanyId(DEMO_COMPANY_ID, () =>
    getTenantProviderSecrets("shopify", {
      integrationId: TARGET_INTEGRATION_ID,
      category: "commerce",
    }),
  );

  const rawDomain =
    row.settings?.shopDomain ||
    row.settings?.shop_domain ||
    secrets.shopDomain ||
    secrets.shop_domain ||
    "";
  const domainPresent = Boolean(String(rawDomain).trim());
  const domainFlags = {
    has_https_prefix: /^https?:\/\//i.test(String(rawDomain)),
    trailing_slash: /\/$/.test(String(rawDomain).trim()),
    has_admin_path: /\/admin/i.test(String(rawDomain)),
    has_whitespace: String(rawDomain) !== String(rawDomain).trim() || /\s/.test(String(rawDomain).trim()),
    empty: !domainPresent,
  };
  let normalizedDomain = null;
  let domainFormatValid = false;
  let domainNormalizeError = null;
  try {
    normalizedDomain = normalizeShopifyShopDomain(rawDomain);
    domainFormatValid = true;
  } catch (error) {
    domainNormalizeError = error.message;
  }

  const accessTokenPresent = Boolean(String(secrets.accessToken || secrets.access_token || "").trim());
  const webhookSecretPresent = Boolean(
    String(
      secrets.webhookSecret ||
        secrets.webhook_secret ||
        secrets.clientSecret ||
        secrets.apiSecret ||
        "",
    ).trim(),
  );
  const shape = tokenShape(secrets.accessToken || secrets.access_token);
  const apiVersion = getShopifyAdminApiVersion();
  const endpoint = domainFormatValid ? shopifyGraphqlUrl(normalizedDomain, apiVersion) : null;
  const endpointShape = endpoint
    ? endpoint.replace(normalizedDomain, "<shop>.myshopify.com")
    : null;

  const report = {
    target: {
      host,
      company: company.data,
      integration: {
        id: rowMeta.id,
        name: rowMeta.name,
        provider: rowMeta.provider,
        enabled: rowMeta.is_enabled !== false,
        company_id: rowMeta.company_id,
        settings_keys: Object.keys(row.settings && typeof row.settings === "object" ? row.settings : {}),
        settings_shopDomain_present: Boolean(
          row.settings?.shopDomain || row.settings?.shop_domain,
        ),
      },
    },
    gate,
    catalog_counts: counts,
    credentials: {
      shopDomain_present: domainPresent,
      shopDomain_in_settings: Boolean(row.settings?.shopDomain || row.settings?.shop_domain),
      shopDomain_in_secrets: Boolean(secrets.shopDomain || secrets.shop_domain),
      masked_domain: maskShopDomain(rawDomain),
      domain_flags: domainFlags,
      domain_format_valid: domainFormatValid,
      domain_normalize_error: domainNormalizeError,
      accessToken_present: accessTokenPresent,
      webhookSecret_present: webhookSecretPresent,
      token_shape: shape,
      expected_auth: "custom_app_admin_api_access_token",
    },
    api: {
      version: apiVersion,
      version_source: process.env.SHOPIFY_ADMIN_API_VERSION ? "env" : "default_2026-07",
      endpoint_shape: endpointShape,
      method: "POST",
      query: "ShopifyConnectionTest shop { name myshopifyDomain }",
      header_names: ["Content-Type", "X-Shopify-Access-Token"],
    },
    dns: null,
    probe: null,
    classified: null,
  };

  if (!domainFormatValid) {
    report.classified = "SHOPIFY_DOMAIN_INVALID";
    report.verdict = "READY_TO_CORRECT_SHOP_DOMAIN";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  try {
    const lookup = await dns.lookup(normalizedDomain);
    report.dns = {
      resolved: true,
      family: lookup.family,
    };
  } catch (error) {
    report.dns = {
      resolved: false,
      code: error.code || null,
      message: sanitizeText(error.message),
    };
    report.classified = "SHOPIFY_DNS_FAILURE";
    report.verdict = "READY_TO_CORRECT_SHOP_DOMAIN";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const resolved = assertShopifyIntegration(row, secrets, { requireEnabled: true });
  const timeout = getShopifyAdminApiTimeoutMs();
  let probe;
  try {
    const response = await axios.post(
      shopifyGraphqlUrl(resolved.shopDomain, apiVersion),
      { query: SHOP_QUERY },
      {
        timeout,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": resolved.accessToken,
        },
        validateStatus: () => true,
      },
    );
    const headers = response.headers || {};
    const data = response.data;
    const dataType = data == null ? "null" : Array.isArray(data) ? "array" : typeof data;
    let errorsText = null;
    let graphqlErrors = [];
    if (data && typeof data === "object") {
      if (typeof data.errors === "string") errorsText = sanitizeText(data.errors);
      if (Array.isArray(data.errors)) {
        graphqlErrors = data.errors.slice(0, 5).map((entry) => ({
          message: sanitizeText(entry?.message),
          code: sanitizeText(entry?.extensions?.code || entry?.code || ""),
        }));
      }
    } else if (typeof data === "string") {
      errorsText = sanitizeText(data.slice(0, 180));
    }
    probe = {
      live: true,
      http_status: response.status,
      content_type: headers["content-type"] || headers["Content-Type"] || null,
      shopify_request_id:
        headers["x-request-id"] ||
        headers["X-Request-Id"] ||
        headers["x-shopify-request-id"] ||
        null,
      shopify_api_version_header: headers["x-shopify-api-version"] || headers["X-Shopify-API-Version"] || null,
      data_type: dataType,
      data_keys:
        data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).sort() : [],
      errors_text: errorsText,
      graphql_errors: graphqlErrors,
      shop_name_present: Boolean(data?.data?.shop?.name),
      remote_domain_present: Boolean(data?.data?.shop?.myshopifyDomain),
      remote_domain_masked: data?.data?.shop?.myshopifyDomain
        ? maskShopDomain(data.data.shop.myshopifyDomain)
        : null,
    };
  } catch (error) {
    probe = {
      live: true,
      network: true,
      code: error.code || null,
      message: sanitizeText(error.message),
      syscall: error.syscall || null,
    };
  }
  report.probe = probe;
  report.classified = classifyFailure({
    network: probe.network ? probe : null,
    httpStatus: probe.http_status,
    graphqlErrors: probe.graphql_errors,
    errorsText: probe.errors_text,
  });

  if (probe.http_status === 200 && probe.shop_name_present && probe.remote_domain_present) {
    report.verdict = "READY_TO_RETRY_C1L";
  } else if (report.classified === "SHOPIFY_TOKEN_INVALID" || report.classified === "SHOPIFY_TOKEN_REVOKED") {
    report.verdict = "READY_TO_REAUTHORIZE_SHOPIFY";
  } else if (report.classified === "SHOPIFY_PERMISSION_DENIED") {
    report.verdict = "READY_TO_FIX_SHOPIFY_SCOPES";
  } else if (report.classified === "SHOPIFY_DOMAIN_INVALID" || report.classified === "SHOPIFY_DNS_FAILURE") {
    report.verdict = "READY_TO_CORRECT_SHOP_DOMAIN";
  } else if (
    report.classified === "SHOPIFY_NETWORK_TIMEOUT" ||
    report.classified === "SHOPIFY_TLS_FAILURE" ||
    report.classified === "SHOPIFY_PROVIDER_5XX" ||
    report.classified === "SHOPIFY_RATE_LIMITED" ||
    report.classified === "SHOPIFY_PROVIDER_UNAVAILABLE"
  ) {
    report.verdict = "TEMPORARY_SHOPIFY_PROVIDER_OR_NETWORK_FAILURE";
  } else if (report.classified === "SHOPIFY_API_VERSION_UNSUPPORTED") {
    report.verdict = "DIAGNOSIS_INCOMPLETE";
  } else if (report.classified === "SHOPIFY_SHOP_UNAVAILABLE") {
    report.verdict = "READY_TO_CORRECT_SHOP_DOMAIN";
  } else {
    report.verdict = "DIAGNOSIS_INCOMPLETE";
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: error.code || "C1LR_FAILED",
        message: error.message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
