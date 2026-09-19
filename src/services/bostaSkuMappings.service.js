const supabase = require("../config/tenantSupabase");
const {
  resolveBostaShippingConnection,
  requireCatalogProductById,
  resolveCatalogProduct,
  resolveLineCatalogProduct,
  isUuid,
  pickShippingIntegrationId,
} = require("./bostaShipping.service");
const { getActiveIntegration } = require("../utils/tenantScope");

const MAPPINGS_TABLE =
  process.env.SUPABASE_BOSTA_SKU_MAPPINGS_TABLE || "bosta_sku_mappings";
const UNMAPPED_TABLE =
  process.env.SUPABASE_BOSTA_UNMAPPED_PRODUCTS_TABLE ||
  "bosta_unmapped_products";

const MAPPING_TYPES = ["product", "variant", "size"];

function isLegacyMappingRow(row) {
  return !row?.shipping_integration_id || !row?.catalog_product_id;
}

function isAttributedToShipping(row, shippingId) {
  return (
    String(row?.shipping_integration_id || "") === String(shippingId || "") &&
    Boolean(row?.catalog_product_id)
  );
}

function normalizeSkus(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((s) => String(s || "").trim()).filter(Boolean))];
}

function normalizeSizes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out = {};
  for (const [sizeKey, skus] of Object.entries(value)) {
    const normalized = normalizeSkus(skus);
    if (normalized.length) {
      out[String(sizeKey).trim()] = normalized;
    }
  }
  return Object.keys(out).length ? out : null;
}

function pickPrimarySku(skus) {
  const list = normalizeSkus(skus);
  return list[0] || null;
}

function rowToProductEntry(row) {
  return {
    name: row.name || "",
    skus: normalizeSkus(row.skus),
  };
}

function rowToVariantEntry(row) {
  return {
    productId: row.product_id || null,
    name: row.name || "",
    size: row.size || null,
    skus: normalizeSkus(row.skus),
  };
}

function rowToSizeEntry(row) {
  return {
    name: row.name || "",
    sizes: normalizeSizes(row.sizes) || {},
  };
}

function buildAttributedMaps(rows) {
  const productSkuMap = {};
  const variantSkuMap = {};
  const sizeSkuMap = {};
  const variantByCatalog = {};

  for (const row of rows || []) {
    const catalogId = String(row.catalog_product_id || "").trim();
    if (!catalogId) continue;
    if (row.mapping_type === "product") {
      productSkuMap[catalogId] = rowToProductEntry(row);
    } else if (row.mapping_type === "variant") {
      variantSkuMap[row.entity_id] = {
        ...rowToVariantEntry(row),
        catalogProductId: catalogId,
      };
      if (!variantByCatalog[catalogId]) variantByCatalog[catalogId] = {};
      variantByCatalog[catalogId][row.entity_id] = {
        ...rowToVariantEntry(row),
        catalogProductId: catalogId,
      };
    } else if (row.mapping_type === "size") {
      sizeSkuMap[catalogId] = rowToSizeEntry(row);
    }
  }

  return {
    productSkuMap,
    variantSkuMap,
    variantByCatalog,
    sizeSkuMap,
  };
}

function presentMappingRow(row) {
  if (!row) return null;
  const legacy = isLegacyMappingRow(row);
  const base = {
    id: row.id,
    mappingType: row.mapping_type,
    entityId: row.entity_id,
    catalogProductId: row.catalog_product_id || null,
    shippingIntegrationId: row.shipping_integration_id || null,
    name: row.name || "",
    legacy,
  };
  if (row.mapping_type === "product") {
    return { ...base, skus: normalizeSkus(row.skus) };
  }
  if (row.mapping_type === "variant") {
    return {
      ...base,
      productId: row.product_id || null,
      size: row.size || null,
      skus: normalizeSkus(row.skus),
    };
  }
  return { ...base, sizes: normalizeSizes(row.sizes) || {} };
}

function presentUnmappedRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_id,
    catalogProductId: row.catalog_product_id || null,
    shippingIntegrationId: row.shipping_integration_id || null,
    name: row.name || "",
    reason: row.reason || "",
    legacy: isLegacyMappingRow(row),
  };
}

