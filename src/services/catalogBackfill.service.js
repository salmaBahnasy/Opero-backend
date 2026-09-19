/**
 * Catalog backfill planner (C1C).
 * Pure: no database writes, no provider API calls.
 * Commit execution is intentionally not implemented here.
 */

const ALLOWED_SAAS_DEV_REF = "iydepmuniwybqgejawhf";
const ALLOWED_SAAS_DEV_HOST = `${ALLOWED_SAAS_DEV_REF}.supabase.co`;

const SEVERITY = {
  ERROR: "ERROR",
  WARNING: "WARNING",
  INFO: "INFO",
};

const STATUS = {
  READY: "READY",
  READY_WITH_WARNINGS: "READY_WITH_WARNINGS",
  BLOCKED: "BLOCKED",
};

const ACTION = {
  CREATE: "CREATE",
  REUSE: "REUSE",
  UPDATE: "UPDATE",
  CONFLICT: "CONFLICT",
};

const COMMIT_DISABLED_MESSAGE =
  "C1C catalog backfill commit is disabled. Dry-run only. C1D must enable commit after review.";

const SHOPIFY_SKIP_OPTION_NAME = "Title";
const SHOPIFY_SKIP_OPTION_VALUE = "Default Title";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseRawData(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asObject(parsed) || {};
    } catch {
      return {};
    }
  }
  return asObject(value) || {};
}

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function diagnostic(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function parseCatalogPrice(value) {
  if (value == null || value === "") {
    return { ok: false, missing: true, value: null };
  }
  if (typeof value === "object") {
    return parseCatalogPrice(value.amount ?? value.value ?? value.price);
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, missing: false, value: null };
  }
  const rounded = Math.round(n * 100) / 100;
  if (!Number.isFinite(rounded)) {
    return { ok: false, missing: false, value: null };
  }
  return { ok: true, missing: false, value: rounded };
}

function pricesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Number(a) === Number(b);
}

function isShopifyDefaultTitleOption(name, value) {
  return name === SHOPIFY_SKIP_OPTION_NAME && value === SHOPIFY_SKIP_OPTION_VALUE;
}

function optionSourceMalformed(variant) {
  const selected = variant?.selected_options;
  const props = variant?.variation_props;
  if (selected != null && !Array.isArray(selected)) return true;
  if (props != null && !Array.isArray(props)) return true;
  const entries = [
    ...(Array.isArray(selected) ? selected : []),
    ...(Array.isArray(props) ? props : []),
  ];
  return entries.some((entry) => entry != null && typeof entry !== "object");
}

function extractOptionPairs(variant) {
  const pairs = [];
  const selected = Array.isArray(variant?.selected_options)
    ? variant.selected_options
    : [];
  for (const option of selected) {
    if (!option || typeof option !== "object") continue;
    pairs.push({
      name: trimText(option?.name ?? option?.option),
      value: trimText(option?.value ?? option?.variation_prop),
    });
  }
  if (pairs.length) return pairs;

  const props = Array.isArray(variant?.variation_props)
    ? variant.variation_props
    : [];
  for (const prop of props) {
    if (!prop || typeof prop !== "object") continue;
    pairs.push({
      name: trimText(prop?.variation ?? prop?.name),
      value: trimText(prop?.variation_prop ?? prop?.value),
    });
  }
  return pairs;
}

function normalizeOptionPairs(pairs, { skipShopifyDefaultTitle = false } = {}) {
  const options = [];
  const seenNames = new Map();
  const droppedEmpty = [];
  const malformed = [];

  for (const raw of pairs || []) {
    if (!raw || typeof raw !== "object") {
      malformed.push(raw);
      continue;
    }
    const name = trimText(raw.name);
    const value = trimText(raw.value);
    if (!name || !value) {
      droppedEmpty.push({ name, value });
      continue;
    }
    if (skipShopifyDefaultTitle && isShopifyDefaultTitleOption(name, value)) {
      continue;
    }
    let option = seenNames.get(name);
    if (!option) {
      option = { name, position: options.length, values: [], valueSet: new Map() };
      seenNames.set(name, option);
      options.push(option);
    }
    if (!option.valueSet.has(value)) {
      option.valueSet.set(value, { value, position: option.values.length });
      option.values.push(option.valueSet.get(value));
    }
  }

  return {
    options: options.map((option) => ({
      name: option.name,
      position: option.position,
      values: option.values.map((entry) => ({
        value: entry.value,
        position: entry.position,
      })),
    })),
    droppedEmpty,
    malformed,
  };
}

