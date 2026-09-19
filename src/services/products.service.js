const crypto = require("crypto");

const supabase = require("../config/tenantSupabase");
const { clampListLimit, DEFAULT_LIST_LIMIT } = require("../utils/listPagination");
const {
  unwrapEasyOrdersDetails,
} = require("./easyorderCatalog.service");

const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";
const PRODUCT_SOURCE_CONFLICT = "company_id,source_integration_id,easyorder_id";
const PRODUCT_LIST_SELECT =
  "id,company_id,easyorder_id,name,sku,is_active,source_integration_id,synced_at,created_at,updated_at,raw_data";

function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function parseRawData(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function pickFirst(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "") continue;
    return text;
  }
  return null;
}

function presentProduct(row, live = null) {
  if (!row) return null;
  const rd = parseRawData(row.raw_data);
  const liveRd = unwrapEasyOrdersDetails(live);
  const thumb = pickFirst(
    rd.thumb,
    rd.thumbnail,
    rd.image,
    rd.image_url,
    liveRd.thumb,
    liveRd.thumbnail,
    liveRd.image,
    liveRd.image_url,
  );
  const variants = Array.isArray(liveRd.variants)
    ? liveRd.variants
    : Array.isArray(rd.variants)
      ? rd.variants
      : [];
  const price = pickFirst(rd.price, rd.sale_price, liveRd.price, liveRd.sale_price);
  const quantity = pickFirst(rd.quantity, liveRd.quantity);

  return {
    ...row,
    source_integration_id: row.source_integration_id ?? null,
    name: pickFirst(row.name, rd.name, rd.title, liveRd.name, liveRd.title),
    sku: pickFirst(row.sku, rd.sku, liveRd.sku),
    price: price != null ? Number(price) || 0 : null,
    sale_price:
      liveRd.sale_price != null || rd.sale_price != null
        ? Number(liveRd.sale_price ?? rd.sale_price) || 0
        : null,
    quantity: quantity != null ? Number(quantity) || 0 : null,
    thumb: thumb || "",
    thumbnail: thumb || "",
    variants,
    warranty: pickFirst(rd.warranty, liveRd.warranty, rd.warranty_label),
    warranty_years: rd.warranty_years ?? liveRd.warranty_years ?? null,
  };
}

function presentProductList(row) {
  const presented = presentProduct(row);
  if (!presented) return null;
  const {
    raw_data: _raw,
    variants: _variants,
    company_id: _companyId,
    ...safe
  } = presented;
  return safe;
}

function presentProductOption(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: String(row.name || "").trim(),
    sku: String(row.sku || "").trim(),
    source_integration_id: row.source_integration_id ?? null,
    easyorder_id: row.easyorder_id ?? null,
  };
}

const PRODUCT_OPTIONS_SELECT =
  "id,easyorder_id,name,sku,source_integration_id";
const PRODUCT_OPTIONS_DEFAULT_LIMIT = 40;

function normalizeProductsPayload(apiBody) {
  if (!apiBody) return [];
  if (Array.isArray(apiBody)) return apiBody;

  const candidates = [
    apiBody.data,
    apiBody.products,
    apiBody.items,
    apiBody.results,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  return [];
}

function resolveEasyorderProductId(item) {
  if (!item || typeof item !== "object") return null;

  const id =
    item.id ??
    item.product_id ??
    item.productId ??
    item.sku ??
    item.code;

  if (id == null) return null;

  const s = String(id).trim();
  return s || null;
}

function stripClientTenantFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const {
    companyId,
    company_id,
    company,
    source_integration_id,
    sourceIntegrationId,
    id,
    ...rest
  } = body;
  return rest;
}

function buildManualRawData(input, existing = {}) {
  const rd = parseRawData(existing);
  const thumb = String(input.thumb ?? input.thumbnail ?? input.image ?? "").trim();
  return {
    ...rd,
    name: String(input.name ?? "").trim(),
    sku: String(input.sku ?? "").trim(),
    price: Number(input.price) || 0,
    quantity: Number(input.quantity) || 0,
    ...(thumb
      ? { thumb, thumbnail: thumb, image: thumb }
      : {}),
  };
}

