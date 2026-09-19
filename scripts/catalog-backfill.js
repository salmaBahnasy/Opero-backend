#!/usr/bin/env node
/**
 * Catalog backfill CLI — C1C DRY-RUN ONLY.
 *
 * Usage:
 *   node scripts/catalog-backfill.js --dry-run
 *   node scripts/catalog-backfill.js --dry-run --json
 *   node scripts/catalog-backfill.js --dry-run --company-id <uuid>
 *
 * Commit is disabled in C1C. --commit is refused.
 * Never prints service-role keys, credentials, tokens, or customer PII.
 */

const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const {
  ALLOWED_SAAS_DEV_REF,
  COMMIT_DISABLED_MESSAGE,
  planCatalogBackfill,
  formatCatalogBackfillSummary,
  assertSaasDevelopmentTarget,
  parseCatalogBackfillCliArgs,
} = require("../src/services/catalogBackfill.service");

const PAGE = 500;
const COMPANY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printUsage() {
  console.log(`Catalog backfill (C1C dry-run only)

Usage:
  node scripts/catalog-backfill.js --dry-run [--json] [--company-id <uuid>]

Allowed target: SaaS Development ${ALLOWED_SAAS_DEV_REF}
Commit is disabled in this phase.
`);
}

async function fetchAll(client, table, select, extra = (query) => query) {
  const rows = [];
  let from = 0;
  for (;;) {
    let query = extra(
      client.from(table).select(select).range(from, from + PAGE - 1),
    );
    const { data, error } = await query;
    if (error) {
      throw new Error(`${table}: ${error.message}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function loadSnapshot(client, { companyId } = {}) {
  const scope = (query) =>
    companyId ? query.eq("company_id", companyId) : query;

  const [
    products,
    integrations,
    variants,
    options,
    optionValues,
    sourceMappings,
    bostaMappings,
  ] = await Promise.all([
    fetchAll(
      client,
      "products",
      "id,company_id,source_integration_id,easyorder_id,sku,product_type,raw_data",
      scope,
    ),
    fetchAll(
      client,
      "company_integrations",
      "id,company_id,provider,category,is_enabled",
      scope,
    ),
    fetchAll(
      client,
      "product_variants",
      "id,company_id,product_id,title,internal_sku,barcode,price,compare_at_price,is_default,is_active,position",
      scope,
    ),
    fetchAll(
      client,
      "product_options",
      "id,company_id,product_id,name,position",
      scope,
    ),
    fetchAll(
      client,
      "product_option_values",
      "id,company_id,product_id,option_id,value,position",
      scope,
    ),
    fetchAll(
      client,
      "catalog_source_mappings",
      "id,company_id,integration_id,external_product_id,external_variant_id,internal_product_id,internal_variant_id,external_sku",
      scope,
    ),
    fetchAll(
      client,
      "bosta_sku_mappings",
      "id,company_id,mapping_type,entity_id,catalog_product_id,sizes",
      scope,
    ),
  ]);

  return {
    products,
    integrations,
    existing: {
      variants,
      options,
      optionValues,
      sourceMappings,
    },
    bostaMappings,
  };
}

async function main() {
  const args = parseCatalogBackfillCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.commit) {
    console.error(COMMIT_DISABLED_MESSAGE);
    process.exit(1);
  }

  if (args.companyId && !COMPANY_UUID.test(args.companyId)) {
    console.error("Invalid --company-id; expected a UUID scoped to this tenant.");
    process.exit(1);
  }

  const target = assertSaasDevelopmentTarget(process.env.SUPABASE_URL);
  const supabase = require("../src/config/supabase");
  const snapshot = await loadSnapshot(supabase, {
    companyId: args.companyId || undefined,
  });

  const report = planCatalogBackfill(snapshot);
  report.target = {
    verified: true,
    project_ref: target.project_ref,
  };

  if (args.json) {
    const json = {
      mode: report.mode,
      commit_enabled: report.commit_enabled,
      target: report.target,
      counts: report.counts,
      products: report.products,
    };
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(formatCatalogBackfillSummary(report));
    console.log(`target=${target.project_ref} (verified)`);
  }
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(message);
  process.exit(err && err.code === "TARGET_UNVERIFIED" ? 2 : 1);
});
