const supabase = require("../config/tenantSupabase");
const { requireActiveCompanyId } = require("../utils/tenantScope");
const { shopifyGraphql, assertShopifyIntegration } = require("./shopify.service");
const { numericShopifyId } = require("./shopifyOrders.service");
const {
  writeShopifyCatalogDualWrite,
  emptyCanonicalAggregates,
  addCanonicalAggregate,
} = require("./catalogShopifyDualWrite.service");

const PRODUCTS_TABLE = process.env.SUPABASE_PRODUCTS_TABLE || "products";
const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";

const PRODUCT_PAGE_SIZE = 50;
const VARIANT_PAGE_SIZE = 100;
const MAX_PRODUCT_PAGES = 5;
const MAX_VARIANT_PAGES = 10;
const ORDER_RELINK_LIMIT = 500;

const SHOPIFY_PRODUCTS_QUERY = `query ShopifyProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      legacyResourceId
      title
      handle
      status
      vendor
      productType
      createdAt
      updatedAt
      featuredMedia {
        preview {
          image {
            url
          }
        }
      }
      variants(first: ${VARIANT_PAGE_SIZE}) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          legacyResourceId
          title
          sku
          price
          inventoryQuantity
          selectedOptions {
            name
            value
          }
          image {
            url
          }
        }
      }
    }
  }
}`;

const SHOPIFY_PRODUCT_VARIANTS_QUERY = `query ShopifyProductVariants($id: ID!, $first: Int!, $after: String) {
  product(id: $id) {
    id
    variants(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        legacyResourceId
        title
        sku
        price
        inventoryQuantity
        selectedOptions {
          name
          value
        }
        image {
          url
        }
      }
    }
  }
}`;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function moneyString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value).trim();
  return text || null;
}

function connectionNodes(connection) {
  if (!connection || typeof connection !== "object") return [];
  if (Array.isArray(connection.nodes)) return connection.nodes;
  if (Array.isArray(connection.edges)) {
    return connection.edges
      .map((edge) => edge?.node)
      .filter((node) => node && typeof node === "object");
  }
  return [];
}

function featuredImageUrl(node) {
  return firstNonEmpty(
    node?.featuredMedia?.preview?.image?.url,
    node?.featuredMedia?.image?.url,
    node?.featuredImage?.url,
    node?.image?.url,
  );
}

function normalizeSelectedOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => ({
      name: firstNonEmpty(option?.name) || null,
      value: firstNonEmpty(option?.value) || null,
    }))
    .filter((option) => option.name || option.value);
}

function normalizeShopifyVariant(node, productId) {
  const gid = firstNonEmpty(node?.id);
  const id = numericShopifyId(node?.legacyResourceId || node?.id);
  const selectedOptions = normalizeSelectedOptions(node?.selectedOptions);
  const price = moneyString(node?.price);
  const inventory =
    node?.inventoryQuantity == null || node?.inventoryQuantity === ""
      ? null
      : Number(node.inventoryQuantity);
  return {
    id,
    product_id: productId,
    title: firstNonEmpty(node?.title) || null,
    sku: firstNonEmpty(node?.sku) || null,
    price,
    sale_price: price,
    inventory_quantity: Number.isFinite(inventory) ? inventory : null,
    quantity: Number.isFinite(inventory) ? inventory : null,
    selected_options: selectedOptions,
    variation_props: selectedOptions.map((option) => ({
      variation: option.name,
      variation_prop: option.value,
    })),
    image: firstNonEmpty(node?.image?.url) || null,
    admin_graphql_api_id: gid || null,
    gid: gid || null,
    shopify: {
      variant_id: id,
      gid: gid || null,
      legacy_resource_id: numericShopifyId(node?.legacyResourceId) || id,
    },
  };
}

function normalizeShopifyProduct(node, { sourceIntegrationId, variants, variantsComplete }) {
  const gid = firstNonEmpty(node?.id);
  const productId = numericShopifyId(node?.legacyResourceId || node?.id);
  const title = firstNonEmpty(node?.title);
  const status = firstNonEmpty(node?.status).toUpperCase();
  const image = featuredImageUrl(node);
  const firstSku = variants.find((variant) => variant.sku)?.sku || null;
  const firstPrice = variants.find((variant) => variant.price != null)?.price || null;
  return {
    easyorder_id: productId,
    name: title || null,
    sku: firstSku,
    is_active: status === "ACTIVE" || status === "",
    raw_data: {
      name: title || null,
      title: title || null,
      sku: firstSku,
      price: firstPrice,
      image: image || null,
      thumb: image || null,
      thumbnail: image || null,
      variants,
      provider: "shopify",
      shopify: {
        product_id: productId,
        gid: gid || null,
        handle: firstNonEmpty(node?.handle) || null,
        status: status || null,
        vendor: firstNonEmpty(node?.vendor) || null,
        productType: firstNonEmpty(node?.productType) || null,
        createdAt: firstNonEmpty(node?.createdAt) || null,
        updatedAt: firstNonEmpty(node?.updatedAt) || null,
        variants_complete: Boolean(variantsComplete),
        variants_truncated: !variantsComplete,
      },
    },
  };
}