function storedVariants(raw) {
  if (!Object.prototype.hasOwnProperty.call(raw, "variants")) {
    return { present: false, malformed: false, items: [] };
  }
  if (!Array.isArray(raw.variants)) {
    return { present: true, malformed: true, items: [] };
  }
  return { present: true, malformed: false, items: raw.variants };
}

function stableVariantId(variant) {
  const direct = trimText(
    variant?.id ??
      variant?.variant_id ??
      variant?.variantId ??
      variant?.sku_id ??
      variant?.salla?.sku_id,
  );
  return direct;
}

function variantSku(variant) {
  return trimText(variant?.sku) || "";
}

function variantBarcode(variant, provider) {
  if (provider === "shopify") return "";
  const salla = trimText(variant?.salla?.barcode);
  if (salla) return salla;
  return trimText(variant?.barcode);
}

function sallaIsDefault(variant) {
  return Boolean(variant?.salla?.is_default || variant?.is_default);
}

function resolveProvider(product, integrationById) {
  const sourceId = trimText(product.source_integration_id);
  if (!sourceId) {
    return { provider: "manual", integration: null, orphan: false };
  }
  const integration = integrationById.get(sourceId) || null;
  if (!integration) {
    return { provider: "unknown", integration: null, orphan: true };
  }
  if (String(integration.company_id) !== String(product.company_id)) {
    return { provider: trimText(integration.provider) || "unknown", integration, orphan: true };
  }
  return {
    provider: trimText(integration.provider).toLowerCase() || "unknown",
    integration,
    orphan: false,
  };
}

function existingIndex(existing = {}) {
  const variants = existing.variants || [];
  const options = existing.options || [];
  const optionValues = existing.optionValues || existing.option_values || [];
  const mappings = existing.sourceMappings || existing.source_mappings || [];

  const mappingByIdentity = new Map();
  for (const row of mappings) {
    const key = [
      row.company_id,
      row.integration_id,
      row.external_product_id,
      row.external_variant_id ?? "",
    ].join("::");
    mappingByIdentity.set(key, row);
  }

  const variantById = new Map(variants.map((row) => [String(row.id), row]));
  const defaultByProduct = new Map();
  for (const row of variants) {
    if (row.is_default) {
      const key = `${row.company_id}::${row.product_id}`;
      if (!defaultByProduct.has(key)) defaultByProduct.set(key, row);
    }
  }

  const optionByName = new Map();
  for (const row of options) {
    optionByName.set(`${row.company_id}::${row.product_id}::${row.name}`, row);
  }

  const valueByOptionValue = new Map();
  for (const row of optionValues) {
    valueByOptionValue.set(
      `${row.company_id}::${row.option_id}::${row.value}`,
      row,
    );
  }

  return {
    mappingByIdentity,
    variantById,
    defaultByProduct,
    optionByName,
    valueByOptionValue,
  };
}

function mappingIdentityKey(companyId, integrationId, externalProductId, externalVariantId) {
  return `${companyId}::${integrationId}::${externalProductId}::${externalVariantId ?? ""}`;
}

function variantKey({ productId, integrationId, externalProductId, externalVariantId, manual }) {
  if (manual) return `manual:${productId}:default`;
  return `source:${integrationId}:${externalProductId}:${externalVariantId ?? ""}`;
}

function decideAction(existingRow, plannedFields) {
  if (!existingRow) return ACTION.CREATE;
  const same =
    pricesEqual(existingRow.price, plannedFields.price) &&
    pricesEqual(existingRow.compare_at_price, plannedFields.compare_at_price) &&
    trimText(existingRow.internal_sku) === trimText(plannedFields.internal_sku) &&
    trimText(existingRow.barcode) === trimText(plannedFields.barcode) &&
    trimText(existingRow.title) === trimText(plannedFields.title) &&
    Boolean(existingRow.is_default) === Boolean(plannedFields.is_default) &&
    Number(existingRow.position || 0) === Number(plannedFields.position || 0);
  return same ? ACTION.REUSE : ACTION.UPDATE;
}

