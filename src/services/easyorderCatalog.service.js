/**
 * EasyOrders catalog enrichment (C1E).
 *
 * LIST + optional DETAILS → provider-neutral normalized products.
 * Pure planner remains in catalogBackfill.service.js (no network).
 *
 * This module must NOT write Migration-013 catalog tables.
 * Legacy list sync (syncProductsFromEasyOrder) is unchanged and does not
 * call this N+1 path.
 */

const crypto = require("crypto");

const SEVERITY = {
  INFO: "INFO",
  WARNING: "WARNING",
  ERROR: "ERROR",
};

const DIAGNOSTIC = {
  DETAILS_REQUIRED: "EASYORDERS_DETAILS_REQUIRED",
  DETAILS_FAILED: "EASYORDERS_DETAILS_FAILED",
  DETAILS_TIMEOUT: "EASYORDERS_DETAILS_TIMEOUT",
  RATE_LIMITED: "EASYORDERS_RATE_LIMITED",
  AUTH_INVALID: "EASYORDERS_AUTH_INVALID",
  VARIANT_ID_MISSING: "EASYORDERS_VARIANT_ID_MISSING",
  VARIANTS_INCOMPLETE: "EASYORDERS_VARIANTS_INCOMPLETE",
};

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CONCURRENCY = 3;
const MAX_BACKOFF_MS = 2000;

function diagnostic(code, severity, message, extra = {}) {
  const row = { code, severity, message };
  if (extra.http_status != null) row.http_status = extra.http_status;
  return row;
}

function trimText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/** Same unwrap semantics as presentProduct(local, live). */
function unwrapEasyOrdersDetails(live) {
  if (!live || typeof live !== "object") return {};
  const liveRoot =
    live.data && typeof live.data === "object"
      ? live.data
      : live.product && typeof live.product === "object"
        ? live.product
        : live;
  return liveRoot && typeof liveRoot === "object" && !Array.isArray(liveRoot)
    ? liveRoot
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

function parseNumeric(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Preserve current products.easyorder_id identity:
 * id → product_id → productId → sku → code → hash fallback.
 */
function resolveEasyOrdersExternalProductId(item) {
  if (!item || typeof item !== "object") return null;
  const id =
    item.id ?? item.product_id ?? item.productId ?? item.sku ?? item.code;
  if (id == null) return null;
  const text = String(id).trim();
  return text || null;
}

function hashFallbackProductId(item) {
  return `hash-${crypto
    .createHash("sha1")
    .update(JSON.stringify(item ?? {}))
    .digest("hex")}`;
}

function productTitle(source) {
  return pickFirst(source?.name, source?.title, source?.product_name);
}

function productSku(source) {
  return pickFirst(source?.sku, source?.variant_sku);
}

function productPrice(source) {
  return parseNumeric(pickFirst(source?.sale_price, source?.price));
}

function productQuantity(source) {
  return parseNumeric(source?.quantity);
}

function productImage(source) {
  return pickFirst(
    source?.thumb,
    source?.thumbnail,
    source?.image,
    source?.image_url,
  );
}

function variantExternalId(variant) {
  return trimText(variant?.id);
}

function extractOptionPairs(variant) {
  const pairs = [];
  const selected = Array.isArray(variant?.selected_options)
    ? variant.selected_options
    : null;
  if (selected) {
    for (const option of selected) {
      if (!option || typeof option !== "object") continue;
      const name = trimText(option.name ?? option.option);
      const value = trimText(option.value ?? option.variation_prop);
      if (name || value) pairs.push({ name, value });
    }
    if (pairs.length) return pairs;
  }

  const props = Array.isArray(variant?.variation_props)
    ? variant.variation_props
    : [];
  for (const prop of props) {
    if (!prop || typeof prop !== "object") continue;
    pairs.push({
      name: trimText(prop.variation ?? prop.name),
      value: trimText(prop.variation_prop ?? prop.value),
    });
  }
  return pairs;
}

function inspectVariants(source) {
  if (!source || typeof source !== "object") {
    return {
      present: false,
      malformed: false,
      empty: true,
      items: [],
      missingIds: 0,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(source, "variants")) {
    return {
      present: false,
      malformed: false,
      empty: true,
      items: [],
      missingIds: 0,
    };
  }
  if (!Array.isArray(source.variants)) {
    return {
      present: true,
      malformed: true,
      empty: true,
      items: [],
      missingIds: 0,
    };
  }
  const items = source.variants;
  const objects = items.filter(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
  );
  const malformed = objects.length !== items.length;
  const missingIds = objects.filter((entry) => !variantExternalId(entry)).length;
  return {
    present: true,
    malformed,
    empty: items.length === 0,
    items,
    objects,
    missingIds,
  };
}

function listNeedsDetails(listItem) {
  const inspect = inspectVariants(listItem);
  if (!inspect.present) return { needed: true, reason: "missing" };
  if (inspect.malformed) return { needed: true, reason: "malformed" };
  if (inspect.empty) return { needed: true, reason: "empty" };
  if (inspect.missingIds > 0) return { needed: true, reason: "missing_ids" };
  return { needed: false, reason: "complete" };
}

function classifyDetailsError(error) {
  const status = error?.response?.status ?? error?.status ?? error?.statusCode;
  const code = String(error?.code || "");
  const providerMessage = trimText(
    error?.response?.data?.message || error?.providerMessage || "",
  );
  const message = trimText(error?.message);
  const combined = `${providerMessage} ${message}`.toLowerCase();
  const invalidKey =
    /api-key not valid|invalid api[_ -]?key|unauthorized|forbidden/.test(
      combined,
    );

  const timeout =
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    /timeout/i.test(message);

  if (status === 401 || status === 403 || invalidKey) {
    return {
      kind: "auth",
      retryable: false,
      diagnosticCode: DIAGNOSTIC.AUTH_INVALID,
      http_status: status || 401,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      diagnosticCode: DIAGNOSTIC.RATE_LIMITED,
      http_status: 429,
    };
  }
  if (timeout) {
    return {
      kind: "timeout",
      retryable: true,
      diagnosticCode: DIAGNOSTIC.DETAILS_TIMEOUT,
      http_status: status || null,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      kind: "transient",
      retryable: true,
      diagnosticCode: DIAGNOSTIC.DETAILS_FAILED,
      http_status: status,
    };
  }
  return {
    kind: "permanent",
    retryable: false,
    diagnosticCode: DIAGNOSTIC.DETAILS_FAILED,
    http_status: status || null,
  };
}

function backoffMs(attempt) {
  return Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS);
}

function parseRetryAfterMs(header) {
  const raw = trimText(header);
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 10000);
  }
  return null;
}