async function fetchRemainingVariants({
  integration,
  secrets,
  productGid,
  after,
  collected,
}) {
  let cursor = after || null;
  let complete = true;
  for (let page = 0; page < MAX_VARIANT_PAGES; page += 1) {
    const payload = await shopifyGraphql({
      integration,
      secrets,
      query: SHOPIFY_PRODUCT_VARIANTS_QUERY,
      variables: {
        id: productGid,
        first: VARIANT_PAGE_SIZE,
        after: cursor,
      },
    });
    const connection = payload?.data?.product?.variants || {};
    collected.push(...connectionNodes(connection));
    if (!connection?.pageInfo?.hasNextPage) {
      return { variants: collected, complete: true };
    }
    cursor = connection.pageInfo.endCursor || null;
    if (!cursor) {
      complete = false;
      break;
    }
  }
  return { variants: collected, complete: false };
}

async function loadProductPage({ integration, secrets, after }) {
  const payload = await shopifyGraphql({
    integration,
    secrets,
    query: SHOPIFY_PRODUCTS_QUERY,
    variables: {
      first: PRODUCT_PAGE_SIZE,
      after: after || null,
    },
  });
  return payload?.data?.products || { nodes: [], pageInfo: {} };
}

async function findExistingShopifyProduct(sourceIntegrationId, easyorderId) {
  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("*")
    .eq("source_integration_id", sourceIntegrationId)
    .eq("easyorder_id", String(easyorderId));
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length > 1) {
    const err = new Error(
      "Multiple catalog rows match this Shopify product id",
    );
    err.code = "PRODUCT_AMBIGUOUS";
    throw err;
  }
  return rows[0] || null;
}

