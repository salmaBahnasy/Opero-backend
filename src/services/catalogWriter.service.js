/**
 * Canonical catalog writer (C1G/C1I-B).
 *
 * Consumes an already-reviewed C1C/C1F planner product plan.
 * Production path: Migration 014 apply_catalog_product_plan via service-role RPC.
 * Tests: injected memory transaction adapter OR injected rpc() mock.
 *
 * Shopify dual-write may call writeCatalogProductPlan behind a backend gate that
 * is OFF by default. Not wired to Salla/EasyOrders/manual/import/CLI --commit.
 * Does not parse Shopify/Salla/EasyOrders/spreadsheet payloads.
 */

const { randomUUID } = require("crypto");

const WRITE_CODE = {
  BLOCKED: "CATALOG_WRITE_BLOCKED",
  ERROR_DIAGNOSTIC: "CATALOG_WRITE_ERROR_DIAGNOSTIC",
  CONFLICT: "CATALOG_WRITE_CONFLICT",
  TENANT_MISMATCH: "CATALOG_WRITE_TENANT_MISMATCH",
  IDENTITY_MISMATCH: "CATALOG_WRITE_IDENTITY_MISMATCH",
  INCOMPLETE_EASYORDERS: "CATALOG_WRITE_INCOMPLETE_EASYORDERS",
  INVALID_PLAN: "CATALOG_WRITE_INVALID_PLAN",
  TRANSACTION_UNAVAILABLE: "CATALOG_WRITE_TRANSACTION_UNAVAILABLE",
  FAILED: "CATALOG_WRITE_FAILED",
  MALFORMED_RPC_RESULT: "CATALOG_WRITE_MALFORMED_RPC_RESULT",
};

const ELIGIBLE_STATUS = new Set(["READY", "READY_WITH_WARNINGS"]);
const ALLOWED_PRODUCT_TYPES = new Set(["simple", "variable"]);
const PLAN_ACTIONS = new Set(["CREATE", "REUSE", "UPDATE", "CONFLICT"]);
const EASYORDERS_INELIGIBLE_CODES = new Set([
  "EASYORDERS_VARIANTS_NOT_STORED",
  "EASYORDERS_VARIANTS_INCOMPLETE",
]);

const CATALOG_TABLES = {
  products: "products",
  variants: "product_variants",
  options: "product_options",
  optionValues: "product_option_values",
  links: "variant_option_values",
  mappings: "catalog_source_mappings",
  integrations: "company_integrations",
};