function productStatus(diagnostics) {
  if (diagnostics.some((item) => item.severity === SEVERITY.ERROR)) return STATUS.BLOCKED;
  if (diagnostics.some((item) => item.severity === SEVERITY.WARNING)) {
    return STATUS.READY_WITH_WARNINGS;
  }
  return STATUS.READY;
}

function mergeOccupancyCounts(target, extra) {
  if (!extra) return target;
  const entries =
    extra instanceof Map
      ? extra.entries()
      : typeof extra === "object"
        ? Object.entries(extra)
        : [];
  for (const [key, value] of entries) {
    const count = Number(value) || 0;
    if (!key || count <= 0) continue;
    target.set(key, (target.get(key) || 0) + count);
  }
  return target;
}

function collectCandidateSkusAndBarcodes(products, integrationById) {
  const skuCounts = new Map();
  const barcodeCounts = new Map();

  function bump(map, companyId, value) {
    const text = trimText(value);
    if (!text) return;
    const key = `${companyId}::${text}`;
    map.set(key, (map.get(key) || 0) + 1);
  }

  for (const product of products) {
    const companyId = product.company_id;
    const { provider } = resolveProvider(product, integrationById);
    const raw = parseRawData(product.raw_data);
    const variants = storedVariants(raw);

    if (variants.present && !variants.malformed && variants.items.length) {
      for (const variant of variants.items) {
        bump(skuCounts, companyId, variantSku(variant));
        bump(barcodeCounts, companyId, variantBarcode(variant, provider));
      }
      continue;
    }

    bump(skuCounts, companyId, product.sku);
    bump(
      barcodeCounts,
      companyId,
      provider === "shopify" ? "" : trimText(raw.barcode ?? product.barcode),
    );
  }

  return { skuCounts, barcodeCounts };
}

function assignUnique(map, companyId, candidate) {
  const text = trimText(candidate);
  if (!text) return { value: null, duplicate: false, missing: true };
  const count = map.get(`${companyId}::${text}`) || 0;
  if (count > 1) return { value: null, duplicate: true, missing: false };
  return { value: text, duplicate: false, missing: false };
}

function normalizeSizeKey(value) {
  const raw = trimText(value);
  if (!raw) return "";
  const digits = raw.match(/\d+/);
  return digits ? digits[0] : raw;
}

