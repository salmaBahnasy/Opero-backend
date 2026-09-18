const { getPublicCompanyBranding } = require("../services/publicBranding.service");

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
    res.status(500).json({
      success: false,
      message: "Failed to load company branding",
      error: error.message,
    });
  }
}

module.exports = {
  getCompanyBranding,
};