function catalogWriteError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function sameId(a, b) {
  return String(a || "") === String(b || "");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function diagnosticCodes(plan) {
  return (plan?.diagnostics || []).map((item) => trimText(item?.code)).filter(Boolean);
}

function collectActions(plan) {
  return [
    ...(plan.variants || []),
    ...(plan.options || []),
    ...(plan.option_values || []),
    ...(plan.source_mappings || []),
  ];
}

function assertTransactionAdapter(tx) {
  if (
    !tx ||
    typeof tx.begin !== "function" ||
    typeof tx.commit !== "function" ||
    typeof tx.rollback !== "function" ||
    typeof tx.select !== "function" ||
    typeof tx.insert !== "function" ||
    typeof tx.update !== "function"
  ) {
    throw catalogWriteError(
      WRITE_CODE.TRANSACTION_UNAVAILABLE,
      "Canonical catalog writes require a real per-product transaction adapter. Supabase JS REST calls are not atomic.",
    );
  }
}

/**
 * Live REST client cannot provide BEGIN/COMMIT around product_type + variants +
 * options + values + links + mappings. Do not emulate that with unordered writes.
 */
function createSupabaseRestCatalogTransaction() {
    throw catalogWriteError(
      WRITE_CODE.TRANSACTION_UNAVAILABLE,
      "Canonical catalog writes require public.apply_catalog_product_plan (Migration 014). Sequential Supabase REST writes are not atomic. This live adapter is not connected.",
    );
}

function assertWriteEligible(plan, { companyId } = {}) {
  if (!plan || typeof plan !== "object") {
    throw catalogWriteError(WRITE_CODE.INVALID_PLAN, "Catalog writer requires a planner product plan");
  }
  const expectedCompanyId = trimText(companyId);
  if (!expectedCompanyId) {
    throw catalogWriteError(
      WRITE_CODE.TENANT_MISMATCH,
      "Catalog writer requires server-side company_id; never trust a request body tenant",
    );
  }
  if (!trimText(plan.product_id)) {
    throw catalogWriteError(WRITE_CODE.INVALID_PLAN, "Planner plan is missing product_id");
  }
  if (!sameId(plan.company_id, expectedCompanyId)) {
    throw catalogWriteError(
      WRITE_CODE.TENANT_MISMATCH,
      "Plan company_id does not match writer company context",
      { plan_company_id: plan.company_id, company_id: expectedCompanyId },
    );
  }

  const codes = diagnosticCodes(plan);
  const provider = trimText(plan.provider).toLowerCase();
  const blankExternalVariant = (plan.variants || []).some(
    (variant) => !trimText(variant.external_variant_id),
  );
  const blankMappingVariant = (plan.source_mappings || []).some(
    (mapping) => mapping.external_variant_id === "",
  );
  if (provider === "easyorders") {
    const ineligibleCode = codes.find((code) => EASYORDERS_INELIGIBLE_CODES.has(code));
    if (ineligibleCode || blankExternalVariant || blankMappingVariant) {
      throw catalogWriteError(
        WRITE_CODE.INCOMPLETE_EASYORDERS,
        "EasyOrders canonical writes require a trusted complete enriched snapshot or real stored variants with stable ids",
        { product_id: plan.product_id, diagnostic: ineligibleCode || "BLANK_EXTERNAL_VARIANT_ID" },
      );
    }
  }

  if (!ELIGIBLE_STATUS.has(plan.status)) {
    throw catalogWriteError(
      WRITE_CODE.BLOCKED,
      "Blocked catalog plan cannot be written",
      { product_id: plan.product_id, status: plan.status },
    );
  }
  const diagnostics = plan.diagnostics || [];
  const errorDiagnostic = diagnostics.find((item) => trimText(item?.severity) === "ERROR");
  if (errorDiagnostic) {
    throw catalogWriteError(
      WRITE_CODE.ERROR_DIAGNOSTIC,
      "Catalog plan contains ERROR diagnostics and cannot be written",
      { product_id: plan.product_id, diagnostic: errorDiagnostic.code },
    );
  }
  const conflictOp = collectActions(plan).find((row) => row?.action === "CONFLICT");
  if (conflictOp) {
    throw catalogWriteError(
      WRITE_CODE.CONFLICT,
      "Catalog plan has an unresolved CONFLICT operation",
      { product_id: plan.product_id },
    );
  }
  for (const row of collectActions(plan)) {
    if (row?.action && !PLAN_ACTIONS.has(row.action)) {
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        `Unsupported planner action ${row.action}`,
      );
    }
    if (row?.company_id && !sameId(row.company_id, expectedCompanyId)) {
      throw catalogWriteError(
        WRITE_CODE.TENANT_MISMATCH,
        "Planner operation company_id does not match writer company context",
      );
    }
    if (row?.product_id && !sameId(row.product_id, plan.product_id)) {
      throw catalogWriteError(
        WRITE_CODE.IDENTITY_MISMATCH,
        "Planner operation product_id does not match plan product_id",
      );
    }
  }

  if (!ALLOWED_PRODUCT_TYPES.has(plan.planned_product_type)) {
    throw catalogWriteError(
      WRITE_CODE.INVALID_PLAN,
      "Writer only persists planned product_type simple|variable; never infers bundle",
      { planned_product_type: plan.planned_product_type },
    );
  }
  if (!(plan.variants || []).length) {
    throw catalogWriteError(
      WRITE_CODE.INVALID_PLAN,
      "Eligible catalog plan must include at least one variant operation",
    );
  }
  const plannedDefaults = (plan.variants || []).filter((row) => row.is_default);
  if (plannedDefaults.length !== 1) {
    throw catalogWriteError(
      WRITE_CODE.CONFLICT,
      "Plan must nominate exactly one default variant",
    );
  }
}

