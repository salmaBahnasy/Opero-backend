const { verifyEmployeeToken } = require("../config/jwt");
const { normalizeRole, toPublicRole } = require("../utils/roles");
const { revalidateCompanyEmployee } = require("../services/companySession.service");
const { sendInternalError } = require("../utils/safeError");

function readBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token;
}

function decodeEmployeeFromToken(token) {
  const decoded = verifyEmployeeToken(token);
  const role = normalizeRole(decoded.role);
  const employeeId = String(decoded.employeeId).trim();
  const companyId = String(decoded.companyId).trim();

  return {
    employeeId,
    companyId,
    role,
    email: decoded.email,
    // Compatibility aliases for existing ERP handlers (orders / added-orders).
    id: employeeId,
    employeeRole: toPublicRole(role),
  };
}

function attachAuthenticatedUser(req, token) {
  req.user = decodeEmployeeFromToken(token);
  // Tenant id is only taken from the JWT. Ignore any client-supplied override.
  return req.user;
}

async function attachFreshCompanySession(req, token) {
  const fromJwt = attachAuthenticatedUser(req, token);
  const fresh = await revalidateCompanyEmployee({
    companyId: fromJwt.companyId,
    employeeId: fromJwt.employeeId,
  });
  req.user = fresh;
  return req.user;
}

function sendAuthFailure(res, error) {
  const missingCompany = error && error.code === "JWT_COMPANY_ID_MISSING";
  const wrongScope = error && error.code === "JWT_WRONG_SCOPE";
  const sessionInvalid = error && error.code === "SESSION_INVALID";
  const lookupFailed = error && error.code === "SESSION_LOOKUP_FAILED";
  if (lookupFailed) {
    sendInternalError(res, "Failed to validate session", error, "auth");
    return;
  }
  res.status(wrongScope ? 403 : 401).json({
    success: false,
    code: wrongScope
      ? "JWT_WRONG_SCOPE"
      : sessionInvalid
        ? "SESSION_INVALID"
        : undefined,
    message: wrongScope
      ? "Forbidden. Company token required."
      : missingCompany
        ? "Unauthorized. Token must include companyId."
        : "Invalid or expired token",
  });
}

/**
 * Sets req.user when a valid Bearer token is sent; otherwise continues without req.user.
 * A present but invalid / company-less token is rejected (401).
 */
async function optionalAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    await attachFreshCompanySession(req, token);
    next();
  } catch (error) {
    sendAuthFailure(res, error);
  }
}

async function requireAuth(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({
        success: false,
        message: "Unauthorized. Bearer token is required.",
      });
      return;
    }

    await attachFreshCompanySession(req, token);
    next();
  } catch (error) {
    sendAuthFailure(res, error);
  }
}

module.exports = {
  requireAuth,
  optionalAuth,
  decodeEmployeeFromToken,
  readBearerToken,
};
