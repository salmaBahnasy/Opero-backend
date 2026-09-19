const CORE_FEATURE_KEYS = ["orders", "products", "employees", "analytics"];

const COMPANY_BRANDING_COLUMNS =
  "id,name,slug,logo_url,login_image_url,favicon_url,primary_color,secondary_color,is_active,deleted_at";

const SAFE_INTEGRATION_COLUMNS = "id,provider,category,name,is_enabled,settings";

function emptyToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toBranding(company) {
  return {
    logoUrl: emptyToNull(company?.logo_url),
    loginImageUrl: emptyToNull(company?.login_image_url),
    faviconUrl: emptyToNull(company?.favicon_url),
    primaryColor: emptyToNull(company?.primary_color),
    secondaryColor: emptyToNull(company?.secondary_color),
  };
}

function toPublicBranding(company) {
  return {
    name: company.name,
    slug: company.slug,
    logoUrl: emptyToNull(company.logo_url),
    loginImageUrl: emptyToNull(company.login_image_url),
    faviconUrl: emptyToNull(company.favicon_url),
    primaryColor: emptyToNull(company.primary_color),
    secondaryColor: emptyToNull(company.secondary_color),
  };
}

function isPubliclyActiveCompany(company) {
  return Boolean(company) && company.is_active !== false && !company.deleted_at;
}

module.exports = {
  CORE_FEATURE_KEYS,
  COMPANY_BRANDING_COLUMNS,
  SAFE_INTEGRATION_COLUMNS,
  emptyToNull,
  toBranding,
  toPublicBranding,
  isPubliclyActiveCompany,
};
