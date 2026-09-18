const supabase = require("../config/supabase");
const {
  COMPANY_BRANDING_COLUMNS,
  toPublicBranding,
  isPubliclyActiveCompany,
} = require("../utils/branding");

const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";

async function getPublicCompanyBranding(rawSlug) {
  const slug = String(rawSlug || "")
    .trim()
    .toLowerCase();
  if (!slug) {
    const error = new Error("Company not found");
    error.code = "COMPANY_NOT_FOUND";
    throw error;
  }

  const { data, error } = await supabase
    .from(COMPANIES_TABLE)
    .select(COMPANY_BRANDING_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!isPubliclyActiveCompany(data)) {
    const notFound = new Error("Company not found");
    notFound.code = "COMPANY_NOT_FOUND";
    throw notFound;
  }
  return toPublicBranding(data);
}

module.exports = {
  getPublicCompanyBranding,
};