async function persistShopifyProduct({
  sourceIntegrationId,
  normalized,
}) {
  const existing = await findExistingShopifyProduct(
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
  if (error) throw new Error(error.message);
  return { id: data.id, created: true, updated: false };
}

function cartProductId(line) {
  return numericShopifyId(
    line?.product_id ||
      line?.productId ||
      line?.product?.id ||
      line?.product?.product_id,
  );
}

async function relinkShopifyOrderCartItems(sourceIntegrationId) {
  const { data: catalog, error: catalogError } = await supabase
    .from(PRODUCTS_TABLE)
    .select("id, easyorder_id, source_integration_id")
    .eq("source_integration_id", sourceIntegrationId);
  if (catalogError) throw new Error(catalogError.message);

  const catalogByProductId = new Map();
  for (const row of catalog || []) {
    if (String(row.source_integration_id || "") !== String(sourceIntegrationId)) {
      continue;
    }
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
    if (String(order.source_integration_id || "") !== String(sourceIntegrationId)) {
      continue;
    }
    const ingestion = String(order.ingestion_source || "").toLowerCase();
    const raw =
      order.raw_data && typeof order.raw_data === "object" && !Array.isArray(order.raw_data)
        ? order.raw_data
        : {};
    if (ingestion && ingestion !== "shopify") continue;
    if (String(raw.provider || raw.platform || "").toLowerCase() === "easyorders") {
      continue;
    }
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

function publicCanonicalProduct(result, { legacyStatus } = {}) {
  if (!result) return null;
  return {
    legacyProductId: result.legacyProductId || null,
    externalProductId: result.externalProductId || null,
    legacyStatus: legacyStatus || null,
    canonicalStatus: result.canonicalStatus,
    diagnostics: result.diagnostics || [],
    canonicalResult: result.canonicalResult || null,
    canonicalError: result.canonicalError || null,
  };
}

async function syncShopifyProducts({
  integration,
  secrets,
  cursor,
  catalogWriter,
  canonicalStateLoader,
  dualWriteEnv,
  persistProduct,
} = {}) {
  const companyId = requireActiveCompanyId();
  const resolved = assertShopifyIntegration(integration, secrets);
  if (String(integration.company_id || companyId) !== String(companyId)) {
    const err = new Error("Integration connection is not owned by this company");
    err.code = "INTEGRATION_NOT_OWNED";
    throw err;
  }

  const sourceIntegrationId = String(integration.id);
  let after = firstNonEmpty(cursor) || null;
  let pageCount = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  const canonicalProducts = [];
  const canonicalAggregates = emptyCanonicalAggregates();
  let lastPageInfo = { hasNextPage: false, endCursor: null };

  while (pageCount < MAX_PRODUCT_PAGES) {
    const connection = await loadProductPage({
      integration,
      secrets,
      after,
    });
    lastPageInfo = connection.pageInfo || {};
    const nodes = connectionNodes(connection);
    pageCount += 1;

    for (const node of nodes) {
      const productId = numericShopifyId(node?.legacyResourceId || node?.id);
      if (!productId) {
        skipped += 1;
        continue;
      }
      let variantNodes = connectionNodes(node.variants);
      let variantsComplete = !node?.variants?.pageInfo?.hasNextPage;
      if (!variantsComplete) {
        const extra = await fetchRemainingVariants({
          integration,
          secrets,
          productGid: node.id,
          after: node.variants.pageInfo.endCursor,
          collected: variantNodes,
        });
        variantNodes = extra.variants;
        variantsComplete = extra.complete;
      }
      const variants = variantNodes.map((variant) =>
        normalizeShopifyVariant(variant, productId),
      );
      const normalized = normalizeShopifyProduct(node, {
        sourceIntegrationId,
        variants,
        variantsComplete,
      });

      let saved = null;
      let legacyStatus = "failed";
      const persist = typeof persistProduct === "function" ? persistProduct : persistShopifyProduct;
      try {
        saved = await persist({
          sourceIntegrationId,
          normalized,
        });
        if (saved.created) {
          created += 1;
          legacyStatus = "created";
        } else if (saved.updated) {
          updated += 1;
          legacyStatus = "updated";
        } else {
          legacyStatus = "updated";
        }
      } catch (error) {
        errors.push({
          code: error.code || "SHOPIFY_PRODUCT_PERSIST_FAILED",
          productId,
          message: error.message || "Failed to persist Shopify product",
        });
        canonicalProducts.push(
          publicCanonicalProduct(
            {
              legacyProductId: null,
              externalProductId: productId,
              canonicalStatus: "not_attempted",
              diagnostics: [],
              canonicalResult: null,
              canonicalError: null,
            },
            { legacyStatus: "failed" },
          ),
        );
        continue;
      }

      if (!variantsComplete) {
        errors.push({
          code: "SHOPIFY_VARIANTS_TRUNCATED",
          productId,
          message: "Not all Shopify variants were fetched for this product",
        });
      }

      const dual = await writeShopifyCatalogDualWrite({
        companyId,
        integration,
        productId: saved.id,
        externalProductId: productId,
        normalized,
        variantsComplete,
        catalogWriter,
        canonicalStateLoader,
        env: dualWriteEnv,
      });
      addCanonicalAggregate(canonicalAggregates, dual);
      canonicalProducts.push(publicCanonicalProduct(dual, { legacyStatus }));
      if (dual.canonicalStatus === "failed" && dual.canonicalError) {
        errors.push({
          code: dual.canonicalError.code,
          productId,
          message: dual.canonicalError.message,
        });
      }
    }

    if (!lastPageInfo.hasNextPage) {
      after = lastPageInfo.endCursor || null;
      break;
    }
    after = lastPageInfo.endCursor || null;
    if (!after) break;
  }

  const hasMore = Boolean(lastPageInfo.hasNextPage && after);
  const relink = await relinkShopifyOrderCartItems(sourceIntegrationId);

  return {
    provider: "shopify",
    integrationId: sourceIntegrationId,
    shopDomain: resolved.shopDomain,
    synced: created + updated,
    created,
    updated,
    skipped,
    hasMore,
    nextCursor: hasMore ? after : null,
    pagesFetched: pageCount,
    pageSize: PRODUCT_PAGE_SIZE,
    maxPages: MAX_PRODUCT_PAGES,
    relinkedOrders: relink.relinked,
    relinkHasMore: relink.hasMore,
    errors,
    canonicalSuccess: canonicalAggregates.canonicalSuccess,
    canonicalFailed: canonicalAggregates.canonicalFailed,
    canonicalBlocked: canonicalAggregates.canonicalBlocked,
    canonicalSkipped: canonicalAggregates.canonicalSkipped,
    canonicalProducts,
  };
}

module.exports = {
  syncShopifyProducts,
  persistShopifyProduct,
  relinkShopifyOrderCartItems,
  normalizeShopifyProduct,
  normalizeShopifyVariant,
  SHOPIFY_PRODUCTS_QUERY,
  SHOPIFY_PRODUCT_VARIANTS_QUERY,
  PRODUCT_PAGE_SIZE,
  VARIANT_PAGE_SIZE,
  MAX_PRODUCT_PAGES,
  MAX_VARIANT_PAGES,
  ORDER_RELINK_LIMIT,
};
