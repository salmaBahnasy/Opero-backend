#!/usr/bin/env node
/**
 * C1I-C controlled live catalog RPC smoke.
 * SaaS Development only (iydepmuniwybqgejawhf).
 * NOT an operational endpoint. NOT wired to the API, CLI, or provider sync.
 *
 * Usage: NODE_ENV=development node scripts/catalog-rpc-smoke-c1ic.js
 */

process.env.NODE_ENV = "development";

const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const ALLOWED_HOST = "iydepmuniwybqgejawhf.supabase.co";
const SMOKE_COMPANY_ID = "c214b992-640e-45fb-a0a4-c67edde6da2d";
const SMOKE_NAME = "__CATALOG_RPC_SMOKE_C1I_C__";
const TABLES = [
  "products",
  "product_variants",
  "product_options",
  "product_option_values",
  "variant_option_values",
  "catalog_source_mappings",
];

function fail(message, extra = {}) {
  const error = new Error(message);
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

async function countExact(supabase, table) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) fail(`count failed for ${table}`, { details: error.message, code: error.code });
  return count;
}

async function counts(supabase) {
  const out = {};
  for (const table of TABLES) out[table] = await countExact(supabase, table);
  return out;
}

function sameCounts(a, b) {
  return TABLES.every((table) => a[table] === b[table]);
}

function variantPlan({ action, id, key, title, sku, isDefault }) {
  return {
    action,
    existing_variant_id: id || null,
    company_id: SMOKE_COMPANY_ID,
    variant_key: key,
    title,
    internal_sku: sku,
    barcode: null,
    price: 123.45,
    compare_at_price: null,
    is_default: isDefault,
    is_active: true,
    position: 0,
    raw_data: {},
    option_pairs: [],
  };
}

function reviewedPlan({ productId, variants }) {
  return {
    company_id: SMOKE_COMPANY_ID,
    product_id: productId,
    provider: "manual",
    status: "READY",
    planned_product_type: "simple",
    diagnostics: [],
    integration_id: null,
    variants: variants.map((row) => ({ ...row, product_id: productId, company_id: SMOKE_COMPANY_ID })),
    options: [],
    option_values: [],
    source_mappings: [],
  };
}