async function syncProductsFromEasyOrder(easyOrderPayload, { sourceIntegrationId } = {}) {
  const sourceId = String(sourceIntegrationId || "").trim();
  if (!sourceId) {
    throw serviceError(
      "SOURCE_INTEGRATION_REQUIRED",
      "source_integration_id is required to sync products",
      400,
    );
  }

  const items = normalizeProductsPayload(easyOrderPayload);

  if (!items.length) {
    return { inserted: 0, updated: 0, skipped: 0, total: 0, synced: 0 };
  }

  const rows = [];
  let skipped = 0;

  for (const item of items) {
    let easyorderId = resolveEasyorderProductId(item);

    if (!easyorderId) {
      easyorderId = `hash-${crypto
        .createHash("sha1")
        .update(JSON.stringify(item))
        .digest("hex")}`;
      skipped += 1;
    }

    const name =
      item.name ??
      item.title ??
      item.product_name ??
      null;

    rows.push({
      easyorder_id: easyorderId,
      source_integration_id: sourceId,
      name,
      sku: item.sku ?? item.variant_sku ?? null,
      raw_data: item,
      synced_at: new Date().toISOString(),
    });
  }

  const { error } = await supabase.from(PRODUCTS_TABLE).upsert(rows, {
    onConflict: PRODUCT_SOURCE_CONFLICT,
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    synced: rows.length,
    skippedNoId: skipped,
    totalFromApi: items.length,
    source_integration_id: sourceId,
  };
}

async function getProductsFromDb({
  page = 1,
  limit = DEFAULT_LIST_LIMIT,
  search,
  source_integration_id,
} = {}) {
  const safeLimit = clampListLimit(limit);
  const safePage = Math.max(1, Number(page) || 1);
  const fromIndex = (safePage - 1) * safeLimit;
  const toIndex = fromIndex + safeLimit - 1;

  let query = supabase
    .from(PRODUCTS_TABLE)
    .select(PRODUCT_LIST_SELECT, { count: "exact" })
    .order("synced_at", { ascending: false })
    .range(fromIndex, toIndex);

  if (source_integration_id) {
    query = query.eq("source_integration_id", source_integration_id);
  }

  const q = search && String(search).trim();
  if (q) {
    const pattern = `%${q}%`;
    query = query.or(
      `name.ilike.${pattern},sku.ilike.${pattern},easyorder_id.ilike.${pattern}`,
    );
  }

  const { data, count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const total = count || 0;

  return {
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.ceil(total / safeLimit) || 1,
    data: (data || []).map((row) => presentProductList(row)),
  };
}

async function getProductOptionsFromDb({
  search,
  q,
  limit = PRODUCT_OPTIONS_DEFAULT_LIMIT,
  source_integration_id,
  ids,
} = {}) {
  const safeLimit = clampListLimit(limit, {
    fallback: PRODUCT_OPTIONS_DEFAULT_LIMIT,
  });
  const needle = String(search || q || "").trim();
  const keepIds = Array.isArray(ids)
    ? ids.map((id) => String(id || "").trim()).filter(Boolean)
    : String(ids || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

  if (!needle) {
    if (!keepIds.length) return { limit: safeLimit, data: [] };
    const { data, error } = await supabase
      .from(PRODUCTS_TABLE)
      .select(PRODUCT_OPTIONS_SELECT)
      .in("id", keepIds);
    if (error) throw new Error(error.message);
    return {
      limit: safeLimit,
      data: (data || []).map((row) => presentProductOption(row)).filter(Boolean),
    };
  }

  let query = supabase
    .from(PRODUCTS_TABLE)
    .select(PRODUCT_OPTIONS_SELECT)
    .order("name", { ascending: true })
    .limit(safeLimit);

  if (source_integration_id) {
    query = query.eq("source_integration_id", source_integration_id);
  }

  if (needle) {
    const pattern = `%${needle}%`;
    query = query.or(
      `name.ilike.${pattern},sku.ilike.${pattern},easyorder_id.ilike.${pattern}`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data || []).map((row) => presentProductOption(row)).filter(Boolean);
  if (!keepIds.length) {
    return { limit: safeLimit, data: rows };
  }

  const have = new Set(rows.map((row) => String(row.id)));
  const missing = keepIds.filter((id) => !have.has(id));
  if (missing.length) {
    const { data: extra, error: extraError } = await supabase
      .from(PRODUCTS_TABLE)
      .select(PRODUCT_OPTIONS_SELECT)
      .in("id", missing);
    if (extraError) throw new Error(extraError.message);
    for (const row of extra || []) {
      const option = presentProductOption(row);
      if (option) rows.unshift(option);
    }
  }
  return { limit: safeLimit, data: rows.slice(0, Math.max(safeLimit, keepIds.length)) };
}

async function getProductFromDb(productId, { source_integration_id } = {}) {
  const id = String(productId || "").trim();
  if (!id) {
    throw serviceError("INVALID_PRODUCT_ID", "product_id is required", 400);
  }

  const { data: byId, error: byIdError } = await supabase
    .from(PRODUCTS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (byIdError) throw new Error(byIdError.message);
  if (byId) return byId;

  let query = supabase
    .from(PRODUCTS_TABLE)
    .select("*")
    .eq("easyorder_id", id);

  if (source_integration_id) {
    query = query.eq("source_integration_id", source_integration_id);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length > 1) {
    throw serviceError(
      "PRODUCT_AMBIGUOUS",
      "Multiple catalog rows match this product id. Pass source_integration_id.",
      409,
    );
  }
  return rows[0] || null;
}

async function createLocalProduct(body = {}) {
  const input = stripClientTenantFields(body);
  const name = String(input.name ?? input.title ?? "").trim();
  const sku = String(input.sku ?? input.code ?? "").trim();
  if (!name || !sku) {
    throw serviceError("INVALID_PRODUCT", "name and sku are required", 400);
  }
  if (input.price === "" || input.price == null || Number.isNaN(Number(input.price))) {
    throw serviceError("INVALID_PRODUCT", "price is required", 400);
  }

  const easyorderId = sku;
  const { data: existing, error: existingError } = await supabase
    .from(PRODUCTS_TABLE)
    .select("id")
    .eq("easyorder_id", easyorderId)
    .is("source_integration_id", null)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing) {
    throw serviceError(
      "PRODUCT_CONFLICT",
      "A local product with this SKU already exists",
      409,
    );
  }

  const raw_data = buildManualRawData(input);
  const payload = {
    easyorder_id: easyorderId,
    source_integration_id: null,
    name,
    sku,
    is_active: input.is_active !== false,
    raw_data,
    synced_at: null,
  };

  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .insert(payload)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return presentProduct(data);
}

async function updateLocalProduct(productId, body = {}) {
  const existing = await getProductFromDb(productId);
  if (!existing) {
    throw serviceError("PRODUCT_NOT_FOUND", "Product not found", 404);
  }

  const input = stripClientTenantFields(body);
  const name = input.name != null || input.title != null
    ? String(input.name ?? input.title ?? "").trim()
    : existing.name;
  const sku = input.sku != null || input.code != null
    ? String(input.sku ?? input.code ?? "").trim()
    : existing.sku;
  if (!name || !sku) {
    throw serviceError("INVALID_PRODUCT", "name and sku are required", 400);
  }
  if (
    input.price !== undefined &&
    (input.price === "" || Number.isNaN(Number(input.price)))
  ) {
    throw serviceError("INVALID_PRODUCT", "price is required", 400);
  }

  const raw_data = buildManualRawData(
    {
      name,
      sku,
      price: input.price ?? parseRawData(existing.raw_data).price,
      quantity: input.quantity ?? parseRawData(existing.raw_data).quantity,
      thumb: input.thumb ?? input.thumbnail ?? input.image,
    },
    existing.raw_data,
  );

  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .update({
      name,
      sku,
      raw_data,
      ...(input.is_active != null ? { is_active: input.is_active !== false } : {}),
    })
    .eq("id", existing.id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw serviceError("PRODUCT_NOT_FOUND", "Product not found", 404);
  }
  return presentProduct(data);
}

async function deleteLocalProduct(productId) {
  const existing = await getProductFromDb(productId);
  if (!existing) {
    throw serviceError("PRODUCT_NOT_FOUND", "Product not found", 404);
  }

  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .delete()
    .eq("id", existing.id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw serviceError("PRODUCT_NOT_FOUND", "Product not found", 404);
  }
  return { id: existing.id };
}

module.exports = {
  syncProductsFromEasyOrder,
  getProductsFromDb,
  getProductOptionsFromDb,
  getProductFromDb,
  createLocalProduct,
  updateLocalProduct,
  deleteLocalProduct,
  presentProduct,
  presentProductList,
  presentProductOption,
  PRODUCT_LIST_SELECT,
  PRODUCT_OPTIONS_SELECT,
  PRODUCTS_TABLE,
  PRODUCT_SOURCE_CONFLICT,
};