function sanitizeErrorMessage(error) {
  const raw = trimText(error?.response?.data?.message || error?.message);
  if (/api-key|token|secret|bearer|authorization/i.test(raw)) {
    return "EasyOrders details request failed";
  }
  return (raw || "EasyOrders details request failed").slice(0, 160);
}

async function requestEasyOrdersDetailsWithRetry(
  send,
  {
    maxRetries = DEFAULT_MAX_RETRIES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      const classified = classifyDetailsError(error);
      const retriesLeft = attempt < maxRetries;
      if (!classified.retryable || !retriesLeft) {
        const wrapped = new Error(sanitizeErrorMessage(error));
        wrapped.code = classified.diagnosticCode;
        wrapped.kind = classified.kind;
        wrapped.retryable = false;
        wrapped.http_status = classified.http_status;
        throw wrapped;
      }
      const retryAfter = parseRetryAfterMs(
        error?.response?.headers?.["retry-after"] ||
          error?.response?.headers?.["Retry-After"],
      );
      await sleep(retryAfter != null ? retryAfter : backoffMs(attempt));
      attempt += 1;
    }
  }
}

function normalizeEasyOrdersVariant(variant, { isDefault = false } = {}) {
  const externalVariantId = variantExternalId(variant);
  const options = extractOptionPairs(variant)
    .filter((pair) => pair.name && pair.value)
    .map((pair) => ({ name: pair.name, value: pair.value }));

  return {
    externalVariantId: externalVariantId || null,
    sku: pickFirst(variant?.sku) || null,
    price: parseNumeric(pickFirst(variant?.sale_price, variant?.price)),
    quantity: parseNumeric(variant?.quantity),
    isDefault: Boolean(isDefault),
    options,
    providerData: {
      id: variant?.id ?? null,
      product_id: variant?.product_id ?? null,
    },
  };
}

function canonicalVariantsFromSource(source, diagnostics) {
  const inspect = inspectVariants(source);
  if (inspect.malformed) {
    diagnostics.push(
      diagnostic(
        DIAGNOSTIC.VARIANTS_INCOMPLETE,
        SEVERITY.ERROR,
        "EasyOrders variants is not a usable array",
      ),
    );
    return { variants: [], variantsComplete: false };
  }
  if (!inspect.present || inspect.empty) {
    return { variants: [], variantsComplete: false };
  }

  const usable = [];
  for (const entry of inspect.objects) {
    const id = variantExternalId(entry);
    if (!id) {
      diagnostics.push(
        diagnostic(
          DIAGNOSTIC.VARIANT_ID_MISSING,
          SEVERITY.ERROR,
          "EasyOrders variant is missing id and is not canonical",
        ),
      );
      continue;
    }
    usable.push(entry);
  }

  const variants = usable.map((entry, index) =>
    normalizeEasyOrdersVariant(entry, { isDefault: index === 0 }),
  );
  const variantsComplete =
    variants.length > 0 && inspect.missingIds === 0 && !inspect.malformed;
  if (!variantsComplete) {
    diagnostics.push(
      diagnostic(
        DIAGNOSTIC.VARIANTS_INCOMPLETE,
        SEVERITY.WARNING,
        "EasyOrders variants are incomplete; no fake default variant was created",
      ),
    );
  }
  return { variants, variantsComplete };
}

