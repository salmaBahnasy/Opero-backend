const supabase = require("../config/tenantSupabase");
const { requireActiveCompanyId } = require("../utils/tenantScope");
const {
  sallaError,
  assertSallaConnection,
} = require("./sallaAuth.service");
const { sallaGetProducts, sallaGetProduct } = require("./sallaClient.service");

const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";
const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";

const PRODUCT_PAGE_SIZE = 50;
const MAX_PRODUCT_PAGES = 5;
const MAX_PRODUCT_DETAIL_FETCHES = 50;
const ORDER_RELINK_LIMIT = 500;

const SECRET_KEYS = new Set([
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "authorization",
  "Authorization",
  "webhook_secret",
  "webhookSecret",
  "signature",
  "client_secret",
  "clientSecret",
  "code",
  "oauth_code",
]);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asIdString(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    return asIdString(value.id ?? value.product_id ?? value.sku_id);
  }
  return String(value).trim();
}

function moneyString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") {
    return moneyString(value.amount ?? value.value ?? value.price);
  }
  const text = String(value).trim();
  return text || null;
}

function sanitizeMeta(value, depth = 0) {
  if (value == null || depth > 5) return value == null ? null : undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 80)
      .map((item) => sanitizeMeta(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    const clean = sanitizeMeta(nested, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function sallaExternalProductId(product) {
  return asIdString(product?.id);
}

function imageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  const obj = asObject(value);
  return firstNonEmpty(obj?.url, obj?.src, obj?.original, obj?.image);
}

function primaryImageUrl(product) {
  const images = Array.isArray(product?.images) ? product.images : [];
  const main = images.find((image) => image?.main || image?.is_default || image?.isMain);
  return firstNonEmpty(
    imageUrl(product?.main_image),
    imageUrl(product?.thumbnail),
    imageUrl(main),
    imageUrl(images[0]),
    imageUrl(product?.image),
  );
}

function statusSlug(product) {
  const status = product?.status;
  if (typeof status === "string") return status.trim().toLowerCase();
  const obj = asObject(status);
  return firstNonEmpty(obj?.slug, obj?.code, obj?.name).toLowerCase();
}

function isSallaProductActive(product) {
  const slug = statusSlug(product);
  if (slug === "hidden" || slug === "deleted" || slug === "draft" || slug === "inactive") {
    return false;
  }
  return true;
}

function unwrapProductList(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.data?.data)
      ? root.data.data
      : Array.isArray(root.products)
        ? root.products
        : [];
  const pagination = asObject(root.pagination) || asObject(root.data?.pagination) || {};
  return { list, pagination };
}

function declaredSkuCount(product, skus) {
  const declared = Number(
    product?.skus_count ??
      product?.sku_count ??
      product?.skusCount ??
      asObject(product?.quantities)?.skus,
  );
  if (Number.isFinite(declared) && declared >= 0) return declared;
  return Array.isArray(skus) ? skus.length : 0;
}

function optionValueMap(product) {
  const map = new Map();
  const options = Array.isArray(product?.options) ? product.options : [];
  for (const option of options) {
    const values = Array.isArray(option?.values) ? option.values : [];
    for (const value of values) {
      const id = asIdString(value?.id);
      if (!id) continue;
      map.set(id, {
        option_id: asIdString(option?.id) || null,
        option_name: firstNonEmpty(option?.name, option?.title) || null,
        value_id: id,
        value_name: firstNonEmpty(value?.name, value?.display_value, value?.label) || null,
      });
    }
  }
  return map;
}

function variationPropsForSku(product, sku, valueMap) {
  const related = Array.isArray(sku?.related_options)
    ? sku.related_options
    : Array.isArray(sku?.relatedOptions)
      ? sku.relatedOptions
      : [];
  const props = [];
  for (const relatedId of related) {
    const hit = valueMap.get(asIdString(relatedId));
    if (!hit) continue;
    props.push({
      variation: hit.option_name || "خيار",
      variation_prop: hit.value_name || asIdString(relatedId),
    });
  }
  if (props.length) return props;
  const selected = Array.isArray(sku?.selected_options) ? sku.selected_options : [];
  return selected
    .map((option) => ({
      variation: firstNonEmpty(option?.name, option?.option) || "خيار",
      variation_prop: firstNonEmpty(option?.value, option?.name) || null,
    }))
    .filter((option) => option.variation_prop);
}

function normalizeSallaVariant(sku, productId, product, valueMap) {
  const id = asIdString(sku?.id);
  const price = moneyString(sku?.price) || moneyString(sku?.regular_price);
  const salePrice = moneyString(sku?.sale_price) || moneyString(sku?.price) || price;
  const stock = Number(sku?.stock_quantity ?? sku?.quantity);
  const props = variationPropsForSku(product, sku, valueMap);
  const title =
    props.map((prop) => prop.variation_prop).filter(Boolean).join(" / ") ||
    firstNonEmpty(sku?.name, sku?.title, sku?.sku);
  return {
    id,
    product_id: productId,
    sku: firstNonEmpty(sku?.sku, sku?.barcode) || null,
    name: title || null,
    title: title || null,
    price,
    sale_price: salePrice,
    inventory_quantity: Number.isFinite(stock) ? stock : null,
    quantity: Number.isFinite(stock) ? stock : null,
    selected_options: props.map((prop) => ({
      name: prop.variation,
      value: prop.variation_prop,
    })),
    variation_props: props,
    related_options: Array.isArray(sku?.related_options)
      ? sku.related_options.map((value) => asIdString(value)).filter(Boolean)
      : [],
    image: imageUrl(sku?.image) || null,
    salla: {
      sku_id: id,
      barcode: firstNonEmpty(sku?.barcode) || null,
      is_default: Boolean(sku?.is_default),
    },
  };
}

function normalizeSallaProduct(product, { sourceIntegrationId, variants, variantsComplete }) {
  const productId = sallaExternalProductId(product);
  const name = firstNonEmpty(product?.name, product?.title);
  const image = primaryImageUrl(product);
  const firstSku = variants.find((variant) => variant.sku)?.sku || firstNonEmpty(product?.sku) || null;
  const firstPrice =
    variants.find((variant) => variant.price != null)?.price ||
    moneyString(product?.price) ||
    moneyString(product?.regular_price);
  const quantity = Number(product?.quantity ?? product?.sold_quantity);
  return {
    easyorder_id: productId,
    name: name || null,
    sku: firstSku,
    is_active: isSallaProductActive(product),
    raw_data: {
      name: name || null,
      title: name || null,
      sku: firstSku,
      price: firstPrice,
      sale_price: moneyString(product?.sale_price) || firstPrice,
      image: image || null,
      thumb: image || null,
      thumbnail: image || null,
      quantity: Number.isFinite(quantity) ? quantity : null,
      variants,
      provider: "salla",
      platform: "salla",
      source_integration_id: sourceIntegrationId,
      salla: sanitizeMeta({
        id: productId,
        status: statusSlug(product) || null,
        type: firstNonEmpty(product?.type) || null,
        sku: firstNonEmpty(product?.sku) || null,
        quantity: Number.isFinite(quantity) ? quantity : null,
        is_available: product?.is_available,
        urls: product?.urls || null,
        images: Array.isArray(product?.images)
          ? product.images.map((imageItem) => ({
              id: asIdString(imageItem?.id) || null,
              url: imageUrl(imageItem) || null,
              main: Boolean(imageItem?.main || imageItem?.is_default),
            }))
          : [],
        options: Array.isArray(product?.options) ? product.options : [],
        skus: Array.isArray(product?.skus) ? product.skus : [],
        variants_complete: Boolean(variantsComplete),
        variants_truncated: !variantsComplete,
      }),
    },
  };
}

async function findExistingSallaProduct(sourceIntegrationId, easyorderId) {
  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("*")
    .eq("source_integration_id", sourceIntegrationId)
    .eq("easyorder_id", String(easyorderId));
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length > 1) {
    const err = new Error("Multiple catalog rows match this Salla product id");
    err.code = "PRODUCT_AMBIGUOUS";
    throw err;
  }
  return rows[0] || null;
}