function assertIntegrationOwnership(plan, { companyId, integrations } = {}) {
  const expectedCompanyId = trimText(companyId);
  const list = Array.isArray(integrations) ? integrations : [];
  const needed = new Set();
  if (trimText(plan?.integration_id)) needed.add(String(plan.integration_id));
  for (const mapping of plan?.source_mappings || []) {
    const integrationId = trimText(mapping?.integration_id);
    if (!integrationId) {
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        "Source mapping is missing integration_id",
      );
    }
    needed.add(integrationId);
  }
  for (const integrationId of needed) {
    const row = list.find((item) => sameId(item?.id, integrationId));
    if (!row) {
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        "Plan integration_id was not found in writer context",
        { integration_id: integrationId },
      );
    }
    requireRowCompany(row, expectedCompanyId, "company_integrations");
  }
}

function requireRowCompany(row, companyId, label) {
  if (!row) {
    throw catalogWriteError(WRITE_CODE.INVALID_PLAN, `Missing ${label} for catalog write`);
  }
  if (!sameId(row.company_id, companyId)) {
    throw catalogWriteError(
      WRITE_CODE.TENANT_MISMATCH,
      `${label} company_id does not match writer company context`,
      { label, row_company_id: row.company_id, company_id: companyId },
    );
  }
}

function variantMutableFields(planned) {
  return {
    title: planned.title ?? null,
    is_default: Boolean(planned.is_default),
    is_active: planned.is_active == null ? true : Boolean(planned.is_active),
    position: Number(planned.position || 0),
    internal_sku: planned.internal_sku ?? null,
    barcode: planned.barcode ?? null,
    price: planned.price ?? null,
    compare_at_price: planned.compare_at_price ?? null,
    raw_data: asObject(planned.raw_data) || {},
  };
}

function mappingIdentityKey(companyId, integrationId, externalProductId, externalVariantId) {
  return `${companyId}::${integrationId}::${externalProductId}::${externalVariantId ?? ""}`;
}

function setValueId(map, optionName, value, id) {
  if (!map.has(optionName)) map.set(optionName, new Map());
  map.get(optionName).set(value, id);
}

function getValueId(map, optionName, value) {
  return map.get(optionName)?.get(value);
}

async function loadOne(tx, table, filters) {
  const rows = await tx.select(table, filters);
  return rows[0] || null;
}

async function assertExistingOwned(tx, table, id, companyId, extra = {}, label = table) {
  if (!id) return null;
  const row = await loadOne(tx, table, { id, company_id: companyId, ...extra });
  if (!row) {
    const any = await loadOne(tx, table, { id });
    if (any && !sameId(any.company_id, companyId)) {
      throw catalogWriteError(
        WRITE_CODE.TENANT_MISMATCH,
        `${label} belongs to another company`,
      );
    }
    throw catalogWriteError(WRITE_CODE.INVALID_PLAN, `${label} referenced by plan was not found`);
  }
  requireRowCompany(row, companyId, label);
  return row;
}

async function clearCurrentDefaults(tx, { companyId, productId }) {
  const existing = await tx.select(CATALOG_TABLES.variants, {
    company_id: companyId,
    product_id: productId,
  });
  for (const row of existing) {
    if (!row.is_default) continue;
    await tx.update(
      CATALOG_TABLES.variants,
      row.id,
      { is_default: false },
      companyId,
    );
  }
}

async function applyVariants(tx, plan, { companyId, productId }) {
  const plannedDefaults = (plan.variants || []).filter((row) => row.is_default);
  if (plannedDefaults.length !== 1) {
    throw catalogWriteError(
      WRITE_CODE.CONFLICT,
      "Plan must nominate exactly one default variant",
    );
  }
  await clearCurrentDefaults(tx, { companyId, productId });

  const variantIdByKey = new Map();
  const created = [];
  const reused = [];
  const updated = [];

  for (const planned of plan.variants || []) {
    if (!trimText(planned.variant_key)) {
      throw catalogWriteError(WRITE_CODE.INVALID_PLAN, "Variant operation is missing variant_key");
    }
    requireRowCompany(planned, companyId, "planned variant");
    if (!sameId(planned.product_id, productId)) {
      throw catalogWriteError(
        WRITE_CODE.IDENTITY_MISMATCH,
        "Variant cannot move between products",
      );
    }
    const fields = variantMutableFields(planned);
    if (planned.action === "CREATE") {
      const row = await tx.insert(CATALOG_TABLES.variants, {
        id: randomUUID(),
        company_id: companyId,
        product_id: productId,
        is_active: true,
        ...fields,
      });
      variantIdByKey.set(planned.variant_key, row.id);
      created.push(row);
      continue;
    }

    const existing = await assertExistingOwned(
      tx,
      CATALOG_TABLES.variants,
      planned.existing_variant_id,
      companyId,
      { product_id: productId },
      "product_variants",
    );
    if (!sameId(existing.product_id, productId)) {
      throw catalogWriteError(
        WRITE_CODE.IDENTITY_MISMATCH,
        "Existing variant belongs to a different product",
      );
    }
    variantIdByKey.set(planned.variant_key, existing.id);
    if (planned.action === "UPDATE") {
      const row = await tx.update(
        CATALOG_TABLES.variants,
        existing.id,
        fields,
        companyId,
      );
      updated.push(row);
    } else {
      const row = await tx.update(
        CATALOG_TABLES.variants,
        existing.id,
        { is_default: Boolean(planned.is_default) },
        companyId,
      );
      reused.push(row);
    }
  }
  return { variantIdByKey, created, reused, updated };
}

