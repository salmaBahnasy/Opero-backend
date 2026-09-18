const { getCompanyBootstrap } = require("../services/companyBootstrap.service");

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
      message: error.message,
    });
    return;
  }
  if (error.code === "COMPANY_NOT_FOUND" || error.code === "EMPLOYEE_NOT_FOUND") {
    res.status(404).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  res.status(500).json({
    success: false,
    message: "Failed to load company bootstrap",
    error: error.message,
  });
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
