const supabase = require("../config/supabase");

const COMPANIES_TABLE = process.env.SUPABASE_COMPANIES_TABLE || "companies";

const PUBLIC_COLUMNS =
  "id,name,slug,logo_url,login_image_url,favicon_url,primary_color,secondary_color,timezone,currency,is_active,deleted_at,created_at,updated_at";

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""));
}

function pickString(body, ...keys) {
  if (!body || typeof body !== "object") return undefined;
  for (const key of keys) {
    if (body[key] != null && String(body[key]).trim() !== "") {
      return String(body[key]).trim();
    }
  }
  return undefined;
}

function coerceBoolean(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "active", "yes"].includes(s)) return true;
  if (["false", "0", "inactive", "disabled", "no"].includes(s)) return false;
  return null;
}

async function listCompanies(req, res) {
  try {
    const { data, error } = await supabase
      .from(COMPANIES_TABLE)
      .select(PUBLIC_COLUMNS)
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to list companies",
      error: error.message,
    });
  }
}

async function getCompany(req, res) {
  try {
    const companyId = String(req.params.companyId || "").trim();
    const { data, error } = await supabase
      .from(COMPANIES_TABLE)
      .select(PUBLIC_COLUMNS)
      .eq("id", companyId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get company",
      error: error.message,
    });
  }
}

async function createCompany(req, res) {
  try {
    const body = req.body || {};
    const name = pickString(body, "name");
    const slugInput = pickString(body, "slug");
    const slug = slugify(slugInput || name);

    if (!name) {
      res.status(400).json({ success: false, message: "name is required" });
      return;
    }
    if (!isValidSlug(slug)) {
      res.status(400).json({
        success: false,
        message: "slug is required and must be lowercase letters, numbers, and hyphens",
      });
      return;
    }

    const payload = {
      name,
      slug,
      logo_url: pickString(body, "logo_url", "logoUrl") || null,
      login_image_url: pickString(body, "login_image_url", "loginImageUrl") || null,
      favicon_url: pickString(body, "favicon_url", "faviconUrl") || null,
      primary_color: pickString(body, "primary_color", "primaryColor") || null,
      secondary_color: pickString(body, "secondary_color", "secondaryColor") || null,
      timezone: pickString(body, "timezone") || "Africa/Cairo",
      currency: pickString(body, "currency") || "EGP",
      is_active: coerceBoolean(body.is_active ?? body.isActive) ?? true,
    };

    const { data, error } = await supabase
      .from(COMPANIES_TABLE)
      .insert(payload)
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) {
      if (String(error.message || "").includes("duplicate") || error.code === "23505") {
        res.status(409).json({
          success: false,
          message: "A company with this slug already exists",
        });
        return;
      }
      throw new Error(error.message);
    }

    res.status(201).json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to create company",
      error: error.message,
    });
  }
}

async function updateCompany(req, res) {
  try {
    const companyId = String(req.params.companyId || "").trim();
    const body = req.body || {};
    const updates = {};

    const name = pickString(body, "name");
    const slugInput = pickString(body, "slug");
    if (name) updates.name = name;
    if (slugInput) {
      const slug = slugify(slugInput);
      if (!isValidSlug(slug)) {
        res.status(400).json({ success: false, message: "Invalid slug" });
        return;
      }
      updates.slug = slug;
    }
    if (body.logo_url !== undefined || body.logoUrl !== undefined) {
      updates.logo_url = pickString(body, "logo_url", "logoUrl") || null;
    }
    if (body.login_image_url !== undefined || body.loginImageUrl !== undefined) {
      updates.login_image_url =
        pickString(body, "login_image_url", "loginImageUrl") || null;
    }
    if (body.favicon_url !== undefined || body.faviconUrl !== undefined) {
      updates.favicon_url = pickString(body, "favicon_url", "faviconUrl") || null;
    }
    if (body.primary_color !== undefined || body.primaryColor !== undefined) {
      updates.primary_color = pickString(body, "primary_color", "primaryColor") || null;
    }
    if (body.secondary_color !== undefined || body.secondaryColor !== undefined) {
      updates.secondary_color =
        pickString(body, "secondary_color", "secondaryColor") || null;
    }
    if (pickString(body, "timezone")) updates.timezone = pickString(body, "timezone");
    if (pickString(body, "currency")) updates.currency = pickString(body, "currency");

    const active = coerceBoolean(body.is_active ?? body.isActive);
    if (active !== undefined) {
      if (active === null) {
        res.status(400).json({ success: false, message: "Invalid is_active value" });
        return;
      }
      updates.is_active = active;
    }

    if (!Object.keys(updates).length) {
      res.status(400).json({ success: false, message: "No updates provided" });
      return;
    }

    const { data, error } = await supabase
      .from(COMPANIES_TABLE)
      .update(updates)
      .eq("id", companyId)
      .select(PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update company",
      error: error.message,
    });
  }
}

async function setCompanyActive(req, res) {
  try {
    const companyId = String(req.params.companyId || "").trim();
    const active = coerceBoolean(req.body?.is_active ?? req.body?.isActive);
    if (active == null) {
      res.status(400).json({
        success: false,
        message: "is_active is required",
      });
      return;
    }

    const { data, error } = await supabase
      .from(COMPANIES_TABLE)
      .update({ is_active: active })
      .eq("id", companyId)
      .select(PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update company status",
      error: error.message,
    });
  }
}

module.exports = {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  setCompanyActive,
};