async function main() {
  let smokeProductId = null;
  try {
  const host = hostOf(process.env.SUPABASE_URL);
  if (host !== ALLOWED_HOST) {
    fail("TARGET_UNVERIFIED", { host, expected: ALLOWED_HOST });
  }

  const supabase = require("../src/config/supabase");
  const { writeCatalogProductPlan } = require("../src/services/catalogWriter.service");

  const rpcInvocations = [];
  const originalRpc = supabase.rpc.bind(supabase);
  supabase.rpc = (name, args) => {
    rpcInvocations.push({
      name,
      argNames: Object.keys(args || {}).sort(),
    });
    return originalRpc(name, args);
  };

  const company = await supabase
    .from("companies")
    .select("id,name,slug")
    .eq("id", SMOKE_COMPANY_ID)
    .maybeSingle();
  if (company.error) fail("company lookup failed", { details: company.error.message });
  if (!company.data) fail("Phase 5 Demo company was not found");

  let productSchema = null;
  let productPost = null;
  try {
    const specRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/openapi+json",
      },
    });
    const spec = await specRes.json();
    productSchema =
      spec.definitions?.products ||
      spec.components?.schemas?.products ||
      spec.definitions?.product ||
      null;
    productPost =
      spec.paths?.["/products"]?.post?.parameters?.find((item) => item.in === "body")?.schema ||
      null;
  } catch {
    productSchema = null;
    productPost = null;
  }

  const pre = {};
  pre.counts = await counts(supabase);
  const existingProducts = await supabase.from("products").select("id,name,company_id").limit(50);
  if (existingProducts.error) fail("product list failed", { details: existingProducts.error.message });
  pre.product_ids = (existingProducts.data || []).map((row) => row.id);
  pre.products_nonzero = pre.counts.products !== 0;

  const nonexistentId = crypto.randomUUID();
  const probePlan = reviewedPlan({
    productId: nonexistentId,
    variants: [
      variantPlan({
        action: "CREATE",
        key: "smoke-default",
        title: "Default",
        sku: `C1IC-SMOKE-PROBE-${Date.now()}`,
        isDefault: true,
      }),
    ],
  });
  rpcInvocations.length = 0;
  let probeError = null;
  try {
    await writeCatalogProductPlan(probePlan, {
      companyId: SMOKE_COMPANY_ID,
      integrations: [],
    });
  } catch (error) {
    probeError = { code: error.code, message: error.message, sqlState: error.sqlState || null };
  }
  const probeRpcCount = rpcInvocations.length;
  const afterProbe = await counts(supabase);
  if (!probeError || probeError.code !== "CATALOG_PRODUCT_NOT_FOUND") {
    fail("nonexistent probe did not return CATALOG_PRODUCT_NOT_FOUND", { probeError, afterProbe });
  }
  if (!sameCounts(pre.counts, afterProbe)) {
    fail("nonexistent probe mutated catalog counts", { before: pre.counts, after: afterProbe });
  }

  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const smokeSku = `C1IC-SMOKE-${suffix}`;
  const insertPayload = {
    company_id: SMOKE_COMPANY_ID,
    easyorder_id: `__C1IC_SMOKE__${suffix}`,
    name: SMOKE_NAME,
    sku: smokeSku,
    is_active: true,
    raw_data: { catalog_rpc_smoke: true, phase: "C1I-C" },
    source_integration_id: null,
    import_batch_id: null,
    product_type: "simple",
    synced_at: null,
  };
  const inserted = await supabase.from("products").insert(insertPayload).select("*").maybeSingle();
  if (inserted.error) fail("smoke product insert failed", { details: inserted.error.message, code: inserted.error.code });
  const smokeProduct = inserted.data;
  if (!smokeProduct?.id) fail("smoke product insert returned no id");
  smokeProductId = smokeProduct.id;
  if (smokeProduct.name !== SMOKE_NAME) fail("smoke product name mismatch");
  if (smokeProduct.company_id !== SMOKE_COMPANY_ID) fail("smoke product company mismatch");

  const createPlan = reviewedPlan({
    productId: smokeProduct.id,
    variants: [
      variantPlan({
        action: "CREATE",
        key: "smoke-default",
        title: "Default",
        sku: smokeSku,
        isDefault: true,
      }),
    ],
  });
  rpcInvocations.length = 0;
  const createResult = await writeCatalogProductPlan(createPlan, {
    companyId: SMOKE_COMPANY_ID,
    integrations: [],
  });
  const createRpcCount = rpcInvocations.length;

  const productRow = await supabase.from("products").select("*").eq("id", smokeProduct.id).maybeSingle();
  const variants = await supabase.from("product_variants").select("*").eq("product_id", smokeProduct.id);
  const options = await supabase.from("product_options").select("id").eq("product_id", smokeProduct.id);
  const optionValues = await supabase.from("product_option_values").select("id").eq("product_id", smokeProduct.id);
  const links = await supabase.from("variant_option_values").select("id").eq("product_id", smokeProduct.id);
  const mappings = await supabase.from("catalog_source_mappings").select("id").eq("internal_product_id", smokeProduct.id);
  if (productRow.error || variants.error || options.error || optionValues.error || links.error || mappings.error) {
    fail("post-create verification query failed");
  }
  const variantRows = variants.data || [];
  const defaultCount = variantRows.filter((row) => row.is_default === true).length;
  const createdVariant = variantRows[0] || null;

  const reusePlan = reviewedPlan({
    productId: smokeProduct.id,
    variants: [
      variantPlan({
        action: "REUSE",
        id: createdVariant?.id,
        key: "smoke-default",
        title: "Default",
        sku: smokeSku,
        isDefault: true,
      }),
    ],
  });
  rpcInvocations.length = 0;
  const reuseResult = await writeCatalogProductPlan(reusePlan, {
    companyId: SMOKE_COMPANY_ID,
    integrations: [],
  });
  const reuseRpcCount = rpcInvocations.length;
  const variantsAfterReuse = await supabase.from("product_variants").select("id,title,is_default").eq("product_id", smokeProduct.id);
  if (variantsAfterReuse.error) fail("reuse verification query failed");

  let rollback = {
    attempted: false,
    construction: null,
    result: "ROLLBACK_SMOKE_DEFERRED_NO_SAFE_FAILURE_CASE",
    defer_reason: null,
    title_after: null,
  };
  if (createdVariant?.id && smokeSku) {
    rollback.attempted = true;
    rollback.construction =
      "UPDATE existing default variant title to SHOULD_ROLL_BACK, then CREATE a second non-default variant with the same internal_sku to hit unique 23505 after mutation";
    const rollbackPlan = reviewedPlan({
      productId: smokeProduct.id,
      variants: [
        variantPlan({
          action: "UPDATE",
          id: createdVariant.id,
          key: "smoke-default",
          title: "SHOULD_ROLL_BACK",
          sku: smokeSku,
          isDefault: true,
        }),
        variantPlan({
          action: "CREATE",
          key: "smoke-dup",
          title: "Dup",
          sku: smokeSku,
          isDefault: false,
        }),
      ],
    });
    rpcInvocations.length = 0;
    try {
      await writeCatalogProductPlan(rollbackPlan, {
        companyId: SMOKE_COMPANY_ID,
        integrations: [],
      });
      rollback.result = "UNEXPECTED_SUCCESS";
    } catch (error) {
      rollback.result = {
        code: error.code,
        message: error.message,
        sqlState: error.sqlState || null,
        rpc_count: rpcInvocations.length,
      };
    }
    const afterFail = await supabase
      .from("product_variants")
      .select("id,title,is_default,internal_sku")
      .eq("product_id", smokeProduct.id);
    rollback.title_after = (afterFail.data || []).map((row) => ({
      id: row.id,
      title: row.title,
      is_default: row.is_default,
    }));
    rollback.variant_count_after = (afterFail.data || []).length;
    rollback.title_rolled_back = (afterFail.data || []).every((row) => row.title !== "SHOULD_ROLL_BACK");
  } else {
    rollback.defer_reason = "CREATE did not return a variant id/sku for a safe post-mutation unique conflict";
  }

  let cleanup = { attempted: false, result: null };
  const stillThere = await supabase.from("products").select("id,name").eq("id", smokeProduct.id).maybeSingle();
  if (stillThere.data?.id === smokeProduct.id && stillThere.data?.name === SMOKE_NAME) {
    cleanup.attempted = true;
    const deleted = await supabase.from("products").delete().eq("id", smokeProduct.id).eq("name", SMOKE_NAME).select("id").maybeSingle();
    cleanup.result = deleted.error
      ? { ok: false, error: deleted.error.message }
      : { ok: Boolean(deleted.data?.id), id: deleted.data?.id || null };
  }
  const leftoverProduct = await supabase.from("products").select("id").eq("id", smokeProduct.id).maybeSingle();
  const leftoverVariants = await supabase.from("product_variants").select("id").eq("product_id", smokeProduct.id);
  const leftoverOptions = await supabase.from("product_options").select("id").eq("product_id", smokeProduct.id);
  const leftoverValues = await supabase.from("product_option_values").select("id").eq("product_id", smokeProduct.id);
  const leftoverLinks = await supabase.from("variant_option_values").select("id").eq("product_id", smokeProduct.id);
  const leftoverMaps = await supabase.from("catalog_source_mappings").select("id").eq("internal_product_id", smokeProduct.id);
  const finalCounts = await counts(supabase);

  const report = {
    target: { host, match: host === ALLOWED_HOST, company: company.data },
    product_schema_preview: {
      definition_keys: productSchema ? Object.keys(productSchema) : null,
      post_required: productPost?.required || null,
      post_properties: productPost?.properties ? Object.keys(productPost.properties) : null,
    },
    pre_smoke: pre,
    probe: {
      nonexistent_id: nonexistentId,
      error: probeError,
      rpc_count: probeRpcCount,
      counts_after: afterProbe,
      counts_unchanged: sameCounts(pre.counts, afterProbe),
    },
    smoke_product: {
      id: smokeProduct.id,
      company_id: smokeProduct.company_id,
      name: smokeProduct.name,
      sku: smokeProduct.sku,
      easyorder_id: smokeProduct.easyorder_id,
      source_integration_id: smokeProduct.source_integration_id,
      import_batch_id: smokeProduct.import_batch_id,
      product_type: smokeProduct.product_type,
    },
    create: {
      result: createResult,
      rpc_count: createRpcCount,
      product: productRow.data && {
        id: productRow.data.id,
        company_id: productRow.data.company_id,
        product_type: productRow.data.product_type,
        name: productRow.data.name,
        sku: productRow.data.sku,
        source_integration_id: productRow.data.source_integration_id,
        import_batch_id: productRow.data.import_batch_id,
        easyorder_id: productRow.data.easyorder_id,
      },
      variants: variantRows,
      default_count: defaultCount,
      options: (options.data || []).length,
      option_values: (optionValues.data || []).length,
      links: (links.data || []).length,
      mappings: (mappings.data || []).length,
    },
    reuse: {
      result: reuseResult,
      rpc_count: reuseRpcCount,
      variant_ids: (variantsAfterReuse.data || []).map((row) => row.id),
      variant_count: (variantsAfterReuse.data || []).length,
    },
    rollback,
    cleanup,
    leftover: {
      product: leftoverProduct.data?.id || null,
      variants: (leftoverVariants.data || []).length,
      options: (leftoverOptions.data || []).length,
      option_values: (leftoverValues.data || []).length,
      links: (leftoverLinks.data || []).length,
      mappings: (leftoverMaps.data || []).length,
    },
    final_counts: finalCounts,
    baseline_restored: sameCounts(pre.counts, finalCounts),
  };
  console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (smokeProductId) error.smokeProductId = smokeProductId;
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "SMOKE_FAILED",
    message: error.message,
    details: error.details || null,
    retained_smoke_product_id: error.smokeProductId || null,
  }, null, 2));
  process.exit(1);
});