async function persistSallaProduct({ sourceIntegrationId, normalized }) {
  const existing = await findExistingSallaProduct(
    sourceIntegrationId,
    normalized.easyorder_id,
  );
  const syncedAt = new Date().toISOString();
  const payload = {
    easyorder_id: normalized.easyorder_id,
    source_integration_id: sourceIntegrationId,
    name: normalized.name,
    sku: normalized.sku,
    is_active: normalized.is_active,
    raw_data: normalized.raw_data,
    synced_at: syncedAt,
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from(PRODUCTS_TABLE)
      .update(payload)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: data.id, created: false, updated: true };
  }

  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .insert(payload)
    .select("id")
    .single();
  if (!error) {
    return { id: data.id, created: true, updated: false };
  }
  const dup =
    String(error.message || "").includes("duplicate") ||
    String(error.code || "") === "23505";
  if (!dup) throw new Error(error.message);

  const raced = await findExistingSallaProduct(
    sourceIntegrationId,
    normalized.easyorder_id,
  );
  if (!raced?.id) throw new Error(error.message);
  const { data: updated, error: updateError } = await supabase
    .from(PRODUCTS_TABLE)
    .update(payload)
    .eq("id", raced.id)
    .select("id")
    .single();
  if (updateError) throw new Error(updateError.message);
  return { id: updated.id, created: false, updated: true };
}

