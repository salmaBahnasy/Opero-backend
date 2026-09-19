#!/usr/bin/env node
/**
 * C1L Shopify dual-write controlled live validation harness.
 * SaaS Development only. NOT an operational endpoint or npm script.
 *
 * Usage:
 *   NODE_ENV=development node scripts/shopify-dualwrite-c1l.js --preflight
 *   NODE_ENV=development node scripts/shopify-dualwrite-c1l.js --validate
 *
 * --preflight is read-only (DB + Shopify GraphQL sample, no product persist).
 * --validate runs bounded persist+canonical write for selected products only,
 * then restores the dual-write gate in-process (does not edit .env).
 */

process.env.NODE_ENV = "development";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ALLOWED_HOST = "iydepmuniwybqgejawhf.supabase.co";
const DEMO_COMPANY_ID = "c214b992-640e-45fb-a0a4-c67edde6da2d";
const SAMPLE_FIRST = 25;
const TABLES = [
  "products",
  "product_variants",
  "product_options",
  "product_option_values",
  "variant_option_values",
  "catalog_source_mappings",
];

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
  const shown = name.slice(0, 3);
  return `${shown}***${rest.length ? `.${rest.join(".")}` : ""}`;
}

function isShopifyDefaultTitle(name, value) {
  return String(name || "") === "Title" && String(value || "") === "Default Title";
}

function classifyNormalized(normalized) {
  const variants = Array.isArray(normalized?.raw_data?.variants)
    ? normalized.raw_data.variants
    : [];
  const complete = Boolean(normalized?.raw_data?.shopify?.variants_complete);
  const truncated = Boolean(normalized?.raw_data?.shopify?.variants_truncated);
  const realOptions = [];
  for (const variant of variants) {
    for (const option of variant.selected_options || []) {
      if (!option?.name || !option?.value) continue;
      if (isShopifyDefaultTitle(option.name, option.value)) continue;
      realOptions.push(`${option.name}=${option.value}`);
    }
  }
  const kind =
    complete && variants.length === 1 && realOptions.length === 0
      ? "simple"
      : complete && (variants.length >= 2 || realOptions.length > 0)
        ? "variable"
        : truncated || !complete
          ? "truncated"
          : "other";
  return {
    kind,
    complete,
    truncated,
    variantCount: variants.length,
    variantIds: variants.map((row) => String(row.id || "")),
    skus: variants.map((row) => row.sku || null),
    optionLabels: [...new Set(realOptions)],
    title: normalized?.name || null,
    externalProductId: String(normalized?.easyorder_id || ""),
  };
}

async function countExact(supabase, table) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) fail("COUNT_FAILED", `count failed for ${table}`, { details: error.message });
  return count;
}

async function counts(supabase) {
  const out = {};
  for (const table of TABLES) out[table] = await countExact(supabase, table);
  return out;
}

async function fetchProductSample({ integration, secrets, shopifyGraphql, query }) {
  const payload = await shopifyGraphql({
    integration,
    secrets,
    query,
    variables: { first: SAMPLE_FIRST, after: null },
  });
  return payload?.data?.products || { nodes: [], pageInfo: {} };
}