function planProduct(product, ctx) {
  const diagnostics = [];
  const raw = parseRawData(product.raw_data);
  const planning = asObject(product.planning) || {};
  const enrichmentAttempted = planning.enrichmentAttempted === true;
  const enrichmentIncomplete =
    enrichmentAttempted && planning.variantsComplete !== true;
  const { provider, integration, orphan } = resolveProvider(
    product,
    ctx.integrationById,
  );
  const companyId = product.company_id;
  const productId = product.id;
  const externalProductId = trimText(product.easyorder_id);
  const sourceId = trimText(product.source_integration_id);
  const variantsInfo = storedVariants(raw);
  const truncated = Boolean(raw?.shopify?.variants_truncated);

  if (orphan) {
    diagnostics.push(
      diagnostic(
        "ORPHAN_SOURCE_INTEGRATION",
        SEVERITY.ERROR,
        "source_integration_id is missing, deleted, or belongs to another company",
      ),
    );
  }

  if (variantsInfo.malformed) {
    diagnostics.push(
      diagnostic(
        "MALFORMED_VARIANTS",
        SEVERITY.ERROR,
        "raw_data.variants exists but is not an array",
      ),
    );
  }

  if (truncated) {
    diagnostics.push(
      diagnostic(
        "TRUNCATED_PROVIDER_VARIANTS",
        SEVERITY.ERROR,
        "Shopify variant list is truncated; identity cannot be trusted for full backfill",
      ),
    );
  }

  const sellable = [];
  if (!variantsInfo.malformed && variantsInfo.items.length) {
    const seenIds = new Map();
    variantsInfo.items.forEach((variant, index) => {
      if (!variant || typeof variant !== "object") {
        diagnostics.push(
          diagnostic(
            "MALFORMED_VARIANTS",
            SEVERITY.ERROR,
            "A stored variant entry is not an object",
            { index },
          ),
        );
        return;
      }
      const externalVariantId = stableVariantId(variant);
      if (!externalVariantId) {
        if (provider === "shopify" || provider === "salla") {
          diagnostics.push(
            diagnostic(
              "MISSING_EXTERNAL_VARIANT_ID",
              SEVERITY.ERROR,
              "Provider variant is missing a stable external id",
              { index },
            ),
          );
          return;
        }
      }
      if (externalVariantId) {
        const prev = seenIds.get(externalVariantId);
        if (prev != null) {
          diagnostics.push(
            diagnostic(
              "DUPLICATE_EXTERNAL_IDENTITY",
              SEVERITY.ERROR,
              "Duplicate provider variant id on the same product",
              { external_variant_id: externalVariantId },
            ),
          );
          return;
        }
        seenIds.set(externalVariantId, index);
      }
      sellable.push({ variant, index, externalVariantId: externalVariantId || "" });
    });
  }

  const useStoredVariants = sellable.length > 0;
  if (enrichmentIncomplete) {
    diagnostics.push(
      diagnostic(
        "EASYORDERS_VARIANTS_INCOMPLETE",
        SEVERITY.ERROR,
        "EasyOrders enrichment was attempted but variants are incomplete; canonical planning is blocked",
      ),
    );
  } else if (
    provider === "easyorders" &&
    sourceId &&
    !useStoredVariants &&
    !variantsInfo.malformed
  ) {
    diagnostics.push(
      diagnostic(
        "EASYORDERS_VARIANTS_NOT_STORED",
        SEVERITY.WARNING,
        "No stored EasyOrders variants; planned from product row only. Remote variants may exist.",
      ),
    );
  }

  const plannedVariants = [];
  const skipShopifyDefaultTitle = provider === "shopify";
  const planFromStored = useStoredVariants && !enrichmentIncomplete;

  if (planFromStored) {
    let defaultIndex = 0;
    if (provider === "salla") {
      const marked = sellable.findIndex((item) => sallaIsDefault(item.variant));
      if (marked >= 0) defaultIndex = marked;
      const markedCount = sellable.filter((item) => sallaIsDefault(item.variant)).length;
      if (markedCount > 1) {
        diagnostics.push(
          diagnostic(
            "AMBIGUOUS_DEFAULT_VARIANT",
            SEVERITY.WARNING,
            "Multiple Salla variants marked is_default; first marked is used",
          ),
        );
      }
    }

    sellable.forEach((item, position) => {
      if (optionSourceMalformed(item.variant)) {
        diagnostics.push(
          diagnostic("MALFORMED_OPTIONS", SEVERITY.ERROR, "Option pair is not an object"),
        );
      }
      item.position = position;
      item.is_default = position === defaultIndex;
    });
  }

  const mergedOptions = normalizeOptionPairs(
    planFromStored
      ? sellable.flatMap((item) => {
          const pairs = extractOptionPairs(item.variant);
          return pairs;
        })
      : [],
    { skipShopifyDefaultTitle },
  );
  if (mergedOptions.malformed.length) {
    diagnostics.push(
      diagnostic("MALFORMED_OPTIONS", SEVERITY.ERROR, "Malformed option entries"),
    );
  }

  const plannedOptions = mergedOptions.options;
  const hasRealOptions = plannedOptions.length > 0;
  const sellableCount = planFromStored ? sellable.length : 1;
  const plannedProductType = enrichmentIncomplete
    ? null
    : hasRealOptions || sellableCount >= 2
      ? "variable"
      : "simple";

  const plannedMappings = [];

  function planOneVariant({
    externalVariantId,
    skuCandidate,
    barcodeCandidate,
    title,
    isDefault,
    position,
    priceSource,
    compareAtSource,
    leftover,
    optionPairs,
  }) {
    const sku = assignUnique(ctx.skuCounts, companyId, skuCandidate);
    if (sku.duplicate) {
      diagnostics.push(
        diagnostic(
          "DUPLICATE_INTERNAL_SKU",
          SEVERITY.WARNING,
          "SKU occurs more than once in this company; internal_sku left null",
        ),
      );
    }
    const barcode = assignUnique(ctx.barcodeCounts, companyId, barcodeCandidate);
    if (barcode.duplicate) {
      diagnostics.push(
        diagnostic(
          "DUPLICATE_BARCODE",
          SEVERITY.WARNING,
          "Barcode occurs more than once in this company; barcode left null",
        ),
      );
    } else if (provider === "shopify") {
      if (!diagnostics.some((item) => item.code === "BARCODE_UNAVAILABLE")) {
        diagnostics.push(
          diagnostic("BARCODE_UNAVAILABLE", SEVERITY.INFO, "Shopify barcode is not stored locally"),
        );
      }
    } else if (barcode.missing) {
      if (!diagnostics.some((item) => item.code === "MISSING_BARCODE")) {
        diagnostics.push(
          diagnostic("MISSING_BARCODE", SEVERITY.INFO, "No stored barcode"),
        );
      }
    }

    const price = parseCatalogPrice(priceSource);
    if (!price.ok && !price.missing) {
      diagnostics.push(
        diagnostic("INVALID_PRICE", SEVERITY.WARNING, "Stored price could not be parsed"),
      );
    } else if (price.missing) {
      const fallback = parseCatalogPrice(raw.price ?? product.price);
      if (fallback.ok) {
        price.ok = true;
        price.value = fallback.value;
        price.missing = false;
      } else if (!fallback.missing) {
        diagnostics.push(
          diagnostic("INVALID_PRICE", SEVERITY.WARNING, "Stored price could not be parsed"),
        );
      } else {
        diagnostics.push(
          diagnostic("MISSING_PRICE", SEVERITY.WARNING, "No reliable stored catalog price"),
        );
      }
    }

    const compareAt = parseCatalogPrice(compareAtSource);
    const compare_at_price =
      compareAt.ok && price.ok && compareAt.value !== price.value
        ? compareAt.value
        : compareAt.ok && !price.ok
          ? compareAt.value
          : null;

    const manual = !sourceId || provider === "manual";
    const vKey = variantKey({
      productId,
      integrationId: sourceId,
      externalProductId,
      externalVariantId,
      manual,
    });

    let existingVariant = null;
    if (!manual && integration && !orphan) {
      const mapKey = mappingIdentityKey(
        companyId,
        integration.id,
        externalProductId,
        externalVariantId,
      );
      const mapping = ctx.index.mappingByIdentity.get(mapKey);
      if (mapping?.internal_variant_id) {
        existingVariant = ctx.index.variantById.get(String(mapping.internal_variant_id)) || null;
      }
    } else if (manual && isDefault) {
      existingVariant =
        ctx.index.defaultByProduct.get(`${companyId}::${productId}`) || null;
    }

    const fields = {
      title: title || null,
      is_default: Boolean(isDefault),
      position,
      internal_sku: sku.value,
      barcode: barcode.value,
      price: price.ok ? price.value : null,
      compare_at_price,
    };
    const action = decideAction(existingVariant, fields);

    plannedVariants.push({
      action,
      variant_key: vKey,
      existing_variant_id: existingVariant?.id || null,
      company_id: companyId,
      product_id: productId,
      ...fields,
      external_variant_id: manual ? null : externalVariantId,
      option_pairs: optionPairs || [],
      raw_data: leftover || {},
    });

    if (!manual && !orphan && integration) {
      if (!externalProductId) {
        diagnostics.push(
          diagnostic(
            "MISSING_EXTERNAL_PRODUCT_ID",
            SEVERITY.ERROR,
            "Cannot create source mapping without external product id",
          ),
        );
      } else {
        const mapKey = mappingIdentityKey(
          companyId,
          integration.id,
          externalProductId,
          externalVariantId,
        );
        const existingMapping = ctx.index.mappingByIdentity.get(mapKey);
        let mappingAction = ACTION.CREATE;
        if (existingMapping) {
          const same =
            String(existingMapping.internal_product_id) === String(productId) &&
            String(existingMapping.internal_variant_id || "") ===
              String(existingVariant?.id || "") &&
            trimText(existingMapping.external_sku) === trimText(skuCandidate);
          mappingAction = same ? ACTION.REUSE : ACTION.UPDATE;
        }
        plannedMappings.push({
          action: mappingAction,
          company_id: companyId,
          integration_id: integration.id,
          external_product_id: externalProductId,
          external_variant_id: externalVariantId,
          internal_product_id: productId,
          variant_key: vKey,
          existing_mapping_id: existingMapping?.id || null,
          external_sku: trimText(skuCandidate) || null,
          metadata: {
            provider,
            truncated: truncated || undefined,
          },
        });
      }
    }
  }

  if (planFromStored) {
    sellable.forEach((item) => {
      const optionPairs = extractOptionPairs(item.variant)
        .map((pair) => ({
          name: trimText(pair?.name),
          value: trimText(pair?.value),
        }))
        .filter((pair) => pair.name && pair.value)
        .filter(
          (pair) =>
            !skipShopifyDefaultTitle ||
            !isShopifyDefaultTitleOption(pair.name, pair.value),
        );

      const leftover = {
        provider,
        external_variant_id: item.externalVariantId,
        gid: item.variant?.gid || item.variant?.admin_graphql_api_id || null,
        image: item.variant?.image || null,
        inventory_quantity:
          item.variant?.inventory_quantity ?? item.variant?.quantity ?? null,
      };

      let compareAt = item.variant?.compare_at_price ?? item.variant?.regular_price;
      if (provider === "salla" && Array.isArray(raw?.salla?.skus)) {
        const skuRow = raw.salla.skus.find(
          (sku) => trimText(sku?.id) === item.externalVariantId,
        );
        if (skuRow) compareAt = skuRow.regular_price ?? compareAt;
      }

      planOneVariant({
        externalVariantId: item.externalVariantId,
        skuCandidate: variantSku(item.variant),
        barcodeCandidate: variantBarcode(item.variant, provider),
        title:
          sellable.length === 1 && !hasRealOptions
            ? null
            : trimText(item.variant?.title || item.variant?.name) || null,
        isDefault: item.is_default,
        position: item.position,
        priceSource: item.variant?.sale_price ?? item.variant?.price,
        compareAtSource: compareAt,
        leftover,
        optionPairs,
      });
    });
  } else if (!variantsInfo.malformed && !enrichmentIncomplete) {
    planOneVariant({
      externalVariantId: "",
      skuCandidate: product.sku,
      barcodeCandidate: provider === "shopify" ? "" : trimText(raw.barcode ?? product.barcode),
      title: null,
      isDefault: true,
      position: 0,
      priceSource: raw.price ?? raw.sale_price ?? product.price,
      leftover: { provider, source: "product_row" },
      optionPairs: [],
    });
  }

  const optionOps = [];
  const valueOps = [];
  for (const option of plannedOptions) {
    const existingOption = ctx.index.optionByName.get(
      `${companyId}::${productId}::${option.name}`,
    );
    optionOps.push({
      action: existingOption ? ACTION.REUSE : ACTION.CREATE,
      company_id: companyId,
      product_id: productId,
      name: option.name,
      position: option.position,
      existing_option_id: existingOption?.id || null,
    });
    for (const value of option.values) {
      const existingValue = existingOption
        ? ctx.index.valueByOptionValue.get(
            `${companyId}::${existingOption.id}::${value.value}`,
          )
        : null;
      valueOps.push({
        action: existingValue ? ACTION.REUSE : ACTION.CREATE,
        company_id: companyId,
        product_id: productId,
        option_name: option.name,
        value: value.value,
        position: value.position,
        existing_option_value_id: existingValue?.id || null,
      });
    }
  }

  const status = productStatus(diagnostics);
  return {
    company_id: companyId,
    product_id: productId,
    provider,
    integration_id: sourceId || null,
    external_product_id: externalProductId || null,
    status,
    planned_product_type: plannedProductType,
    planned_variant_count: plannedVariants.length,
    diagnostics,
    variants: plannedVariants,
    options: optionOps,
    option_values: valueOps,
    source_mappings: plannedMappings,
    option_names: plannedOptions.map((option) => option.name),
    option_value_labels: plannedOptions.flatMap((option) =>
      option.values.map((value) => value.value),
    ),
  };
}

