const { getCompanyBootstrap } = require("../services/companyBootstrap.service");
const { sendInternalError } = require("../utils/safeError");

function handleBootstrapError(res, error) {
  if (error.code === "TENANT_CONTEXT_MISSING") {
    res.status(401).json({
      success: false,
      code: error.code,
      message: "Unauthorized. Token must include companyId.",
    });
    return;
  }
  if (error.code === "EMPLOYEE_INACTIVE") {
    res.status(403).json({
      success: false,
      code: error.code,
      message: "Account is inactive.",
    });
    return;
  }
  if (error.code === "COMPANY_NOT_FOUND" || error.code === "EMPLOYEE_NOT_FOUND") {
    res.status(404).json({
      success: false,
      code: error.code,
      message: "Not found",
    });
    return;
  }
  sendInternalError(res, "Failed to load company bootstrap", error, "bootstrap");
}

async function getBootstrap(req, res) {
  try {
    const data = await getCompanyBootstrap({
      companyId: req.user?.companyId,
      employeeId: req.user?.employeeId,
    });
    res.json({ success: true, data });
  } catch (error) {
    handleBootstrapError(res, error);
  }
}

module.exports = {
  getBootstrap,
};