async function applyOptions(tx, plan, { companyId, productId }) {
  const optionIdByName = new Map();
  const created = [];
  const reused = [];
  for (const planned of plan.options || []) {
    requireRowCompany(planned, companyId, "planned option");
    if (planned.action === "CREATE") {
      const row = await tx.insert(CATALOG_TABLES.options, {
        id: randomUUID(),
        company_id: companyId,
        product_id: productId,
        name: planned.name,
        position: Number(planned.position || 0),
      });
      optionIdByName.set(planned.name, row.id);
      created.push(row);
      continue;
    }
    const existing = await assertExistingOwned(
      tx,
      CATALOG_TABLES.options,
      planned.existing_option_id,
      companyId,
      { product_id: productId },
      "product_options",
    );
    optionIdByName.set(planned.name, existing.id);
    reused.push(existing);
  }
  return { optionIdByName, created, reused };
}

async function applyOptionValues(tx, plan, { companyId, productId, optionIdByName }) {
  const valueIdByKey = new Map();
  const created = [];
  const reused = [];
  for (const planned of plan.option_values || []) {
    requireRowCompany(planned, companyId, "planned option value");
    const optionId = optionIdByName.get(planned.option_name);
    if (!optionId) {
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        "Option value references an option that was not written",
        { option_name: planned.option_name },
      );
    }
    if (planned.action === "CREATE") {
      const row = await tx.insert(CATALOG_TABLES.optionValues, {
        id: randomUUID(),
        company_id: companyId,
        product_id: productId,
        option_id: optionId,
        value: planned.value,
        position: Number(planned.position || 0),
      });
      setValueId(valueIdByKey, planned.option_name, planned.value, row.id);
      created.push(row);
      continue;
    }
    const existing = await assertExistingOwned(
      tx,
      CATALOG_TABLES.optionValues,
      planned.existing_option_value_id,
      companyId,
      { product_id: productId, option_id: optionId },
      "product_option_values",
    );
    setValueId(valueIdByKey, planned.option_name, planned.value, existing.id);
    reused.push(existing);
  }
  return { valueIdByKey, created, reused };
}

async function applyVariantOptionLinks(
  tx,
  plan,
  { companyId, productId, variantIdByKey, optionIdByName, valueIdByKey },
) {
  const created = [];
  const reused = [];
  for (const planned of plan.variants || []) {
    const variantId = variantIdByKey.get(planned.variant_key);
    const pairs = Array.isArray(planned.option_pairs) ? planned.option_pairs : [];
    for (const pair of pairs) {
      const name = trimText(pair?.name);
      const value = trimText(pair?.value);
      if (!name || !value) continue;
      const optionId = optionIdByName.get(name);
      const optionValueId = getValueId(valueIdByKey, name, value);
      if (!optionId || !optionValueId) {
        throw catalogWriteError(
          WRITE_CODE.INVALID_PLAN,
          "Variant option pair was not resolved to internal option/value UUIDs",
          { name, value },
        );
      }
      const existing = (await tx.select(CATALOG_TABLES.links, {
        company_id: companyId,
        variant_id: variantId,
        option_id: optionId,
      }))[0];
      if (existing) {
        if (!sameId(existing.option_value_id, optionValueId)) {
          throw catalogWriteError(
            WRITE_CODE.CONFLICT,
            "Existing variant-option link points to a different option value",
          );
        }
        reused.push(existing);
        continue;
      }
      const row = await tx.insert(CATALOG_TABLES.links, {
        id: randomUUID(),
        company_id: companyId,
        product_id: productId,
        variant_id: variantId,
        option_id: optionId,
        option_value_id: optionValueId,
      });
      created.push(row);
    }
  }
  return { created, reused };
}