function cartProductId(line) {
  return asIdString(
    line?.product_id ||
      line?.productId ||
      line?.product?.id ||
      line?.product?.product_id,
  );
}

async function relinkSallaOrderCartItems(sourceIntegrationId) {
  const { data: catalog, error: catalogError } = await supabase
    .from(PRODUCTS_TABLE)
    .select("id, easyorder_id, source_integration_id")
    .eq("source_integration_id", sourceIntegrationId);
  if (catalogError) throw new Error(catalogError.message);

  const catalogByProductId = new Map();
  for (const row of catalog || []) {
    if (String(row.source_integration_id || "") !== String(sourceIntegrationId)) continue;
    const externalId = String(row.easyorder_id || "").trim();
    if (externalId && row.id) catalogByProductId.set(externalId, row.id);
  }
  if (!catalogByProductId.size) {
    return { relinked: 0, scanned: 0, hasMore: false };
  }

  const { data: orders, error: ordersError } = await supabase
    .from(ORDERS_TABLE)
    .select("id, raw_data, source_integration_id, ingestion_source")
    .eq("source_integration_id", sourceIntegrationId)
    .limit(ORDER_RELINK_LIMIT + 1);
  if (ordersError) throw new Error(ordersError.message);

  const list = orders || [];
  const hasMore = list.length > ORDER_RELINK_LIMIT;
  const bounded = hasMore ? list.slice(0, ORDER_RELINK_LIMIT) : list;
  let relinked = 0;

  for (const order of bounded) {
    if (String(order.source_integration_id || "") !== String(sourceIntegrationId)) continue;
    const ingestion = String(order.ingestion_source || "").toLowerCase();
    const raw =
      order.raw_data && typeof order.raw_data === "object" && !Array.isArray(order.raw_data)
        ? order.raw_data
        : {};
    const provider = String(raw.provider || raw.platform || "").toLowerCase();
    if (ingestion && ingestion !== "salla") continue;
    if (provider === "shopify" || provider === "easyorders" || provider === "easyorder") {
      continue;
    }
    if (ingestion !== "salla" && provider && provider !== "salla") continue;
    const cart = Array.isArray(raw.cart_items)
      ? raw.cart_items
      : Array.isArray(raw.cartItems)
        ? raw.cartItems
        : [];
    if (!cart.length) continue;

    let changed = false;
    const nextCart = cart.map((line) => {
      const productId = cartProductId(line);
      const catalogId = productId ? catalogByProductId.get(productId) : null;
      if (!catalogId) return line;
      if (String(line?.catalogProductId || line?.catalog_product_id || "") === String(catalogId)) {
        return line;
      }
      changed = true;
      return {
        ...line,
        catalogProductId: catalogId,
        catalog_product_id: catalogId,
      };
    });
    if (!changed) continue;

    const { error: updateError } = await supabase
      .from(ORDERS_TABLE)
      .update({
        raw_data: {
          ...raw,
          cart_items: nextCart,
          cartItems: nextCart,
        },
      })
      .eq("id", order.id);
    if (updateError) throw new Error(updateError.message);
    relinked += 1;
  }

  return { relinked, scanned: bounded.length, hasMore };
}