function parseArgs(argv) {
  const args = argv.filter((item) => item !== "--");
  return {
    preflight: args.includes("--preflight") || !args.includes("--validate"),
    validate: args.includes("--validate"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = hostOf(process.env.SUPABASE_URL);
  if (host !== ALLOWED_HOST) {
    fail("TARGET_UNVERIFIED", "SUPABASE_URL is not SaaS Development", { host });
  }

  const {
    isShopifyCatalogDualWriteEnabled,
    isCatalogDualWriteShopifyConfigured,
    catalogDualWriteCompanyAllowlist,
  } = require("../src/services/catalogDualWrite.gate");
  const gateBefore = {
    configured: isCatalogDualWriteShopifyConfigured(process.env),
    allowlist: catalogDualWriteCompanyAllowlist(process.env),
    demoEnabled: isShopifyCatalogDualWriteEnabled(DEMO_COMPANY_ID, process.env),
  };
  if (gateBefore.demoEnabled) {
    fail("GATE_ALREADY_ON", "CATALOG_DUAL_WRITE_SHOPIFY is already enabled; refusing to start");
  }
  if (gateBefore.allowlist.some((id) => id && id !== DEMO_COMPANY_ID)) {
    fail(
      "ALLOWLIST_UNSAFE",
      "CATALOG_DUAL_WRITE_COMPANY_IDS already lists a non-demo company",
      { allowlist: gateBefore.allowlist },
    );
  }

  const supabase = require("../src/config/supabase");
  const tenantSupabase = require("../src/config/tenantSupabase");
  const { runWithCompanyId } = require("../src/utils/tenantScope");
  const { getShopifyAdminApiVersion } = require("../src/config/shopify");
  const {
    testShopifyConnection,
    shopifyGraphql,
  } = require("../src/services/shopify.service");
  const {
    SHOPIFY_PRODUCTS_QUERY,
    SHOPIFY_PRODUCT_VARIANTS_QUERY,
    PRODUCT_PAGE_SIZE,
    MAX_PRODUCT_PAGES,
    normalizeShopifyProduct,
    normalizeShopifyVariant,
    persistShopifyProduct,
  } = require("../src/services/shopifyProducts.service");
  const { getTenantProviderSecrets } = require("../src/services/companyIntegrations.service");
  const { writeShopifyCatalogDualWrite } = require("../src/services/catalogShopifyDualWrite.service");

  const company = await supabase
    .from("companies")
    .select("id,name,slug")
    .eq("id", DEMO_COMPANY_ID)
    .maybeSingle();
  if (company.error) fail("COMPANY_LOOKUP_FAILED", company.error.message);
  if (!company.data) fail("COMPANY_NOT_FOUND", "Phase 5 Demo company was not found");

  const preCounts = await runWithCompanyId(DEMO_COMPANY_ID, () => counts(tenantSupabase));
  const integrations = await supabase
    .from("company_integrations")
    .select("id,name,provider,category,is_enabled,company_id,settings")
    .eq("company_id", DEMO_COMPANY_ID)
    .eq("provider", "shopify");
  if (integrations.error) fail("INTEGRATION_LOOKUP_FAILED", integrations.error.message);
  const shopifyRows = (integrations.data || []).map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.is_enabled !== false,
    provider: row.provider,
    category: row.category,
    company_id: row.company_id,
    shopDomain: maskShopDomain(row.settings?.shopDomain || row.settings?.shop_domain),
  }));

  const report = {
    target: { host, match: host === ALLOWED_HOST, company: company.data },
    gate_before: gateBefore,
    pre_counts: preCounts,
    shopify_integrations: shopifyRows,
    connection: null,
    sample: null,
    selected: null,
    collision: null,
    simple: null,
    variable: null,
    second_sync: null,
    post_counts: null,
    gate_after: null,
    rpc_invocations: 0,
  };

  if (!shopifyRows.length) {
    report.verdict = "BLOCKED_NO_VALID_SHOPIFY_CONNECTION";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const enabled = shopifyRows.filter((row) => row.enabled);
  if (!enabled.length) {
    report.connection = { valid: false, reason: "INTEGRATION_DISABLED" };
    report.verdict = "BLOCKED_NO_VALID_SHOPIFY_CONNECTION";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const apiVersion = getShopifyAdminApiVersion();
  const connectionAttempts = [];
  let chosen = null;
  let chosenSecrets = null;
  let chosenRow = null;
  let productConnection = null;
  let classified = [];

  for (const candidate of enabled) {
    let row;
    let secrets;
    try {
      ({ row, secrets } = await runWithCompanyId(DEMO_COMPANY_ID, () =>
        getTenantProviderSecrets("shopify", {
          integrationId: candidate.id,
          category: "commerce",
        }),
      ));
    } catch (error) {
      connectionAttempts.push({
        id: candidate.id,
        name: candidate.name,
        valid: false,
        code: error.code || "SHOPIFY_SECRETS_FAILED",
        message: error.message,
      });
      continue;
    }
    let connection;
    try {
      connection = await testShopifyConnection({ integration: row, secrets });
    } catch (error) {
      connectionAttempts.push({
        id: candidate.id,
        name: candidate.name,
        valid: false,
        code: error.code || "SHOPIFY_CONNECTION_FAILED",
        message: error.message,
        statusCode: error.statusCode || null,
        shopDomain: maskShopDomain(secrets?.shopDomain || secrets?.shop_domain),
        apiVersion,
      });
      continue;
    }
    let sample;
    try {
      sample = await fetchProductSample({
        integration: row,
        secrets,
        shopifyGraphql,
        query: SHOPIFY_PRODUCTS_QUERY,
      });
    } catch (error) {
      connectionAttempts.push({
        id: candidate.id,
        name: candidate.name,
        valid: true,
        shopDomain: maskShopDomain(connection.shopDomain),
        shopName: connection.shopName || null,
        apiVersion,
        product_read_available: false,
        code: error.code || "SHOPIFY_PRODUCT_READ_FAILED",
        message: error.message,
      });
      continue;
    }
    const nodes = Array.isArray(sample.nodes) ? sample.nodes : [];
    const thisClassified = [];
    for (const node of nodes) {
      const productId = String(node?.legacyResourceId || "").replace(/\D/g, "") || null;
      if (!productId) continue;
      let variantNodes = Array.isArray(node?.variants?.nodes) ? [...node.variants.nodes] : [];
      let variantsComplete = !node?.variants?.pageInfo?.hasNextPage;
      if (!variantsComplete) {
        let cursor = node.variants.pageInfo.endCursor || null;
        let pages = 0;
        while (cursor && pages < 10) {
          const extra = await shopifyGraphql({
            integration: row,
            secrets,
            query: SHOPIFY_PRODUCT_VARIANTS_QUERY,
            variables: { id: node.id, first: 100, after: cursor },
          });
          const extraConnection = extra?.data?.product?.variants || {};
          variantNodes.push(...(extraConnection.nodes || []));
          if (!extraConnection.pageInfo?.hasNextPage) {
            variantsComplete = true;
            break;
          }
          cursor = extraConnection.pageInfo.endCursor || null;
          pages += 1;
        }
      }
      const variants = variantNodes.map((variant) => normalizeShopifyVariant(variant, productId));
      const normalized = normalizeShopifyProduct(node, {
        sourceIntegrationId: row.id,
        variants,
        variantsComplete,
      });
      thisClassified.push({
        normalized,
        summary: classifyNormalized(normalized),
      });
    }
    const hasSimple = thisClassified.some((item) => item.summary.kind === "simple");
    const hasVariable = thisClassified.some((item) => item.summary.kind === "variable");
    connectionAttempts.push({
      id: candidate.id,
      name: candidate.name,
      valid: true,
      shopDomain: maskShopDomain(connection.shopDomain),
      shopName: connection.shopName || null,
      apiVersion,
      product_read_available: true,
      sample_count: thisClassified.length,
      simple_found: hasSimple,
      variable_found: hasVariable,
    });
    const better =
      !chosen ||
      (hasSimple && hasVariable && !(classified.some((item) => item.summary.kind === "simple") &&
        classified.some((item) => item.summary.kind === "variable")));
    if (better) {
      chosen = candidate;
      chosenRow = row;
      chosenSecrets = secrets;
      productConnection = sample;
      classified = thisClassified;
    }
  }

  report.connection_attempts = connectionAttempts;
  if (!chosen || !chosenRow) {
    report.connection = { valid: false, apiVersion };
    report.verdict = "BLOCKED_NO_VALID_SHOPIFY_CONNECTION";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const row = chosenRow;
  report.selected_integration_id = chosen.id;
  report.selected_integration_name = chosen.name;
  report.connection = {
    valid: true,
    shopDomain: connectionAttempts.find((item) => item.id === chosen.id)?.shopDomain || null,
    shopName: connectionAttempts.find((item) => item.id === chosen.id)?.shopName || null,
    apiVersion,
    product_read_attempted: true,
    product_read_available: true,
  };

  const simple = classified.find((item) => item.summary.kind === "simple");
  const variable = classified.find((item) => item.summary.kind === "variable");
  report.sample = {
    fetched: classified.length,
    pageInfo: {
      hasNextPage: Boolean(productConnection.pageInfo?.hasNextPage),
    },
    kinds: classified.reduce((acc, item) => {
      acc[item.summary.kind] = (acc[item.summary.kind] || 0) + 1;
      return acc;
    }, {}),
    titles: classified.map((item) => ({
      id: item.summary.externalProductId,
      title: item.summary.title,
      kind: item.summary.kind,
      variants: item.summary.variantCount,
      complete: item.summary.complete,
    })),
  };
  report.simple_found = Boolean(simple);
  report.variable_found = Boolean(variable);
  report.selected = {
    simple: simple
      ? {
          externalProductId: simple.summary.externalProductId,
          title: simple.summary.title,
          variantIds: simple.summary.variantIds,
          skus: simple.summary.skus,
        }
      : null,
    variable: variable
      ? {
          externalProductId: variable.summary.externalProductId,
          title: variable.summary.title,
          variantIds: variable.summary.variantIds,
          skus: variable.summary.skus,
          options: variable.summary.optionLabels,
        }
      : null,
  };

  const targets = [simple, variable].filter(Boolean);
  if (!targets.length) {
    report.verdict = "CONTROLLED_SAMPLE_NOT_AVAILABLE";
    report.reason = "No complete simple or variable Shopify product in the bounded sample";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const occupancy = await runWithCompanyId(DEMO_COMPANY_ID, () =>
    tenantSupabase.from("product_variants").select("id,product_id,internal_sku,barcode"),
  );
  const existingParents = await runWithCompanyId(DEMO_COMPANY_ID, () =>
    tenantSupabase
      .from("products")
      .select("id,easyorder_id,source_integration_id,name,sku")
      .eq("source_integration_id", row.id),
  );
  const existingMaps = await runWithCompanyId(DEMO_COMPANY_ID, () =>
    tenantSupabase
      .from("catalog_source_mappings")
      .select(
        "id,integration_id,external_product_id,external_variant_id,internal_product_id,internal_variant_id",
      )
      .eq("integration_id", row.id),
  );

  const collision = [];
  for (const item of targets) {
    const ext = item.summary.externalProductId;
    const parent = (existingParents.data || []).find(
      (rowItem) => String(rowItem.easyorder_id) === String(ext),
    );
    const maps = (existingMaps.data || []).filter(
      (rowItem) => String(rowItem.external_product_id) === String(ext),
    );
    const incomingSkus = (item.summary.skus || []).filter(Boolean);
    const skuHits = (occupancy.data || []).filter(
      (rowItem) => incomingSkus.includes(rowItem.internal_sku),
    );
    const predicted = maps.length
      ? "REUSE_OR_UPDATE"
      : parent
        ? "CREATE_CANONICAL_ON_EXISTING_PARENT"
        : skuHits.length
          ? "POSSIBLE_OCCUPANCY_CONFLICT"
          : "CREATE";
    collision.push({
      externalProductId: ext,
      existingParentId: parent?.id || null,
      existingMappingCount: maps.length,
      skuOccupancyHits: skuHits.length,
      predicted,
    });
  }
  report.collision = collision;
  const unexpected = collision.filter(
    (rowItem) => rowItem.existingMappingCount > 0 || rowItem.skuOccupancyHits > 0,
  );
  if (unexpected.length) {
    report.verdict = "SHOPIFY_DUAL_WRITE_VALIDATION_FAILED";
    report.reason =
      "Unexpected existing mappings or SKU occupancy for selected Shopify products; refusing mutation";
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!args.validate) {
    report.verdict = "PREFLIGHT_READY";
    report.sync_scope = {
      production_sync_page_size: PRODUCT_PAGE_SIZE,
      production_sync_max_pages: MAX_PRODUCT_PAGES,
      production_sync_persists_every_returned_product: true,
      exact_product_targeting_supported: false,
      harness:
        "scripts/shopify-dualwrite-c1l.js bounded GraphQL sample + persist only selected products",
      sample_first: SAMPLE_FIRST,
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const gateEnv = {
    ...process.env,
    CATALOG_DUAL_WRITE_SHOPIFY: "true",
    CATALOG_DUAL_WRITE_COMPANY_IDS: DEMO_COMPANY_ID,
  };
  report.gate_enable_mechanism =
    "in-process env object passed to writeShopifyCatalogDualWrite; .env and hosted env untouched";

  const rpcWrap = [];
  const originalRpc = supabase.rpc.bind(supabase);
  supabase.rpc = (name, rpcArgs) => {
    rpcWrap.push({ name });
    return originalRpc(name, rpcArgs);
  };

  async function loadCanonicalRows(productId) {
    return runWithCompanyId(DEMO_COMPANY_ID, async () => {
      const productRow = await tenantSupabase.from("products").select("*").eq("id", productId).maybeSingle();
      const variants = await tenantSupabase.from("product_variants").select("*").eq("product_id", productId);
      const options = await tenantSupabase.from("product_options").select("*").eq("product_id", productId);
      const values = await tenantSupabase.from("product_option_values").select("*").eq("product_id", productId);
      const links = await tenantSupabase.from("variant_option_values").select("*").eq("product_id", productId);
      const maps = await tenantSupabase
        .from("catalog_source_mappings")
        .select("*")
        .eq("internal_product_id", productId);
      return { productRow, variants, options, values, links, maps };
    });
  }

  async function dualWriteOne(item, label) {
    const normalized = item.normalized;
    const saved = await runWithCompanyId(DEMO_COMPANY_ID, () =>
      persistShopifyProduct({
        sourceIntegrationId: row.id,
        normalized,
      }),
    );
    const first = await writeShopifyCatalogDualWrite({
      companyId: DEMO_COMPANY_ID,
      integration: row,
      productId: saved.id,
      externalProductId: normalized.easyorder_id,
      normalized,
      variantsComplete: Boolean(normalized.raw_data?.shopify?.variants_complete),
      env: gateEnv,
    });
    const afterFirst = await loadCanonicalRows(saved.id);
    const firstVariantIds = (afterFirst.variants.data || []).map((rowItem) => rowItem.id);
    const savedAgain = await runWithCompanyId(DEMO_COMPANY_ID, () =>
      persistShopifyProduct({
        sourceIntegrationId: row.id,
        normalized,
      }),
    );
    const second = await writeShopifyCatalogDualWrite({
      companyId: DEMO_COMPANY_ID,
      integration: row,
      productId: savedAgain.id,
      externalProductId: normalized.easyorder_id,
      normalized,
      variantsComplete: Boolean(normalized.raw_data?.shopify?.variants_complete),
      env: gateEnv,
    });
    const { productRow, variants, options, values, links, maps } = await loadCanonicalRows(
      savedAgain.id,
    );
    return {
      label,
      legacy: { id: saved.id, created: saved.created, updated: saved.updated },
      parent_stable: saved.id === savedAgain.id,
      first_variant_ids: firstVariantIds,
      variant_ids_stable:
        JSON.stringify(firstVariantIds) ===
        JSON.stringify((variants.data || []).map((rowItem) => rowItem.id)),
      first: {
        canonicalStatus: first.canonicalStatus,
        writerInvoked: first.writerInvoked,
        error: first.canonicalError,
        diagnostics: first.diagnostics,
        planActions: (first.plan?.variants || []).map((rowItem) => rowItem.action),
      },
      second: {
        canonicalStatus: second.canonicalStatus,
        writerInvoked: second.writerInvoked,
        error: second.canonicalError,
        planActions: (second.plan?.variants || []).map((rowItem) => rowItem.action),
        variantIds: (second.canonicalResult?.variantIds || first.canonicalResult?.variantIds || []),
      },
      product: productRow.data && {
        id: productRow.data.id,
        company_id: productRow.data.company_id,
        product_type: productRow.data.product_type,
        easyorder_id: productRow.data.easyorder_id,
        source_integration_id: productRow.data.source_integration_id,
        name: productRow.data.name,
        sku: productRow.data.sku,
        raw_data_provider: productRow.data.raw_data?.provider || null,
      },
      variants: (variants.data || []).map((rowItem) => ({
        id: rowItem.id,
        title: rowItem.title,
        internal_sku: rowItem.internal_sku,
        price: rowItem.price,
        is_default: rowItem.is_default,
        barcode: rowItem.barcode,
        compare_at_price: rowItem.compare_at_price,
      })),
      options: (options.data || []).map((rowItem) => ({ name: rowItem.name, position: rowItem.position })),
      option_values: (values.data || []).length,
      links: (links.data || []).length,
      mappings: (maps.data || []).map((rowItem) => ({
        id: rowItem.id,
        company_id: rowItem.company_id,
        integration_id: rowItem.integration_id,
        external_product_id: rowItem.external_product_id,
        external_variant_id: rowItem.external_variant_id,
        internal_product_id: rowItem.internal_product_id,
        internal_variant_id: rowItem.internal_variant_id,
      })),
    };
  }

  try {
    if (simple) report.simple = await dualWriteOne(simple, "simple");
    if (variable) report.variable = await dualWriteOne(variable, "variable");
  } finally {
    supabase.rpc = originalRpc;
    report.rpc_invocations = rpcWrap.length;
    report.gate_after = {
      process_env_configured: isCatalogDualWriteShopifyConfigured(process.env),
      process_env_demo_enabled: isShopifyCatalogDualWriteEnabled(DEMO_COMPANY_ID, process.env),
      validation_env_would_enable: isShopifyCatalogDualWriteEnabled(DEMO_COMPANY_ID, gateEnv),
    };
  }

  report.post_counts = await runWithCompanyId(DEMO_COMPANY_ID, () => counts(tenantSupabase));
  const defaultCount = (rows) => (rows || []).filter((rowItem) => rowItem.is_default).length;
  report.second_sync = {
    simple_parent_stable: !report.simple || report.simple.parent_stable,
    variable_parent_stable: !report.variable || report.variable.parent_stable,
    simple_variant_ids_stable: !report.simple || report.simple.variant_ids_stable,
    variable_variant_ids_stable: !report.variable || report.variable.variant_ids_stable,
    simple_second_status: report.simple?.second?.canonicalStatus || null,
    variable_second_status: report.variable?.second?.canonicalStatus || null,
    simple_defaults: defaultCount(report.simple?.variants),
    variable_defaults: defaultCount(report.variable?.variants),
  };

  const mappingErrors = [];
  for (const block of [report.simple, report.variable].filter(Boolean)) {
    for (const mapping of block.mappings || []) {
      if (mapping.company_id !== DEMO_COMPANY_ID) mappingErrors.push("company mismatch");
      if (mapping.integration_id !== row.id) mappingErrors.push("integration mismatch");
      if (!mapping.external_variant_id) mappingErrors.push("blank variant id");
      if (mapping.internal_product_id !== block.legacy.id) mappingErrors.push("parent mismatch");
    }
  }
  report.mapping_errors = mappingErrors;

  function blockFailed(block, expectedType) {
    if (!block) return false;
    const okStatus = block.first?.canonicalStatus === "written" || block.first?.canonicalStatus === "reused";
    const secondOk =
      block.second?.canonicalStatus === "written" || block.second?.canonicalStatus === "reused";
    const typeOk = block.product?.product_type === expectedType;
    const defaultOk = expectedType === "simple"
      ? defaultCount(block.variants) === 1 && (block.variants || []).length === 1
      : defaultCount(block.variants) === 1 && (block.variants || []).length >= 2;
    const noDefaultTitle = !(block.options || []).some((option) => option.name === "Title");
    return !okStatus || !secondOk || !typeOk || !defaultOk || !noDefaultTitle || !block.parent_stable;
  }
  const failed =
    mappingErrors.length > 0 ||
    blockFailed(report.simple, "simple") ||
    blockFailed(report.variable, "variable");
  report.verdict = failed
    ? "SHOPIFY_DUAL_WRITE_VALIDATION_FAILED"
    : "SHOPIFY_DUAL_WRITE_LIVE_VALIDATED";
  report.retained_ids = {
    simple_product_id: report.simple?.legacy?.id || null,
    variable_product_id: report.variable?.legacy?.id || null,
    simple_variant_ids: (report.simple?.variants || []).map((rowItem) => rowItem.id),
    variable_variant_ids: (report.variable?.variants || []).map((rowItem) => rowItem.id),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: error.code || "C1L_FAILED",
        message: error.message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