async function applySourceMappings(tx, plan, { companyId, productId, variantIdByKey, integration }) {
  const created = [];
  const reused = [];
  const updated = [];
  if (!(plan.source_mappings || []).length) {
    return { created, reused, updated };
  }
  requireRowCompany(integration, companyId, "company_integrations");
  if (!sameId(integration.id, plan.integration_id)) {
    throw catalogWriteError(
      WRITE_CODE.IDENTITY_MISMATCH,
      "Source mapping integration UUID does not match plan.integration_id",
    );
  }

  for (const planned of plan.source_mappings || []) {
    requireRowCompany(planned, companyId, "planned source mapping");
    if (!sameId(planned.integration_id, integration.id)) {
      throw catalogWriteError(
        WRITE_CODE.IDENTITY_MISMATCH,
        "Source mapping must use the exact company_integrations UUID, never provider name",
      );
    }
    if (!trimText(planned.external_product_id)) {
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        "Source mapping is missing external_product_id",
      );
    }
    const variantId = variantIdByKey.get(planned.variant_key);
    if (!variantId) {
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        "Source mapping variant_key was not resolved to an internal variant UUID",
      );
    }
    const identity = {
      company_id: companyId,
      integration_id: integration.id,
      external_product_id: planned.external_product_id,
      external_variant_id: planned.external_variant_id ?? "",
    };
    const existing = (await tx.select(CATALOG_TABLES.mappings, identity))[0];

    if (existing) {
      if (planned.action === "CREATE") {
        throw catalogWriteError(
          WRITE_CODE.CONFLICT,
          "CREATE mapping identity already exists",
        );
      }
      if (
        !sameId(existing.internal_product_id, productId) ||
        !sameId(existing.internal_variant_id, variantId)
      ) {
        throw catalogWriteError(
          WRITE_CODE.CONFLICT,
          "Existing source mapping points to a different internal product/variant",
          {
            identity: mappingIdentityKey(
              companyId,
              integration.id,
              planned.external_product_id,
              planned.external_variant_id,
            ),
          },
        );
      }
      if (
        planned.action === "UPDATE" ||
        trimText(existing.external_sku) !== trimText(planned.external_sku) ||
        JSON.stringify(existing.metadata || {}) !== JSON.stringify(asObject(planned.metadata) || {})
      ) {
        const row = await tx.update(
          CATALOG_TABLES.mappings,
          existing.id,
          {
            external_sku: planned.external_sku ?? null,
            metadata: asObject(planned.metadata) || {},
          },
          companyId,
        );
        updated.push(row);
      } else {
        reused.push(existing);
      }
      continue;
    }

    if (planned.action === "REUSE" || planned.action === "UPDATE") {
      throw catalogWriteError(
        WRITE_CODE.CONFLICT,
        "REUSE/UPDATE mapping identity was not found",
      );
    }

    const row = await tx.insert(CATALOG_TABLES.mappings, {
      id: randomUUID(),
      ...identity,
      internal_product_id: productId,
      internal_variant_id: variantId,
      external_sku: planned.external_sku ?? null,
      metadata: asObject(planned.metadata) || {},
    });
    created.push(row);
  }
  return { created, reused, updated };
}