async function resolveCompleteProduct(integration, product, detailBudget) {
  let current = product;
  let skus = Array.isArray(current?.skus) ? current.skus : null;
  const productId = sallaExternalProductId(current);
  const declared = declaredSkuCount(current, skus || []);
  const needsDetail =
    !Array.isArray(skus) || (declared > 0 && skus.length < declared);

  if (needsDetail) {
    if (detailBudget.used >= MAX_PRODUCT_DETAIL_FETCHES) {
      return { product: current, skus: skus || [], complete: false, skipped: true };
    }
    detailBudget.used += 1;
    const fetched = await sallaGetProduct({
      integration,
      productId,
    });
    current = asObject(fetched.product) || current;
    skus = Array.isArray(current?.skus) ? current.skus : skus;
  }

  if (!Array.isArray(skus)) {
    return { product: current, skus: [], complete: false, skipped: true };
  }
  const finalDeclared = declaredSkuCount(current, skus);
  if (finalDeclared > skus.length) {
    return { product: current, skus, complete: false, skipped: true };
  }
  return { product: current, skus, complete: true, skipped: false };
}

async function syncSallaProducts({ integration, page } = {}) {
  const companyId = requireActiveCompanyId();
  const row = assertSallaConnection(integration, integration?.company_id || companyId);
  if (String(row.company_id) !== String(companyId)) {
    throw sallaError(
      "INTEGRATION_NOT_OWNED",
      "Integration connection does not belong to this company",
      403,
    );
  }

  const sourceIntegrationId = String(row.id);
  let currentPage = Math.max(1, Number(page) || 1);
  let pagesFetched = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  let lastPagination = {};
  const detailBudget = { used: 0 };

  while (pagesFetched < MAX_PRODUCT_PAGES) {
    const fetched = await sallaGetProducts({
      integration: row,
      page: currentPage,
      perPage: PRODUCT_PAGE_SIZE,
    });
    const { list, pagination } = unwrapProductList(fetched.payload);
    lastPagination = pagination;
    pagesFetched += 1;

    for (const item of list) {
      const productId = sallaExternalProductId(item);
      if (!productId) {
        skipped += 1;
        continue;
      }
      const resolved = await resolveCompleteProduct(row, item, detailBudget);
      if (resolved.skipped || !resolved.complete) {
        skipped += 1;
        errors.push({
          code: "SALLA_PRODUCT_VARIANTS_TRUNCATED",
          productId,
          message: "Salla variant/SKU set is incomplete and was not persisted",
        });
        continue;
      }
      const valueMap = optionValueMap(resolved.product);
      const variants = resolved.skus.map((sku) =>
        normalizeSallaVariant(sku, productId, resolved.product, valueMap),
      );
      const normalized = normalizeSallaProduct(resolved.product, {
        sourceIntegrationId,
        variants,
        variantsComplete: true,
      });
      const saved = await persistSallaProduct({
        sourceIntegrationId,
        normalized,
      });
      if (saved.created) created += 1;
      if (saved.updated) updated += 1;
    }

    const totalPages = Number(pagination.totalPages || pagination.total_pages || 0);
    const reportedPage = Number(pagination.currentPage || pagination.current_page || currentPage);
    const hasNext =
      (Number.isFinite(totalPages) && totalPages > 0 && reportedPage < totalPages) ||
      Boolean(asObject(pagination.links)?.next);
    if (!hasNext) break;
    currentPage = reportedPage + 1;
  }

  const totalPages = Number(lastPagination.totalPages || lastPagination.total_pages || 0);
  const reportedPage = Number(
    lastPagination.currentPage || lastPagination.current_page || currentPage,
  );
  const hasMore =
    (Number.isFinite(totalPages) && totalPages > 0 && reportedPage < totalPages) ||
    Boolean(asObject(lastPagination.links)?.next);
  const relink = await relinkSallaOrderCartItems(sourceIntegrationId);

  return {
    provider: "salla",
    integrationId: sourceIntegrationId,
    synced: created + updated,
    created,
    updated,
    skipped,
    hasMore,
    nextPage: hasMore ? reportedPage + 1 : null,
    pagesFetched,
    pageSize: PRODUCT_PAGE_SIZE,
    maxPages: MAX_PRODUCT_PAGES,
    relinkedOrders: relink.relinked,
    relinkHasMore: relink.hasMore,
    errors,
  };
}

module.exports = {
  syncSallaProducts,
  persistSallaProduct,
  relinkSallaOrderCartItems,
  normalizeSallaProduct,
  normalizeSallaVariant,
  findExistingSallaProduct,
  PRODUCT_PAGE_SIZE,
  MAX_PRODUCT_PAGES,
  MAX_PRODUCT_DETAIL_FETCHES,
  ORDER_RELINK_LIMIT,
};
