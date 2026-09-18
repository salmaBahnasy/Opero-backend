const { isCompanyAdmin } = require("../utils/roles");
const { runWithCompanyId } = require("../utils/tenantScope");

/**
 * Tenant context comes only from the authenticated JWT.
 * Never read company_id / companyId / companySlug from body, query, or headers.
 */
function getCompanyId(req) {
  const companyId = req?.user?.companyId;
  if (companyId == null || String(companyId).trim() === "") {
    const error = new Error("Authenticated company context is missing");
    error.code = "TENANT_CONTEXT_MISSING";
    return null;
  }
  return String(companyId).trim();
}

function requireTenantContext(req, res, next) {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(401).json({
      success: false,
      message: "Unauthorized. Token must include companyId.",
    });
    return;
  }
  next();
}

/**
 * Binds JWT companyId for the rest of the request. Downstream tenant-table
 * queries pick this up automatically. Never reads company id from the client.
 */
function bindTenantScope(req, res, next) {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(401).json({
      success: false,
      message: "Unauthorized. Token must include companyId.",
    });
    return;
  }
  runWithCompanyId(companyId, () => next());
}

function requireCompanyAdmin(req, res, next) {
  if (!getCompanyId(req)) {
    res.status(401).json({
      success: false,
      message: "Unauthorized. Token must include companyId.",
    });
    return;
  }

  if (!isCompanyAdmin(req.user?.role)) {
    res.status(403).json({
      success: false,
      message: "Forbidden. company_admin role is required.",
    });
    return;
  }

  next();
}

module.exports = {
  getCompanyId,
  requireTenantContext,
  requireCompanyAdmin,
  bindTenantScope,
};