function planBostaDiagnostics(productPlan, bostaMappings) {
  const out = [];
  const rows = (bostaMappings || []).filter(
    (row) => String(row.catalog_product_id || "") === String(productPlan.product_id),
  );
  if (!rows.length) return out;

  const externalIds = new Set(
    (productPlan.variants || [])
      .map((variant) => trimText(variant.external_variant_id))
      .filter(Boolean),
  );
  const valueLabels = productPlan.option_value_labels || [];

  for (const row of rows) {
    const type = trimText(row.mapping_type);
    if (type === "variant") {
      const entityId = trimText(row.entity_id);
      const matchable = entityId && externalIds.has(entityId);
      out.push(
        diagnostic(
          matchable ? "BOSTA_VARIANT_MATCHABLE" : "BOSTA_VARIANT_UNMATCHED",
          matchable ? SEVERITY.INFO : SEVERITY.WARNING,
          matchable
            ? "Bosta variant entity_id matches a planned external variant id"
            : "Bosta variant entity_id does not match planned external variant ids",
          {
            mapping_id: row.id || null,
            entity_id: entityId || null,
          },
        ),
      );
      continue;
    }
    if (type === "size") {
      const sizes = asObject(row.sizes) || {};
      const keys = Object.keys(sizes);
      if (!keys.length) {
        out.push(
          diagnostic(
            "BOSTA_SIZE_AMBIGUOUS",
            SEVERITY.WARNING,
            "Bosta size mapping has no size keys",
            { mapping_id: row.id || null },
          ),
        );
        continue;
      }
      for (const sizeKey of keys) {
        const wanted = normalizeSizeKey(sizeKey);
        const hits = valueLabels.filter((label) => normalizeSizeKey(label) === wanted);
        const matchable = hits.length === 1;
        out.push(
          diagnostic(
            matchable ? "BOSTA_SIZE_MATCHABLE" : "BOSTA_SIZE_AMBIGUOUS",
            matchable ? SEVERITY.INFO : SEVERITY.WARNING,
            matchable
              ? "Bosta size key matches exactly one planned option value"
              : "Bosta size key does not uniquely match a planned option value",
            { mapping_id: row.id || null, size_key: sizeKey },
          ),
        );
      }
    }
  }
  return out;
}

