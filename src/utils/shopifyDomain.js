const CANONICAL_SHOP_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

function shopifyShopDomainError(message) {
  const error = new Error(message);
  error.code = "SHOPIFY_SHOP_DOMAIN_INVALID";
  return error;
}

function looksLikeIpv4(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function looksLikeIpv6(hostname) {
  return hostname.includes(":");
}

/**
 * Canonical Shopify Admin API host: `store-name.myshopify.com`.
 * Rejects custom domains, ports, IPs, localhost, and suffix tricks such as
 * `store.myshopify.com.attacker.com`.
 */
function normalizeShopifyShopDomain(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw shopifyShopDomainError("Shopify shop domain is required");
  }

  let hostname = "";
  let port = "";
  try {
    const withProtocol = /:\/\//.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    hostname = String(url.hostname || "").trim().toLowerCase();
    port = String(url.port || "").trim();
  } catch {
    throw shopifyShopDomainError("Shopify shop domain is invalid");
  }

  if (!hostname) {
    throw shopifyShopDomainError("Shopify shop domain is invalid");
  }
  if (port) {
    throw shopifyShopDomainError("Shopify shop domain must not include a port");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw shopifyShopDomainError("Shopify shop domain cannot be localhost");
  }
  if (looksLikeIpv4(hostname) || looksLikeIpv6(hostname)) {
    throw shopifyShopDomainError("Shopify shop domain cannot be an IP address");
  }
  if (!CANONICAL_SHOP_DOMAIN_RE.test(hostname)) {
    throw shopifyShopDomainError(
      "Shopify shop domain must be a canonical *.myshopify.com hostname",
    );
  }

  return hostname;
}

function shopifyShopDomainsEqual(left, right) {
  return normalizeShopifyShopDomain(left) === normalizeShopifyShopDomain(right);
}

module.exports = {
  CANONICAL_SHOP_DOMAIN_RE,
  normalizeShopifyShopDomain,
  shopifyShopDomainsEqual,
  shopifyShopDomainError,
};
