function getNodeEnv() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase();
}

function shouldExposeErrorDetails(env = getNodeEnv()) {
  return env !== "production";
}

function logSafeError(operation, error) {
  console.error(`[${operation}]`, {
    message: error?.message,
    code: error?.code,
  });
}

function internalErrorBody(fallbackMessage, error) {
  const body = {
    success: false,
    message: fallbackMessage,
  };
  if (shouldExposeErrorDetails() && error?.message) {
    body.error = error.message;
  }
  return body;
}

function sendInternalError(res, fallbackMessage, error, operation = "api") {
  logSafeError(operation, error);
  res.status(500).json(internalErrorBody(fallbackMessage, error));
}

module.exports = {
  getNodeEnv,
  shouldExposeErrorDetails,
  logSafeError,
  internalErrorBody,
  sendInternalError,
};
