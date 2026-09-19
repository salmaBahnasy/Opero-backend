process.env.NODE_ENV = "test";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeShopifyShopDomain,
  shopifyShopDomainsEqual,
} = require("../src/utils/shopifyDomain");

describe("Shopify shop domain normalization", () => {
  it("canonicalizes common merchant inputs to store.myshopify.com", () => {
    const expected = "store-name.myshopify.com";
    assert.equal(normalizeShopifyShopDomain("store-name.myshopify.com"), expected);
    assert.equal(
      normalizeShopifyShopDomain("https://store-name.myshopify.com/"),
      expected,
    );
    assert.equal(
      normalizeShopifyShopDomain("https://store-name.myshopify.com/admin"),
      expected,
    );
    assert.equal(
      normalizeShopifyShopDomain("store-name.myshopify.com/admin/orders"),
      expected,
    );
    assert.equal(
      normalizeShopifyShopDomain("HTTPS://Store-Name.myshopify.com/admin"),
      expected,
    );
  });

  it("rejects deceptive suffixes", () => {
    assert.throws(
      () => normalizeShopifyShopDomain("store.myshopify.com.attacker.com"),
      (error) => error.code === "SHOPIFY_SHOP_DOMAIN_INVALID",
    );
    assert.throws(
      () =>
        normalizeShopifyShopDomain("https://store.myshopify.com.attacker.com/admin"),
      (error) => error.code === "SHOPIFY_SHOP_DOMAIN_INVALID",
    );
  });

  it("rejects invalid hosts", () => {
    for (const value of [
      "",
      "   ",
      "localhost",
      "127.0.0.1",
      "shop.example.com",
      "store-name.myshopify.com:8080",
      "not a domain",
    ]) {
      assert.throws(
        () => normalizeShopifyShopDomain(value),
        (error) => error.code === "SHOPIFY_SHOP_DOMAIN_INVALID",
      );
    }
  });

  it("compares canonical domains as equal", () => {
    assert.equal(
      shopifyShopDomainsEqual(
        "https://store-name.myshopify.com/admin",
        "store-name.myshopify.com",
      ),
      true,
    );
  });
});
