const { getPublicCompanyBranding } = require("../services/publicBranding.service");
const { sendInternalError } = require("../utils/safeError");

async function getCompanyBranding(req, res) {
  try {
    const data = await getPublicCompanyBranding(req.params.slug);
    res.json({ success: true, data });
  } catch (error) {
    if (error.code === "COMPANY_NOT_FOUND") {
      res.status(404).json({
        success: false,
        code: error.code,
        message: "Company not found",
      });
      return;
    }
    sendInternalError(res, "Failed to load company branding", error, "branding");
  }
}

module.exports = {
  getCompanyBranding,
};