function determineProductType(variants, variantsComplete) {
  if (!variantsComplete || !variants.length) return null;
  const hasOptions = variants.some(
    (variant) => Array.isArray(variant.options) && variant.options.length > 0,
  );
  if (variants.length === 1 && !hasOptions) return "simple";
  return "variable";
}

function normalizeEasyOrdersProduct({
  listItem,
  details = null,
  detailsFetched = false,
  detailsError = null,
} = {}) {
  const diagnostics = [];
  const list = asPlainObject(listItem) || {};
  const detailRoot = details ? unwrapEasyOrdersDetails(details) : {};
  const externalProductId =
    resolveEasyOrdersExternalProductId(list) ||
    resolveEasyOrdersExternalProductId(detailRoot) ||
    hashFallbackProductId(listItem ?? detailRoot);

  const title = productTitle(detailRoot) || productTitle(list);
  const sku = productSku(detailRoot) || productSku(list);
  const price =
    productPrice(detailRoot) != null ? productPrice(detailRoot) : productPrice(list);
  const quantity =
    productQuantity(detailRoot) != null
      ? productQuantity(detailRoot)
      : productQuantity(list);
  const image = productImage(detailRoot) || productImage(list);

  let variants = [];
  let variantsComplete = false;

  if (detailsFetched && detailsError) {
    const classified = detailsError.kind
      ? detailsError
      : classifyDetailsError(detailsError);
    diagnostics.push(
      diagnostic(
        detailsError.code || classified.diagnosticCode || DIAGNOSTIC.DETAILS_FAILED,
        SEVERITY.ERROR,
        sanitizeErrorMessage(detailsError),
        { http_status: detailsError.http_status || classified.http_status },
      ),
    );
    const fromList = canonicalVariantsFromSource(list, diagnostics);
    variants = fromList.variants;
    variantsComplete = false;
  } else if (detailsFetched) {
    const fromDetails = canonicalVariantsFromSource(detailRoot, diagnostics);
    variants = fromDetails.variants;
    variantsComplete = fromDetails.variantsComplete;
    if (
      !fromDetails.variantsComplete &&
      !diagnostics.some((item) => item.code === DIAGNOSTIC.VARIANTS_INCOMPLETE)
    ) {
      diagnostics.push(
        diagnostic(
          DIAGNOSTIC.VARIANTS_INCOMPLETE,
          SEVERITY.WARNING,
          "Details succeeded without a complete usable variants list",
        ),
      );
    }
  } else {
    const fromList = canonicalVariantsFromSource(list, diagnostics);
    variants = fromList.variants;
    variantsComplete = fromList.variantsComplete;
  }

  const productType = determineProductType(variants, variantsComplete);

  return {
    externalProductId,
    title: title || null,
    sku: sku || null,
    price,
    quantity,
    image: image || null,
    variantsComplete,
    productType,
    variants,
    providerData: {
      provider: "easyorders",
      listHasVariants: inspectVariants(list).present,
      detailsFetched: Boolean(detailsFetched),
    },
    diagnostics,
    incomplete: !variantsComplete,
    detailsFetched: Boolean(detailsFetched),
  };
}

async function mapWithBoundedConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const pool = Math.min(limit, items.length || 1);
  await Promise.all(Array.from({ length: pool }, () => run()));
  return results;
}

/**
 * Enrich a LIST payload. Inject `requestDetails(externalProductId)` in tests.
 * Production callers pass a requester built by createEasyOrdersDetailsRequester.
 * Never writes catalog tables.
 */