async function fetchAllMappingRows() {
  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .select("*")
    .order("mapping_type", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function fetchUnmappedRows() {
  const { data, error } = await supabase
    .from(UNMAPPED_TABLE)
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function loadAttributedMapsForShipping(shippingId) {
  const [rows, unmappedRows] = await Promise.all([
    fetchAllMappingRows(),
    fetchUnmappedRows(),
  ]);
  const attributed = rows.filter((row) => isAttributedToShipping(row, shippingId));
  const unmapped = unmappedRows.filter((row) =>
    isAttributedToShipping(row, shippingId),
  );
  return {
    ...buildAttributedMaps(attributed),
    unmappedProducts: unmapped.map((row) => ({
      id: row.id,
      productId: row.product_id,
      catalogProductId: row.catalog_product_id,
      name: row.name || "",
      reason: row.reason || "",
    })),
    rows: attributed,
  };
}

async function getBostaSkuMappings(options = {}) {
  const shipping = await resolveBostaShippingConnection(
    options.shippingIntegrationId || pickShippingIntegrationId(options),
  );
  const [rows, unmappedRows] = await Promise.all([
    fetchAllMappingRows(),
    fetchUnmappedRows(),
  ]);
  const attributed = rows.filter((row) => isAttributedToShipping(row, shipping.id));
  const unmapped = unmappedRows.filter((row) =>
    isAttributedToShipping(row, shipping.id),
  );
  const legacyMappings = rows.filter(isLegacyMappingRow).map(presentMappingRow);
  const legacyUnmapped = unmappedRows
    .filter(isLegacyMappingRow)
    .map(presentUnmappedRow);
  const maps = buildAttributedMaps(attributed);

  return {
    shippingIntegrationId: shipping.id,
    mappings: attributed.map(presentMappingRow),
    productSkuMap: maps.productSkuMap,
    variantSkuMap: maps.variantSkuMap,
    sizeSkuMap: maps.sizeSkuMap,
    unmappedProducts: unmapped.map(presentUnmappedRow),
    legacyMappings,
    legacyUnmappedProducts: legacyUnmapped,
  };
}

async function getBostaSkuMapping(mappingType, entityId, options = {}) {
  const shipping = await resolveBostaShippingConnection(
    options.shippingIntegrationId || pickShippingIntegrationId(options),
  );
  const type = String(mappingType || "").trim();
  const id = String(entityId || "").trim();

  if (!MAPPING_TYPES.includes(type)) {
    const err = new Error('mappingType must be "product", "variant", or "size"');
    err.code = "INVALID_MAPPING_TYPE";
    throw err;
  }
  if (!id) {
    const err = new Error("entityId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  const rows = await fetchAllMappingRows();
  const attributed = rows.filter((row) => isAttributedToShipping(row, shipping.id));
  const hit =
    attributed.find((row) => {
      if (row.mapping_type !== type) return false;
      if (type === "variant") return String(row.entity_id) === id;
      return (
        String(row.catalog_product_id) === id || String(row.entity_id) === id
      );
    }) || null;

  if (!hit) {
    const err = new Error("Mapping not found");
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }

  return hit;
}

async function getBostaSkuMappingById(mappingId) {
  const id = String(mappingId || "").trim();
  if (!isUuid(id)) {
    const err = new Error("mapping id is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }
  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const err = new Error("Mapping not found");
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }
  return data;
}

function validateMappingPayload(input, { forUpdate = false } = {}) {
  const mappingType = String(input.mappingType || input.mapping_type || "")
    .trim()
    .toLowerCase();

  if (!forUpdate && !MAPPING_TYPES.includes(mappingType)) {
    const err = new Error('mappingType must be "product", "variant", or "size"');
    err.code = "INVALID_MAPPING_TYPE";
    throw err;
  }

  const catalogProductId = String(
    input.catalogProductId ?? input.catalog_product_id ?? "",
  ).trim();

  const entityId = String(
    input.entityId ?? input.entity_id ?? input.variantId ?? "",
  ).trim();

  const name = String(input.name ?? "").trim();
  if (!forUpdate && !name) {
    const err = new Error("name is required");
    err.code = "INVALID_NAME";
    throw err;
  }

  const payload = {
    mapping_type: mappingType,
    updated_at: new Date().toISOString(),
  };
  if (catalogProductId) payload.catalog_product_id = catalogProductId;
  if (name) payload.name = name;

  if (mappingType === "product") {
    const skus = normalizeSkus(input.skus);
    if (!forUpdate && !skus.length) {
      const err = new Error("skus must be a non-empty array for product mappings");
      err.code = "INVALID_SKUS";
      throw err;
    }
    if (input.skus !== undefined) payload.skus = skus;
    payload.product_id = catalogProductId || null;
    payload.size = null;
    payload.sizes = null;
    payload.entity_id = catalogProductId || entityId;
  }

  if (mappingType === "variant") {
    if (!forUpdate && !entityId) {
      const err = new Error("entityId (provider variant id) is required for variant mappings");
      err.code = "INVALID_ENTITY_ID";
      throw err;
    }
    const skus = normalizeSkus(input.skus);
    if (!forUpdate && !skus.length) {
      const err = new Error("skus must be a non-empty array for variant mappings");
      err.code = "INVALID_SKUS";
      throw err;
    }
    if (entityId) payload.entity_id = entityId;
    payload.product_id = catalogProductId || null;
    if (input.size != null) payload.size = String(input.size).trim();
    if (input.skus !== undefined) payload.skus = skus;
    payload.sizes = null;
  }

  if (mappingType === "size") {
    const sizes = normalizeSizes(input.sizes);
    if (!forUpdate && !sizes) {
      const err = new Error("sizes must be a non-empty object for size mappings");
      err.code = "INVALID_SIZES";
      throw err;
    }
    if (input.sizes !== undefined) payload.sizes = sizes;
    payload.product_id = catalogProductId || null;
    payload.size = null;
    payload.skus = [];
    payload.entity_id = catalogProductId || entityId;
  }

  return payload;
}

async function addBostaSkuMapping(input) {
  const shipping = await resolveBostaShippingConnection(
    pickShippingIntegrationId(input),
    { required: true },
  );
  const catalog = await requireCatalogProductById(
    input.catalogProductId ?? input.catalog_product_id,
  );
  const payload = validateMappingPayload({
    ...input,
    catalogProductId: catalog.id,
  });
  payload.shipping_integration_id = shipping.id;
  payload.catalog_product_id = catalog.id;
  if (payload.mapping_type !== "variant") {
    payload.entity_id = catalog.id;
  }

  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (String(error.code) === "23505") {
      const dup = new Error("Mapping already exists for this Bosta account and catalog product");
      dup.code = "MAPPING_EXISTS";
      throw dup;
    }
    throw new Error(error.message);
  }

  return data;
}

async function updateBostaSkuMapping(mappingType, entityId, input) {
  const existing = await getBostaSkuMapping(mappingType, entityId, input);
  return updateBostaSkuMappingById(existing.id, input);
}

async function updateBostaSkuMappingById(mappingId, input) {
  const existing = await getBostaSkuMappingById(mappingId);
  if (isLegacyMappingRow(existing)) {
    const err = new Error("Legacy mappings cannot be edited in place");
    err.code = "LEGACY_MAPPING_READONLY";
    throw err;
  }
  if (input.shippingIntegrationId || input.shipping_integration_id) {
    const shipping = await resolveBostaShippingConnection(
      pickShippingIntegrationId(input),
    );
    if (String(existing.shipping_integration_id) !== String(shipping.id)) {
      const err = new Error("Mapping not found");
      err.code = "MAPPING_NOT_FOUND";
      throw err;
    }
  }

  const patch = validateMappingPayload(
    {
      ...input,
      mappingType: existing.mapping_type,
      entityId: existing.entity_id,
      catalogProductId: existing.catalog_product_id,
    },
    { forUpdate: true },
  );
  delete patch.mapping_type;
  delete patch.entity_id;
  delete patch.catalog_product_id;
  delete patch.shipping_integration_id;

  if (!Object.keys(patch).length) {
    const err = new Error("No fields to update");
    err.code = "INVALID_UPDATES";
    throw err;
  }

  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .update(patch)
    .eq("id", existing.id)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function deleteBostaSkuMapping(mappingType, entityId, input = {}) {
  const existing = await getBostaSkuMapping(mappingType, entityId, input);
  return deleteBostaSkuMappingById(existing.id, input);
}

async function deleteBostaSkuMappingById(mappingId, input = {}) {
  const existing = await getBostaSkuMappingById(mappingId);
  if (input.shippingIntegrationId || input.shipping_integration_id) {
    const shipping = await resolveBostaShippingConnection(
      pickShippingIntegrationId(input),
    );
    if (
      existing.shipping_integration_id &&
      String(existing.shipping_integration_id) !== String(shipping.id)
    ) {
      const err = new Error("Mapping not found");
      err.code = "MAPPING_NOT_FOUND";
      throw err;
    }
  }

  const { error } = await supabase.from(MAPPINGS_TABLE).delete().eq("id", existing.id);
  if (error) throw new Error(error.message);
  return {
    mappingType: existing.mapping_type,
    entityId: existing.entity_id,
    id: existing.id,
    deleted: true,
  };
}

async function deleteUnmappedProduct(productId, input = {}) {
  const shipping = await resolveBostaShippingConnection(
    pickShippingIntegrationId(input),
    { required: true },
  );
  const id = String(productId || "").trim();
  if (!id) {
    const err = new Error("productId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  const rows = await fetchUnmappedRows();
  const hit = rows.find((row) => {
    if (!isAttributedToShipping(row, shipping.id)) return false;
    return (
      String(row.id) === id ||
      String(row.catalog_product_id) === id ||
      String(row.product_id) === id
    );
  });
  if (!hit) {
    const err = new Error("Unmapped product not found");
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }

  const { error } = await supabase.from(UNMAPPED_TABLE).delete().eq("id", hit.id);
  if (error) throw new Error(error.message);
  return presentUnmappedRow({ ...hit, deleted: true });
}

async function replaceUnmappedProductsForShipping(shippingId, unmappedProducts) {
  const existing = await fetchUnmappedRows();
  const toDelete = existing.filter((row) =>
    isAttributedToShipping(row, shippingId),
  );
  for (const row of toDelete) {
    const { error } = await supabase.from(UNMAPPED_TABLE).delete().eq("id", row.id);
    if (error) throw new Error(error.message);
  }

  const rows = [];
  for (const item of unmappedProducts || []) {
    const catalog = await resolveCatalogProduct({
      catalogProductId: item.catalogProductId ?? item.catalog_product_id,
      externalId: item.productId ?? item.product_id ?? item.entityId,
      sourceIntegrationId:
        item.sourceIntegrationId ?? item.source_integration_id,
    });
    rows.push({
      shipping_integration_id: shippingId,
      catalog_product_id: catalog.id,
      product_id: String(item.productId ?? item.product_id ?? catalog.easyorder_id ?? catalog.id),
      name: String(item.name ?? catalog.name ?? "").trim(),
      reason: String(item.reason ?? "").trim(),
      updated_at: new Date().toISOString(),
    });
  }

  if (!rows.length) return [];
  const { data, error } = await supabase.from(UNMAPPED_TABLE).insert(rows).select();
  if (error) throw new Error(error.message);
  return data || [];
}

async function resolveImportCatalogProduct(entityId, entry, defaultSourceId) {
  return resolveCatalogProduct({
    catalogProductId: entry?.catalogProductId ?? entry?.catalog_product_id,
    externalId: entityId,
    sourceIntegrationId:
      entry?.sourceIntegrationId ??
      entry?.source_integration_id ??
      defaultSourceId,
  });
}

async function importBostaSkuMappings(payload) {
  const shipping = await resolveBostaShippingConnection(
    pickShippingIntegrationId(payload),
    { required: true },
  );
  const defaultSourceId = String(
    payload?.sourceIntegrationId ?? payload?.source_integration_id ?? "",
  ).trim();

  const productSkuMap = payload?.productSkuMap || {};
  const variantSkuMap = payload?.variantSkuMap || {};
  const sizeSkuMap = payload?.sizeSkuMap || {};
  const unmappedProducts = payload?.unmappedProducts || [];

  const rows = [];
  const ambiguous = [];
  const missing = [];

  async function pushResolved(entityId, entry, mappingType) {
    try {
      const catalog = await resolveImportCatalogProduct(
        entityId,
        entry,
        defaultSourceId,
      );
      const payloadRow = validateMappingPayload({
        mappingType,
        catalogProductId: catalog.id,
        entityId: mappingType === "variant" ? entityId : catalog.id,
        name: entry?.name || catalog.name || "",
        skus: entry?.skus,
        sizes: entry?.sizes,
        size: entry?.size,
        productId: catalog.id,
      });
      payloadRow.shipping_integration_id = shipping.id;
      payloadRow.catalog_product_id = catalog.id;
      if (mappingType !== "variant") payloadRow.entity_id = catalog.id;
      rows.push(payloadRow);
    } catch (error) {
      if (error.code === "CATALOG_PRODUCT_AMBIGUOUS") {
        ambiguous.push({ entityId, mappingType, message: error.message });
        return;
      }
      if (error.code === "CATALOG_PRODUCT_NOT_FOUND" || error.code === "INVALID_CATALOG_PRODUCT") {
        missing.push({ entityId, mappingType, message: error.message });
        return;
      }
      throw error;
    }
  }

  for (const [entityId, entry] of Object.entries(productSkuMap)) {
    await pushResolved(entityId, entry, "product");
  }
  for (const [entityId, entry] of Object.entries(variantSkuMap)) {
    await pushResolved(entityId, entry, "variant");
  }
  for (const [entityId, entry] of Object.entries(sizeSkuMap)) {
    await pushResolved(entityId, entry, "size");
  }

  if (ambiguous.length) {
    const err = new Error(
      "Import has external product ids that match multiple catalog products",
    );
    err.code = "IMPORT_PRODUCT_AMBIGUOUS";
    err.ambiguous = ambiguous;
    throw err;
  }
  if (missing.length && !rows.length && !unmappedProducts.length) {
    const err = new Error("No import rows could be resolved to catalog products");
    err.code = "CATALOG_PRODUCT_NOT_FOUND";
    err.missing = missing;
    throw err;
  }

  const existing = await fetchAllMappingRows();
  const toDelete = existing.filter((row) =>
    isAttributedToShipping(row, shipping.id),
  );
  for (const row of toDelete) {
    const { error } = await supabase.from(MAPPINGS_TABLE).delete().eq("id", row.id);
    if (error) throw new Error(error.message);
  }

  if (rows.length) {
    const { error } = await supabase.from(MAPPINGS_TABLE).insert(rows);
    if (error) throw new Error(error.message);
  }

  await replaceUnmappedProductsForShipping(shipping.id, unmappedProducts);

  return getBostaSkuMappings({ shippingIntegrationId: shipping.id });
}

function pickLineProductId(line) {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  return (
    String(
      line?.variant?.productId ??
        line?.variant?.product_id ??
        line?.product_id ??
        line?.productId ??
        product?.id ??
        product?.product_id ??
        product?.easyorder_id ??
        "",
    ).trim() || null
  );
}

function pickLineVariantId(line) {
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  return (
    String(
      variant?.id ??
        variant?.variant_id ??
        variant?.variantId ??
        line?.variant_id ??
        line?.variantId ??
        "",
    ).trim() || null
  );
}

function pickLineSize(line) {
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  const size = variant?.size ?? line?.size ?? variant?.options?.size;
  return size != null ? String(size).trim() : null;
}

function pickLineDisplayName(line, mappingName = "") {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  return (
    String(mappingName || "").trim() ||
    String(line?.name || line?.product_name || product?.name || "").trim() ||
    "منتج"
  );
}

/** SKU chosen by user on create/edit order or send-to-bosta body. */
function pickLineSelectedBostaSku(line) {
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  const candidates = [
    line?.bosta_sku,
    line?.bostaSku,
    line?.bostaSkuCode,
    line?.skuCode,
    variant?.bosta_sku,
    variant?.bostaSku,
    variant?.sku,
    line?.sku,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value && /^bo-/i.test(value)) {
      return value;
    }
  }

  return null;
}

function normalizeBostaSkuCode(value) {
  const sku = String(value || "").trim();
  if (!sku || !/^bo-/i.test(sku)) return null;
  return sku;
}

/** Parse SKU overrides from send-to-bosta request body → Map<lineIndex, skuCode>. */
function parseLineSkuOverrides(body = {}) {
  const src =
    body?.overrides && typeof body.overrides === "object" ? body.overrides : body;
  const skuByIndex = new Map();
  const priceByIndex = new Map();

  const rootSku = normalizeBostaSkuCode(
    src.skuCode ?? src.sku ?? src.bosta_sku ?? src.bostaSku,
  );
  if (rootSku) {
    skuByIndex.set(0, rootSku);
  }

  const listSources = [
    src.lineSkus,
    src.line_skus,
    src.items,
    src.skus,
    src.cart_items,
    src.cartItems,
  ];

  for (const list of listSources) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (entry == null) continue;

      if (typeof entry === "string") {
        const sku = normalizeBostaSkuCode(entry);
        if (sku) skuByIndex.set(i, sku);
        continue;
      }

      if (typeof entry !== "object") continue;

      const lineIndex = Number(
        entry.lineIndex ?? entry.line_index ?? entry.index ?? i,
      );
      if (!Number.isFinite(lineIndex) || lineIndex < 0) continue;

      const sku = normalizeBostaSkuCode(
        entry.skuCode ??
          entry.sku ??
          entry.bosta_sku ??
          entry.bostaSku ??
          entry.bostaSkuCode,
      );
      if (sku) {
        skuByIndex.set(lineIndex, sku);
      }

      const priceRaw = entry.price;
      if (priceRaw != null && priceRaw !== "") {
        const price = Number(priceRaw);
        if (Number.isFinite(price) && price >= 0) {
          priceByIndex.set(lineIndex, price);
        }
      }
    }
  }

  return { skuByIndex, priceByIndex };
}

function applyLineSkuOverridesToOrder(
  localOrder,
  lineSkuOverrides,
  priceByIndex,
) {
  if (!localOrder || typeof localOrder !== "object") return localOrder;

  const hasSkuOverrides =
    lineSkuOverrides &&
    lineSkuOverrides instanceof Map &&
    lineSkuOverrides.size > 0;
  const hasPriceOverrides =
    priceByIndex && priceByIndex instanceof Map && priceByIndex.size > 0;
  if (!hasSkuOverrides && !hasPriceOverrides) {
    return localOrder;
  }

  const cartKey = Array.isArray(localOrder.cart_items)
    ? "cart_items"
    : Array.isArray(localOrder.cartItems)
      ? "cartItems"
      : null;
  if (!cartKey) return localOrder;

  const lines = [...localOrder[cartKey]];

  if (hasSkuOverrides) {
    for (const [index, sku] of lineSkuOverrides.entries()) {
      if (!lines[index] || typeof lines[index] !== "object") continue;
      const line = { ...lines[index] };
      const variant =
        line.variant && typeof line.variant === "object"
          ? { ...line.variant }
          : {};

      line.bosta_sku = sku;
      line.bostaSku = sku;
      line.skuCode = sku;
      variant.sku = sku;
      variant.bosta_sku = sku;
      line.variant = variant;
      lines[index] = line;
    }
  }

  if (hasPriceOverrides) {
    for (const [index, price] of priceByIndex.entries()) {
      if (!lines[index] || typeof lines[index] !== "object") continue;
      const line = { ...lines[index] };
      const n = Number(price);
      if (Number.isFinite(n) && n >= 0) {
        line.price = n;
        line.unit_price = n;
        line.unitPrice = n;
      }
      lines[index] = line;
    }
  }

  return {
    ...localOrder,
    [cartKey]: normalizeCartItemsBostaFields(lines),
  };
}

function normalizeCartItemsBostaFields(cartItems) {
  if (!Array.isArray(cartItems)) return cartItems;

  return cartItems.map((line) => {
    if (!line || typeof line !== "object") return line;

    const selectedSku = pickLineSelectedBostaSku(line);
    const variant =
      line.variant && typeof line.variant === "object"
        ? { ...line.variant }
        : {};
    const bostaName = String(
      line.bosta_name ??
        line.bostaName ??
        variant.bosta_name ??
        variant.bostaName ??
        variant.name ??
        "",
    ).trim();

    if (!selectedSku && !bostaName) return line;

    const out = { ...line, variant };
    if (selectedSku) {
      out.bosta_sku = selectedSku;
      out.bostaSku = selectedSku;
      variant.sku = selectedSku;
      variant.bosta_sku = selectedSku;
    }
    if (bostaName) {
      out.bosta_name = bostaName;
      out.bostaName = bostaName;
      if (!variant.name) variant.name = bostaName;
    }
    out.variant = variant;
    return out;
  });
}

function resolveLineSkuForBosta(line, maps, inventoryMap, requiredQty) {
  const requiredQuantity = Math.max(1, Number(requiredQty) || 1);
  const resolved = resolveMappedSkuCandidatesForLine(line, maps);
  const userSku = pickLineSelectedBostaSku(line);

  if (userSku) {
    const candidateSkus = normalizeSkus(resolved.skus);
    if (candidateSkus.length && !candidateSkus.includes(userSku)) {
      return {
        ok: false,
        reason: "invalid_selected_sku",
        productName: resolved.productName,
        requiredQuantity,
        selectedSku: userSku,
        candidateSkus,
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
      };
    }

    const availableQuantity = Number(inventoryMap.get(userSku) || 0);
    if (availableQuantity < requiredQuantity) {
      return {
        ok: false,
        reason: "out_of_stock",
        productName: resolved.productName,
        requiredQuantity,
        selectedSku: userSku,
        candidateSkus: candidateSkus.length ? candidateSkus : [userSku],
        availableQuantity,
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
      };
    }

    return {
      ok: true,
      skuCode: userSku,
      availableQuantity,
      productName: resolved.productName,
      requiredQuantity,
      source: "user_selected",
      mappingType: resolved.mappingType,
      entityId: resolved.entityId,
    };
  }

  if (!resolved.skus.length) {
    return {
      ok: false,
      reason: "no_sku_mapping",
      productName: resolved.productName,
      requiredQuantity,
      candidateSkus: [],
      availableQuantity: 0,
      mappingType: resolved.mappingType,
      entityId: resolved.entityId,
    };
  }

  const picked = pickAvailableSkuFromCandidates(
    resolved.skus,
    requiredQuantity,
    inventoryMap,
  );

  if (!picked) {
    return {
      ok: false,
      reason: "out_of_stock",
      productName: resolved.productName,
      requiredQuantity,
      candidateSkus: resolved.skus,
      availableQuantity: Math.max(
        ...resolved.skus.map((sku) => Number(inventoryMap.get(sku) || 0)),
        0,
      ),
      mappingType: resolved.mappingType,
      entityId: resolved.entityId,
    };
  }

  return {
    ok: true,
    skuCode: picked.skuCode,
    availableQuantity: picked.availableQuantity,
    productName: resolved.productName,
    requiredQuantity,
    source: "auto_inventory",
    mappingType: resolved.mappingType,
    entityId: resolved.entityId,
  };
}

function normalizeSizeKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.match(/\d+/);
  return digits ? digits[0] : raw;
}

function resolveMappedSkuCandidatesForLine(line, maps) {
  const variantId = pickLineVariantId(line);
  const catalogId = String(
    line?._catalogProductId ??
      line?.catalogProductId ??
      line?.catalog_product_id ??
      "",
  ).trim();
  const size = pickLineSize(line);
  const normalizedSize = normalizeSizeKey(size);
  const variantByCatalog = maps.variantByCatalog || {};

  if (catalogId && variantId && variantByCatalog[catalogId]?.[variantId]) {
    const entry = variantByCatalog[catalogId][variantId];
    return {
      productName: pickLineDisplayName(line, entry.name),
      skus: normalizeSkus(entry.skus),
      mappingType: "variant",
      entityId: variantId,
      catalogProductId: catalogId,
    };
  }

  if (catalogId && maps.sizeSkuMap[catalogId]) {
    const entry = maps.sizeSkuMap[catalogId];
    const sizes = entry.sizes || {};

    if (normalizedSize && sizes[normalizedSize]) {
      return {
        productName: pickLineDisplayName(line, entry.name),
        skus: normalizeSkus(sizes[normalizedSize]),
        mappingType: "size",
        entityId: catalogId,
        catalogProductId: catalogId,
        size: normalizedSize,
      };
    }

    if (normalizedSize) {
      for (const [sizeKey, skus] of Object.entries(sizes)) {
        if (
          normalizeSizeKey(sizeKey) === normalizedSize ||
          String(sizeKey).includes(normalizedSize)
        ) {
          return {
            productName: pickLineDisplayName(line, entry.name),
            skus: normalizeSkus(skus),
            mappingType: "size",
            entityId: catalogId,
            catalogProductId: catalogId,
            size: sizeKey,
          };
        }
      }
    }
  }

  if (catalogId && maps.productSkuMap[catalogId]) {
    const entry = maps.productSkuMap[catalogId];
    return {
      productName: pickLineDisplayName(line, entry.name),
      skus: normalizeSkus(entry.skus),
      mappingType: "product",
      entityId: catalogId,
      catalogProductId: catalogId,
    };
  }

  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};

  return {
    productName: pickLineDisplayName(line),
    skus: normalizeSkus([
      variant.sku,
      variant.taager_code,
      line.sku,
      product.sku,
      line.product_sku,
    ]),
    mappingType: null,
    entityId: catalogId || variantId || pickLineProductId(line) || null,
  };
}

function pickAvailableSkuFromCandidates(skus, requiredQty, inventoryMap) {
  const qtyNeeded = Math.max(1, Number(requiredQty) || 1);

  for (const sku of normalizeSkus(skus)) {
    const available = Number(inventoryMap.get(sku) || 0);
    if (available >= qtyNeeded) {
      return { skuCode: sku, availableQuantity: available };
    }
  }

  return null;
}

function buildInventoryUnavailableError(unavailableProducts) {
  const names = unavailableProducts.map((p) => p.productName).filter(Boolean);
  const hasInvalidSku = unavailableProducts.some(
    (p) => p.reason === "invalid_selected_sku",
  );
  const messageAr = hasInvalidSku
    ? `الـ SKU المختار غير صالح للمنتج (${names.join("، ")})`
    : names.length === 1
      ? `المنتج (${names[0]}) غير متوفر في المخزن`
      : `المنتجات (${names.join("، ")}) غير متوفرة في المخزن`;

  const err = new Error(messageAr);
  err.code = "BOSTA_INVENTORY_UNAVAILABLE";
  err.messageAr = messageAr;
  err.unavailableProducts = unavailableProducts;
  return err;
}

/**
 * Resolve Bosta skuCode from mappings + inventory availability.
 */
async function resolveMappedBostaSkuForLine(
  line,
  maps = null,
  inventoryMap = null,
) {
  const shipping = getActiveIntegration();
  const data =
    maps ||
    (await loadAttributedMapsForShipping(
      shipping?.id || (await resolveBostaShippingConnection()).id,
    ));
  const inventory =
    inventoryMap || (await require("./bostaFulfillment.service").fetchBostaInventoryAvailabilityMap());

  const requiredQty = Math.max(
    1,
    Number(line?.quantity ?? line?.variant?.quantity ?? 1) || 1,
  );

  const lineResult = resolveLineSkuForBosta(
    line,
    data,
    inventory,
    requiredQty,
  );

  if (!lineResult.ok) {
    throw buildInventoryUnavailableError([
      {
        productName: lineResult.productName,
        requiredQuantity: lineResult.requiredQuantity,
        candidateSkus: lineResult.candidateSkus || [],
        availableQuantity: lineResult.availableQuantity ?? 0,
        selectedSku: lineResult.selectedSku || null,
        mappingType: lineResult.mappingType,
        entityId: lineResult.entityId,
        reason: lineResult.reason,
      },
    ]);
  }

  return lineResult.skuCode;
}

async function validateOrderLinesInventory(localOrder) {
  const { fetchBostaInventoryAvailabilityMap } = require("./bostaFulfillment.service");
  const cartLines = Array.isArray(localOrder?.cart_items ?? localOrder?.cartItems)
    ? (localOrder.cart_items ?? localOrder.cartItems)
    : [];
  const shipping = getActiveIntegration() || (await resolveBostaShippingConnection());
  const sourceIntegrationId =
    localOrder?.source_integration_id ?? localOrder?.sourceIntegrationId ?? null;

  if (!cartLines.length) {
    return {
      items: [],
      inventoryMap: new Map(),
      maps: await loadAttributedMapsForShipping(shipping.id),
    };
  }

  const [maps, inventoryMap] = await Promise.all([
    loadAttributedMapsForShipping(shipping.id),
    fetchBostaInventoryAvailabilityMap(),
  ]);

  const unavailableProducts = [];
  const items = [];

  for (let index = 0; index < cartLines.length; index += 1) {
    const line = cartLines[index];
    const catalog = await resolveLineCatalogProduct(line, sourceIntegrationId);
    line._catalogProductId = catalog.id;
    line.catalogProductId = catalog.id;
    const requiredQty = Math.max(1, Number(line?.quantity) || 1);
    const lineResult = resolveLineSkuForBosta(line, maps, inventoryMap, requiredQty);

    if (!lineResult.ok) {
      unavailableProducts.push({
        productName: lineResult.productName,
        requiredQuantity: lineResult.requiredQuantity,
        candidateSkus: lineResult.candidateSkus || [],
        availableQuantity: lineResult.availableQuantity ?? 0,
        selectedSku: lineResult.selectedSku || null,
        mappingType: lineResult.mappingType,
        entityId: lineResult.entityId,
        reason: lineResult.reason,
      });
      continue;
    }

    items.push({
      lineIndex: index,
      skuCode: lineResult.skuCode,
      availableQuantity: lineResult.availableQuantity,
      productName: lineResult.productName,
      requiredQuantity: lineResult.requiredQuantity,
      source: lineResult.source,
    });
  }

  if (unavailableProducts.length) {
    throw buildInventoryUnavailableError(unavailableProducts);
  }

  return { items, inventoryMap, maps };
}

function buildSkusWithInventory(skus, inventoryDetailsMap, requiredQuantity = 1) {
  const qtyNeeded = Math.max(1, Number(requiredQuantity) || 1);
  return normalizeSkus(skus).map((skuCode) => {
    if (!inventoryDetailsMap) {
      return {
        skuCode,
        name: "",
        availableQuantity: null,
        inStock: true,
        inventoryKnown: false,
      };
    }
    const info = inventoryDetailsMap.get(skuCode);
    const availableQuantity = Number(info?.availableQuantity || 0);
    return {
      skuCode,
      name: info?.name || "",
      availableQuantity,
      inStock: availableQuantity >= qtyNeeded,
      inventoryKnown: true,
    };
  });
}

function pickRecommendedSku(skusWithInventory, requiredQuantity = 1) {
  const qtyNeeded = Math.max(1, Number(requiredQuantity) || 1);
  for (const item of skusWithInventory) {
    if (item.availableQuantity >= qtyNeeded) {
      return item;
    }
  }
  return null;
}

function buildOptionBase(row, inventoryDetailsMap, requiredQuantity, extra = {}) {
  const mappingName = String(row.name || "").trim();
  const skus = buildSkusWithInventory(row.skus, inventoryDetailsMap, requiredQuantity);
  const recommended = pickRecommendedSku(skus, requiredQuantity);
  return {
    mappingType: row.mapping_type,
    entityId: row.entity_id,
    catalogProductId: row.catalog_product_id || null,
    productId: row.catalog_product_id || row.product_id || row.entity_id,
    name: mappingName,
    label: mappingName,
    size: row.size || null,
    skus,
    recommendedSku: recommended?.skuCode ?? null,
    recommendedName: recommended?.name ?? null,
    recommendedAvailableQuantity: recommended?.availableQuantity ?? 0,
    inStock: Boolean(recommended),
    ...extra,
  };
}

function buildOptionsFromSizeRow(row, inventoryDetailsMap, requiredQuantity) {
  const sizes = normalizeSizes(row.sizes) || {};
  const baseName = String(row.name || "").trim();
  return Object.entries(sizes).map(([sizeKey, skus]) => {
    const mappingName = `${baseName}${sizeKey ? ` - ${sizeKey}` : ""}`.trim();
    const skusWithInventory = buildSkusWithInventory(
      skus,
      inventoryDetailsMap,
      requiredQuantity,
    );
    const recommended = pickRecommendedSku(skusWithInventory, requiredQuantity);
    return {
      mappingType: "size",
      entityId: row.entity_id,
      catalogProductId: row.catalog_product_id || null,
      productId: row.catalog_product_id || row.entity_id,
      name: mappingName,
      label: mappingName,
      size: sizeKey,
      skus: skusWithInventory,
      recommendedSku: recommended?.skuCode ?? null,
      recommendedName: recommended?.name ?? null,
      recommendedAvailableQuantity: recommended?.availableQuantity ?? 0,
      inStock: Boolean(recommended),
    };
  });
}

async function fetchMappingRowsForProduct(catalogProductId, shippingId) {
  const [mappingRows, unmappedRows] = await Promise.all([
    fetchAllMappingRows(),
    fetchUnmappedRows(),
  ]);
  const attributed = mappingRows.filter(
    (row) =>
      isAttributedToShipping(row, shippingId) &&
      String(row.catalog_product_id) === String(catalogProductId),
  );
  const unmapped =
    unmappedRows.find(
      (row) =>
        isAttributedToShipping(row, shippingId) &&
        String(row.catalog_product_id) === String(catalogProductId),
    ) || null;

  return {
    product:
      attributed.find((row) => row.mapping_type === "product") || null,
    variants: attributed.filter((row) => row.mapping_type === "variant"),
    size: attributed.find((row) => row.mapping_type === "size") || null,
    unmapped,
  };
}

/**
 * Catalog product UUID + selected Bosta account → mapping options + inventory.
 */
async function getBostaSkuOptionsForProduct(productId, options = {}) {
  const shipping = await resolveBostaShippingConnection(
    options.shippingIntegrationId || pickShippingIntegrationId(options),
  );
  const catalog = await resolveCatalogProduct({
    catalogProductId: productId,
    externalId: productId,
    sourceIntegrationId: options.sourceIntegrationId,
  });
  const id = catalog.id;

  const requiredQuantity = Math.max(1, Number(options.requiredQuantity) || 1);
  const rows = await fetchMappingRowsForProduct(id, shipping.id);
  const includeInventory = options.includeInventory === true;
  let inventoryDetailsMap = null;
  if (includeInventory) {
    const { fetchBostaInventoryDetailsMap } = require("./bostaFulfillment.service");
    const { runWithIntegration } = require("../utils/tenantScope");
    inventoryDetailsMap = await runWithIntegration(shipping, () =>
      fetchBostaInventoryDetailsMap(),
    );
  }

  const mappingOptions = [];

  if (rows.product) {
    mappingOptions.push(
      buildOptionBase(rows.product, inventoryDetailsMap, requiredQuantity),
    );
  }

  for (const variant of rows.variants) {
    mappingOptions.push(
      buildOptionBase(variant, inventoryDetailsMap, requiredQuantity),
    );
  }

  if (rows.size) {
    mappingOptions.push(
      ...buildOptionsFromSizeRow(rows.size, inventoryDetailsMap, requiredQuantity),
    );
  }

  if (!mappingOptions.length) {
    const err = new Error(
      rows.unmapped
        ? "Product is marked as unmapped for Bosta"
        : "No Bosta SKU mapping found for this product",
    );
    err.code = rows.unmapped ? "PRODUCT_UNMAPPED" : "PRODUCT_NOT_MAPPED";
    err.productId = id;
    err.catalogProductId = id;
    err.shippingIntegrationId = shipping.id;
    if (rows.unmapped) {
      err.unmapped = {
        productId: id,
        catalogProductId: id,
        name: rows.unmapped.name || "",
        reason: rows.unmapped.reason || "",
      };
    }
    throw err;
  }

  mappingOptions.sort((a, b) => {
    if (a.inStock !== b.inStock) return Number(b.inStock) - Number(a.inStock);
    return String(a.label).localeCompare(String(b.label), "ar");
  });

  const productName =
    rows.product?.name ||
    rows.variants[0]?.name?.split(" - ")[0] ||
    rows.size?.name ||
    "";

  return {
    productId: id,
    catalogProductId: id,
    shippingIntegrationId: shipping.id,
    productName: productName || catalog.name || "",
    requiredQuantity,
    options: mappingOptions,
    summary: {
      totalOptions: mappingOptions.length,
      inStockOptions: mappingOptions.filter((o) => o.inStock).length,
      outOfStockOptions: mappingOptions.filter((o) => !o.inStock).length,
    },
  };
}

module.exports = {
  MAPPING_TYPES,
  getBostaSkuMappings,
  getBostaSkuMapping,
  getBostaSkuMappingById,
  addBostaSkuMapping,
  updateBostaSkuMapping,
  updateBostaSkuMappingById,
  deleteBostaSkuMapping,
  deleteBostaSkuMappingById,
  deleteUnmappedProduct,
  importBostaSkuMappings,
  getBostaSkuOptionsForProduct,
  presentMappingRow,
  presentUnmappedRow,
  pickLineSelectedBostaSku,
  parseLineSkuOverrides,
  applyLineSkuOverridesToOrder,
  normalizeCartItemsBostaFields,
  resolveMappedSkuCandidatesForLine,
  resolveMappedBostaSkuForLine,
  validateOrderLinesInventory,
  pickPrimarySku,
};