function emptyCounts() {
  return {
    companies_scanned: 0,
    products_scanned: 0,
    products_ready: 0,
    products_ready_with_warnings: 0,
    products_blocked: 0,
    variants_create: 0,
    variants_reuse: 0,
    variants_update: 0,
    options_create: 0,
    option_values_create: 0,
    source_mappings_create: 0,
    duplicate_skus: 0,
    duplicate_barcodes: 0,
    easyorders_variants_not_stored: 0,
    truncated_provider_products: 0,
    bosta_followup_required: 0,
  };
}

function countAction(rows, action) {
  return (rows || []).filter((row) => row.action === action).length;
}

function planCatalogBackfill({
  products = [],
  integrations = [],
  existing = {},
  occupancy = {},
  bostaMappings = [],
} = {}) {
  const integrationById = new Map(
    (integrations || []).map((row) => [String(row.id), row]),
  );
  const { skuCounts, barcodeCounts } = collectCandidateSkusAndBarcodes(
    products,
    integrationById,
  );
  mergeOccupancyCounts(skuCounts, occupancy?.skuCounts);
  mergeOccupancyCounts(barcodeCounts, occupancy?.barcodeCounts);
  const index = existingIndex(existing);
  const ctx = { integrationById, skuCounts, barcodeCounts, index };

  const companies = new Set();
  const productPlans = [];
  const counts = emptyCounts();

  for (const product of products || []) {
    companies.add(String(product.company_id));
    const plan = planProduct(product, ctx);
    const bosta = planBostaDiagnostics(plan, bostaMappings);
    plan.diagnostics = [...plan.diagnostics, ...bosta];
    plan.status = productStatus(plan.diagnostics);
    if (bosta.some((item) => item.severity !== SEVERITY.INFO)) {
      counts.bosta_followup_required += 1;
    }
    productPlans.push(plan);

    counts.products_scanned += 1;
    if (plan.status === STATUS.READY) counts.products_ready += 1;
    else if (plan.status === STATUS.READY_WITH_WARNINGS) {
      counts.products_ready_with_warnings += 1;
    } else counts.products_blocked += 1;

    counts.variants_create += countAction(plan.variants, ACTION.CREATE);
    counts.variants_reuse += countAction(plan.variants, ACTION.REUSE);
    counts.variants_update += countAction(plan.variants, ACTION.UPDATE);
    counts.options_create += countAction(plan.options, ACTION.CREATE);
    counts.option_values_create += countAction(plan.option_values, ACTION.CREATE);
    counts.source_mappings_create += countAction(plan.source_mappings, ACTION.CREATE);

    if (plan.diagnostics.some((item) => item.code === "DUPLICATE_INTERNAL_SKU")) {
      counts.duplicate_skus += 1;
    }
    if (plan.diagnostics.some((item) => item.code === "DUPLICATE_BARCODE")) {
      counts.duplicate_barcodes += 1;
    }
    if (plan.diagnostics.some((item) => item.code === "EASYORDERS_VARIANTS_NOT_STORED")) {
      counts.easyorders_variants_not_stored += 1;
    }
    if (plan.diagnostics.some((item) => item.code === "TRUNCATED_PROVIDER_VARIANTS")) {
      counts.truncated_provider_products += 1;
    }
  }

  counts.companies_scanned = companies.size;

  const publicProducts = productPlans.map((plan) => ({
    company_id: plan.company_id,
    product_id: plan.product_id,
    provider: plan.provider,
    integration_id: plan.integration_id,
    external_product_id: plan.external_product_id,
    status: plan.status,
    planned_product_type: plan.planned_product_type,
    planned_variant_count: plan.planned_variant_count,
    diagnostics: plan.diagnostics.map((item) => ({
      code: item.code,
      severity: item.severity,
      message: item.message,
    })),
  }));

  return {
    mode: "dry-run",
    commit_enabled: false,
    counts,
    products: publicProducts,
    operations: {
      variants: productPlans.flatMap((plan) => plan.variants),
      options: productPlans.flatMap((plan) => plan.options),
      option_values: productPlans.flatMap((plan) => plan.option_values),
      source_mappings: productPlans.flatMap((plan) => plan.source_mappings),
    },
    plans: productPlans,
  };
}