async function enrichEasyOrdersCatalog({
  listItems = [],
  requestDetails,
  concurrency = DEFAULT_CONCURRENCY,
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep,
} = {}) {
  const items = Array.isArray(listItems) ? listItems : [];
  const stats = {
    listed: items.length,
    detailsAttempted: 0,
    detailsSucceeded: 0,
    detailsFailed: 0,
    detailsSkipped: 0,
    authInvalid: false,
    shortCircuited: 0,
  };
  const integrationDiagnostics = [];
  let authFailure = null;
  let inFlight = 0;
  let maxInFlight = 0;

  async function enrichOne(listItem) {
    const decision = listNeedsDetails(listItem);
    const baseDiagnostics = [];
    if (!decision.needed) {
      stats.detailsSkipped += 1;
      const normalized = normalizeEasyOrdersProduct({
        listItem,
        detailsFetched: false,
      });
      return {
        ...normalized,
        detailsFetched: false,
        inFlightPeak: maxInFlight,
      };
    }

    if (authFailure) {
      stats.shortCircuited += 1;
      const normalized = normalizeEasyOrdersProduct({
        listItem,
        detailsFetched: true,
        detailsError: authFailure,
      });
      normalized.diagnostics = [
        diagnostic(
          DIAGNOSTIC.AUTH_INVALID,
          SEVERITY.ERROR,
          "EasyOrders details skipped after connection-level auth failure",
        ),
        ...normalized.diagnostics.filter(
          (item) => item.code !== DIAGNOSTIC.AUTH_INVALID,
        ),
      ];
      return { ...normalized, detailsFetched: false, skippedAfterAuth: true };
    }

    if (typeof requestDetails !== "function") {
      const normalized = normalizeEasyOrdersProduct({
        listItem,
        detailsFetched: true,
        detailsError: {
          code: DIAGNOSTIC.DETAILS_FAILED,
          message: "EasyOrders details requester is not configured",
          kind: "permanent",
        },
      });
      return { ...normalized, detailsFetched: false };
    }

    baseDiagnostics.push(
      diagnostic(
        DIAGNOSTIC.DETAILS_REQUIRED,
        SEVERITY.INFO,
        "List variants are missing or incomplete; details fetch required",
      ),
    );

    const externalProductId =
      resolveEasyOrdersExternalProductId(listItem) ||
      hashFallbackProductId(listItem);

    stats.detailsAttempted += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const details = await requestEasyOrdersDetailsWithRetry(
        () => requestDetails(externalProductId),
        { maxRetries, sleep },
      );
      stats.detailsSucceeded += 1;
      const normalized = normalizeEasyOrdersProduct({
        listItem,
        details,
        detailsFetched: true,
      });
      normalized.diagnostics = [...baseDiagnostics, ...normalized.diagnostics];
      return { ...normalized, detailsFetched: true };
    } catch (error) {
      stats.detailsFailed += 1;
      if (error.kind === "auth" || error.code === DIAGNOSTIC.AUTH_INVALID) {
        authFailure = error;
        stats.authInvalid = true;
        integrationDiagnostics.push(
          diagnostic(
            DIAGNOSTIC.AUTH_INVALID,
            SEVERITY.ERROR,
            "EasyOrders authentication failed; remaining details calls were stopped",
            { http_status: error.http_status },
          ),
        );
      }
      const normalized = normalizeEasyOrdersProduct({
        listItem,
        detailsFetched: true,
        detailsError: error,
      });
      normalized.diagnostics = [...baseDiagnostics, ...normalized.diagnostics];
      return { ...normalized, detailsFetched: true };
    } finally {
      inFlight -= 1;
    }
  }

  const products = items.length
    ? await mapWithBoundedConcurrency(items, concurrency, enrichOne)
    : [];

  return {
    provider: "easyorders",
    products,
    stats: { ...stats, maxInFlight },
    diagnostics: integrationDiagnostics,
    catalogTablesWritten: [],
  };
}

function createEasyOrdersDetailsRequester({
  integrationId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  axiosImpl = null,
} = {}) {
  return async function requestDetails(externalProductId) {
    const axios = axiosImpl || require("axios");
    const { getEasyOrdersClient } = require("./easyorder.service");
    const id = trimText(externalProductId);
    if (!id) {
      const err = new Error("product_id is required");
      err.code = "INVALID_PRODUCT_ID";
      throw err;
    }
    const client = await getEasyOrdersClient({ integrationId });
    try {
      const response = await axios.get(
        `${client.baseUrl}/products/${encodeURIComponent(id)}`,
        {
          headers: client.headers,
          timeout: timeoutMs,
          maxRedirects: 0,
        },
      );
      return response.data;
    } catch (error) {
      throw error;
    }
  };
}

module.exports = {
  SEVERITY,
  DIAGNOSTIC,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
  unwrapEasyOrdersDetails,
  resolveEasyOrdersExternalProductId,
  listNeedsDetails,
  classifyDetailsError,
  requestEasyOrdersDetailsWithRetry,
  normalizeEasyOrdersProduct,
  enrichEasyOrdersCatalog,
  createEasyOrdersDetailsRequester,
};
