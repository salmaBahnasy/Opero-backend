function sendKnownServiceError(res, error) {
  if (!error || !error.code) return false;

  if (
    error.code === "INTEGRATION_NOT_CONFIGURED" ||
    error.code === "INTEGRATION_DISABLED" ||
    error.code === "INTEGRATION_AMBIGUOUS" ||
    error.code === "INTEGRATION_NOT_OWNED" ||
    error.code === "INTEGRATION_NOT_FOUND" ||
    error.code === "INVALID_SHIPPING_INTEGRATION" ||
    error.code === "SHIPPING_INTEGRATION_MISMATCH" ||
    error.code === "SHIPPING_PROVIDER_NOT_IMPLEMENTED" ||
    error.code === "INVALID_CATALOG_PRODUCT" ||
    error.code === "CATALOG_PRODUCT_NOT_FOUND" ||
    error.code === "CATALOG_PRODUCT_AMBIGUOUS" ||
    error.code === "IMPORT_PRODUCT_AMBIGUOUS" ||
    error.code === "PROVIDER_MISMATCH" ||
    error.code === "EASYCONFIRM_SOURCE_REQUIRED" ||
    error.code === "EASYCONFIRM_NOT_EASYORDERS" ||
    error.code === "MANUAL_ORDER_NO_REFRESH" ||
    error.code === "ORDER_AMBIGUOUS" ||
    error.code === "ORDER_DUPLICATE" ||
    error.code === "INTEGRATION_IN_USE" ||
    error.code === "INTEGRATION_ENCRYPTION_KEY_MISSING" ||
    error.code === "INTEGRATION_ENCRYPTION_KEY_INVALID" ||
    error.code === "INTEGRATION_ENCRYPTION_KEY_INSECURE" ||
    error.code === "SHOPIFY_WEBHOOK_SECRET_MISSING" ||
    error.code === "SHOPIFY_WEBHOOK_HMAC_INVALID" ||
    error.code === "SHOPIFY_SHOP_DOMAIN_MISMATCH" ||
    error.code === "SHOPIFY_CREDENTIALS_INVALID" ||
    error.code === "SHOPIFY_SHOP_DOMAIN_INVALID" ||
    error.code === "SHOPIFY_SHOP_DOMAIN_REQUIRED" ||
    error.code === "SHOPIFY_INTEGRATION_REQUIRED" ||
    error.code === "SHOPIFY_PROVIDER_MISMATCH" ||
    error.code === "SHOPIFY_PROVIDER_UNAVAILABLE" ||
    error.code === "SHOPIFY_GRAPHQL_ERROR" ||
    error.code === "SHOPIFY_RATE_LIMITED" ||
    error.code === "SHOPIFY_ORDER_ID_REQUIRED" ||
    error.code === "SHOPIFY_IMPORT_RANGE_INVALID" ||
    error.code === "SHOPIFY_IMPORT_RANGE_TOO_LARGE" ||
    error.code === "SHOPIFY_IMPORT_INTEGRATION_REQUIRED" ||
    error.code === "COMMERCE_SYNC_NOT_IMPLEMENTED" ||
    error.code === "COMMERCE_IMPORT_NOT_IMPLEMENTED" ||
    error.code === "SALLA_INTEGRATION_REQUIRED" ||
    error.code === "SALLA_PROVIDER_MISMATCH" ||
    error.code === "SALLA_OAUTH_NOT_CONFIGURED" ||
    error.code === "SALLA_OAUTH_STATE_INVALID" ||
    error.code === "SALLA_OAUTH_STATE_EXPIRED" ||
    error.code === "SALLA_OAUTH_CALLBACK_INVALID" ||
    error.code === "SALLA_OAUTH_TOKEN_INVALID" ||
    error.code === "SALLA_AUTHORIZATION_PENDING" ||
    error.code === "SALLA_AUTHORIZATION_REVOKED" ||
    error.code === "SALLA_AUTHORIZATION_LEGACY" ||
    error.code === "SALLA_MERCHANT_MISMATCH" ||
    error.code === "SALLA_MERCHANT_AMBIGUOUS" ||
    error.code === "SALLA_MERCHANT_REQUIRED" ||
    error.code === "SALLA_CREDENTIALS_INVALID" ||
    error.code === "SALLA_RATE_LIMITED" ||
    error.code === "SALLA_PROVIDER_UNAVAILABLE" ||
    error.code === "SALLA_WEBHOOK_NOT_READY" ||
    error.code === "SALLA_WEBHOOK_HMAC_INVALID" ||
    error.code === "SALLA_WEBHOOK_STRATEGY_INVALID" ||
    error.code === "SALLA_WEBHOOK_SECRET_MISSING" ||
    error.code === "SALLA_WEBHOOK_INVALID_JSON" ||
    error.code === "SALLA_ORDER_ID_REQUIRED" ||
    error.code === "SALLA_PRODUCT_ID_REQUIRED" ||
    error.code === "SALLA_IMPORT_RANGE_INVALID" ||
    error.code === "SALLA_IMPORT_RANGE_TOO_LARGE" ||
    error.code === "SPREADSHEET_SYNC_UNSUPPORTED" ||
    error.code === "SPREADSHEET_REMOTE_TEST_UNSUPPORTED" ||
    error.code === "SPREADSHEET_WEBHOOK_UNSUPPORTED" ||
    error.code === "SPREADSHEET_HISTORICAL_API_IMPORT_UNSUPPORTED" ||
    error.code === "FEATURE_REQUIRED" ||
    error.code === "IMPORT_SOURCE_NOT_FOUND" ||
    error.code === "LAST_ADMIN_REQUIRED" ||
    error.code === "PASSWORD_INVALID"
  ) {
    const status =
      error.code === "INTEGRATION_ENCRYPTION_KEY_MISSING" ||
      error.code === "INTEGRATION_ENCRYPTION_KEY_INVALID" ||
      error.code === "INTEGRATION_ENCRYPTION_KEY_INSECURE"
        ? 500
        : error.code === "SHOPIFY_WEBHOOK_SECRET_MISSING" ||
            error.code === "SHOPIFY_WEBHOOK_HMAC_INVALID" ||
            error.code === "SHOPIFY_SHOP_DOMAIN_MISMATCH" ||
            error.code === "SHOPIFY_CREDENTIALS_INVALID" ||
            error.code === "SALLA_WEBHOOK_HMAC_INVALID" ||
            error.code === "SALLA_WEBHOOK_STRATEGY_INVALID" ||
            error.code === "SALLA_WEBHOOK_SECRET_MISSING" ||
            (error.code === "SALLA_MERCHANT_MISMATCH" && error.statusCode === 401)
          ? 401
        : error.code === "SHOPIFY_SHOP_DOMAIN_INVALID" ||
            error.code === "SHOPIFY_SHOP_DOMAIN_REQUIRED" ||
            error.code === "SHOPIFY_INTEGRATION_REQUIRED" ||
            error.code === "SHOPIFY_PROVIDER_MISMATCH" ||
            error.code === "SHOPIFY_ORDER_ID_REQUIRED" ||
            error.code === "SHOPIFY_IMPORT_RANGE_INVALID" ||
            error.code === "SHOPIFY_IMPORT_RANGE_TOO_LARGE" ||
            error.code === "SHOPIFY_IMPORT_INTEGRATION_REQUIRED" ||
            error.code === "SALLA_INTEGRATION_REQUIRED" ||
            error.code === "SALLA_PROVIDER_MISMATCH" ||
            error.code === "SALLA_OAUTH_STATE_INVALID" ||
            error.code === "SALLA_OAUTH_STATE_EXPIRED" ||
            error.code === "SALLA_OAUTH_CALLBACK_INVALID" ||
            error.code === "SALLA_MERCHANT_REQUIRED" ||
            error.code === "SALLA_WEBHOOK_INVALID_JSON" ||
            error.code === "SALLA_ORDER_ID_REQUIRED" ||
            error.code === "SALLA_PRODUCT_ID_REQUIRED" ||
            error.code === "SALLA_IMPORT_RANGE_INVALID" ||
            error.code === "SALLA_IMPORT_RANGE_TOO_LARGE"
          ? 400
        : error.code === "SALLA_AUTHORIZATION_REVOKED" ||
            error.code === "SALLA_CREDENTIALS_INVALID" ||
            error.code === "SALLA_OAUTH_TOKEN_INVALID"
          ? 401
        : error.code === "SHOPIFY_RATE_LIMITED" || error.code === "SALLA_RATE_LIMITED"
          ? 429
        : error.code === "SHOPIFY_PROVIDER_UNAVAILABLE" ||
            error.code === "SHOPIFY_GRAPHQL_ERROR" ||
            error.code === "SALLA_PROVIDER_UNAVAILABLE"
          ? 502
        : error.code === "INVALID_SHIPPING_INTEGRATION" ||
            error.code === "INVALID_CATALOG_PRODUCT" ||
            error.code === "MANUAL_ORDER_NO_REFRESH"
          ? 400
          : error.code === "SHIPPING_PROVIDER_NOT_IMPLEMENTED" ||
              error.code === "COMMERCE_SYNC_NOT_IMPLEMENTED" ||
              error.code === "COMMERCE_IMPORT_NOT_IMPLEMENTED"
            ? 501
            : error.code === "SALLA_WEBHOOK_NOT_READY" ||
                error.code === "SPREADSHEET_SYNC_UNSUPPORTED" ||
                error.code === "SPREADSHEET_REMOTE_TEST_UNSUPPORTED" ||
                error.code === "SPREADSHEET_WEBHOOK_UNSUPPORTED" ||
                error.code === "SPREADSHEET_HISTORICAL_API_IMPORT_UNSUPPORTED"
              ? 409
            : error.code === "INTEGRATION_NOT_OWNED" ||
                error.code === "FEATURE_REQUIRED"
              ? 403
              : error.code === "INTEGRATION_NOT_FOUND" ||
                  error.code === "CATALOG_PRODUCT_NOT_FOUND" ||
                  error.code === "IMPORT_SOURCE_NOT_FOUND"
                ? 404
                : error.code === "LAST_ADMIN_REQUIRED"
                  ? 409
                : error.code === "PASSWORD_INVALID"
                  ? 400
                : error.code === "SALLA_OAUTH_NOT_CONFIGURED"
                  ? 500
                : 409;
    res.status(status).json({
      success: false,
      code: error.code,
      message: error.message,
      provider: error.provider || undefined,
    });
    return true;
  }

  if (error.code === "WEBHOOK_UNAUTHORIZED" || error.code === "WEBHOOK_TOKEN_REQUIRED") {
    res.status(401).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return true;
  }

  return false;
}

function integrationNotConfigured(provider) {
  const error = new Error(
    `${provider} integration is not configured for this company`,
  );
  error.code = "INTEGRATION_NOT_CONFIGURED";
  error.provider = provider;
  return error;
}

function integrationDisabled(provider) {
  const error = new Error(
    `${provider} integration is disabled for this company`,
  );
  error.code = "INTEGRATION_DISABLED";
  error.provider = provider;
  return error;
}

module.exports = {
  sendKnownServiceError,
  integrationNotConfigured,
  integrationDisabled,
};