async function executePlan(tx, plan, { companyId, integrations }) {
  const productId = plan.product_id;
  const product = await loadOne(tx, CATALOG_TABLES.products, {
    id: productId,
    company_id: companyId,
  });
  if (!product) {
    const other = await loadOne(tx, CATALOG_TABLES.products, { id: productId });
    if (other) {
      throw catalogWriteError(
        WRITE_CODE.TENANT_MISMATCH,
        "Product company_id does not match writer company context",
      );
    }
    throw catalogWriteError(WRITE_CODE.INVALID_PLAN, "Product row was not found for catalog write");
  }
  requireRowCompany(product, companyId, "products");

  let integration = null;
  if (plan.integration_id) {
    integration = (integrations || []).find((row) => sameId(row.id, plan.integration_id)) || null;
    if (!integration) {
      integration = await loadOne(tx, CATALOG_TABLES.integrations, {
        id: plan.integration_id,
        company_id: companyId,
      });
    }
    if (!integration) {
      const other = await loadOne(tx, CATALOG_TABLES.integrations, { id: plan.integration_id });
      if (other) {
        throw catalogWriteError(
          WRITE_CODE.TENANT_MISMATCH,
          "Source integration belongs to another company",
        );
      }
      throw catalogWriteError(
        WRITE_CODE.INVALID_PLAN,
        "Plan integration_id was not found in writer context",
      );
    }
    requireRowCompany(integration, companyId, "company_integrations");
  }

  const variants = await applyVariants(tx, plan, { companyId, productId });
  const options = await applyOptions(tx, plan, { companyId, productId });
  const optionValues = await applyOptionValues(tx, plan, {
    companyId,
    productId,
    optionIdByName: options.optionIdByName,
  });
  const links = await applyVariantOptionLinks(tx, plan, {
    companyId,
    productId,
    variantIdByKey: variants.variantIdByKey,
    optionIdByName: options.optionIdByName,
    valueIdByKey: optionValues.valueIdByKey,
  });
  const mappings = await applySourceMappings(tx, plan, {
    companyId,
    productId,
    variantIdByKey: variants.variantIdByKey,
    integration,
  });

  let productTypeUpdated = false;
  if (product.product_type !== plan.planned_product_type) {
    await tx.update(
      CATALOG_TABLES.products,
      productId,
      { product_type: plan.planned_product_type },
      companyId,
    );
    productTypeUpdated = true;
  }

  const writtenProduct = await loadOne(tx, CATALOG_TABLES.products, {
    id: productId,
    company_id: companyId,
  });
  return {
    product_id: writtenProduct.id,
    company_id: writtenProduct.company_id,
    product_type: writtenProduct.product_type,
    product_type_updated: productTypeUpdated,
    variant_ids: [...variants.variantIdByKey.values()],
    created: {
      variants: variants.created.length,
      options: options.created.length,
      option_values: optionValues.created.length,
      variant_option_values: links.created.length,
      source_mappings: mappings.created.length,
    },
    reused: {
      variants: variants.reused.length,
      options: options.reused.length,
      option_values: optionValues.reused.length,
      variant_option_values: links.reused.length,
      source_mappings: mappings.reused.length,
    },
    updated: {
      variants: variants.updated.length,
      source_mappings: mappings.updated.length,
    },
  };
}

async function writeCatalogProductPlan(plan, context = {}) {
  const companyId = trimText(context.companyId);
  assertWriteEligible(plan, { companyId });
  if (context.tx) {
    assertTransactionAdapter(context.tx);
    await context.tx.begin();
    try {
      const result = await executePlan(context.tx, plan, {
        companyId,
        integrations: context.integrations || [],
      });
      await context.tx.commit();
      return {
        ...result,
        productId: result.product_id,
        productType: result.product_type,
        variantIds: result.variant_ids,
      };
    } catch (error) {
      try {
        await context.tx.rollback();
      } catch {
        // rollback failure must not mask the original write error
      }
      if (error && error.code && String(error.code).startsWith("CATALOG_WRITE_")) {
        throw error;
      }
      throw catalogWriteError(
        WRITE_CODE.FAILED,
        error?.message || "Canonical catalog write failed",
        { cause: error },
      );
    }
  }

  assertIntegrationOwnership(plan, {
    companyId,
    integrations: context.integrations || [],
  });
  const { applyCatalogProductPlanViaRpc } = require("./catalogWriteRpc");
  return applyCatalogProductPlanViaRpc(plan, {
    companyId,
    integrations: context.integrations || [],
    rpc: context.rpc,
  });
}

async function writeCatalogProductPlans(plans, context = {}) {
  const results = [];
  for (const plan of plans || []) {
    try {
      results.push({
        ok: true,
        product_id: plan.product_id,
        result: await writeCatalogProductPlan(plan, context),
      });
    } catch (error) {
      results.push({
        ok: false,
        product_id: plan?.product_id || null,
        error,
      });
    }
  }
  return results;
}

module.exports = {
  WRITE_CODE,
  CATALOG_TABLES,
  assertWriteEligible,
  assertIntegrationOwnership,
  createSupabaseRestCatalogTransaction,
  writeCatalogProductPlan,
  writeCatalogProductPlans,
};
