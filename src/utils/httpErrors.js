function sendKnownServiceError(res, error) {
  if (!error || !error.code) return false;

  if (
    error.code === "INTEGRATION_NOT_CONFIGURED" ||
    error.code === "INTEGRATION_DISABLED" ||
    error.code === "INTEGRATION_AMBIGUOUS" ||
    error.code === "INTEGRATION_NOT_OWNED" ||
    error.code === "PROVIDER_MISMATCH" ||
    error.code === "INTEGRATION_ENCRYPTION_KEY_MISSING" ||
    error.code === "INTEGRATION_ENCRYPTION_KEY_INVALID" ||
    error.code === "INTEGRATION_ENCRYPTION_KEY_INSECURE"
  ) {
    const status =
      error.code === "INTEGRATION_ENCRYPTION_KEY_MISSING" ||
      error.code === "INTEGRATION_ENCRYPTION_KEY_INVALID" ||
      error.code === "INTEGRATION_ENCRYPTION_KEY_INSECURE"
        ? 500
        : error.code === "INTEGRATION_NOT_OWNED"
          ? 403
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