function formatCatalogBackfillSummary(report) {
  const c = report.counts || emptyCounts();
  return [
    `Catalog backfill ${report.mode || "dry-run"} (commit_enabled=${Boolean(report.commit_enabled)})`,
    `companies=${c.companies_scanned} products=${c.products_scanned}`,
    `ready=${c.products_ready} ready_with_warnings=${c.products_ready_with_warnings} blocked=${c.products_blocked}`,
    `variants create/reuse/update=${c.variants_create}/${c.variants_reuse}/${c.variants_update}`,
    `options_create=${c.options_create} option_values_create=${c.option_values_create} mappings_create=${c.source_mappings_create}`,
    `duplicate_skus=${c.duplicate_skus} duplicate_barcodes=${c.duplicate_barcodes}`,
    `easyorders_variants_not_stored=${c.easyorders_variants_not_stored} truncated=${c.truncated_provider_products} bosta_followup=${c.bosta_followup_required}`,
  ].join("\n");
}

function assertSaasDevelopmentTarget(supabaseUrl) {
  const urlText = trimText(supabaseUrl);
  if (!urlText) {
    const err = new Error("SUPABASE_URL is missing; refusing to run");
    err.code = "TARGET_UNVERIFIED";
    throw err;
  }
  let host = "";
  try {
    host = new URL(urlText).hostname;
  } catch {
    const err = new Error("SUPABASE_URL is not a valid URL; refusing to run");
    err.code = "TARGET_UNVERIFIED";
    throw err;
  }
  if (host !== ALLOWED_SAAS_DEV_HOST) {
    const err = new Error(
      `Refusing catalog backfill: host is not the allowed SaaS Development project (${ALLOWED_SAAS_DEV_REF})`,
    );
    err.code = "TARGET_UNVERIFIED";
    throw err;
  }
  return { project_ref: ALLOWED_SAAS_DEV_REF, host };
}

function parseCatalogBackfillCliArgs(argv = []) {
  const args = argv.filter((item) => item !== "--");
  const help = args.includes("--help") || args.includes("-h");
  const commit = args.includes("--commit");
  const dryRun =
    args.includes("--dry-run") || (!commit && !args.includes("--execute"));
  const json = args.includes("--json");
  let companyId = "";
  const companyIdx = args.findIndex((item) => item === "--company-id");
  if (companyIdx >= 0) companyId = trimText(args[companyIdx + 1]);
  return { help, commit, dryRun, json, companyId };
}

module.exports = {
  ALLOWED_SAAS_DEV_REF,
  ALLOWED_SAAS_DEV_HOST,
  COMMIT_DISABLED_MESSAGE,
  SEVERITY,
  STATUS,
  ACTION,
  planCatalogBackfill,
  productStatus,
  formatCatalogBackfillSummary,
  assertSaasDevelopmentTarget,
  parseCatalogBackfillCliArgs,
  parseCatalogPrice,
  normalizeOptionPairs,
  parseRawData,
};
