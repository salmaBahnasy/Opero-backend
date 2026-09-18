const bcrypt = require("bcryptjs");
const supabase = require("../config/supabase");
const { signPlatformAdminToken } = require("../config/jwt");

const PLATFORM_ADMINS_TABLE =
  process.env.SUPABASE_PLATFORM_ADMINS_TABLE || "platform_admins";

function pickLoginField(body, ...keys) {
  if (!body || typeof body !== "object") return "";
  for (const key of keys) {
    if (body[key] != null && String(body[key]).trim() !== "") {
      return String(body[key]).trim();
    }
  }
  return "";
}

function invalidCredentials(res) {
  res.status(401).json({
    success: false,
    message: "Invalid credentials",
  });
}

function toPublicPlatformAdmin(admin) {
  if (!admin) return null;
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    isActive: admin.is_active,
    scope: "platform_admin",
  };
}

async function platformLogin(req, res) {
  try {
    const email = pickLoginField(req.body, "email").toLowerCase();
    const password = req.body?.password;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: "email and password are required",
      });
      return;
    }

    const { data: admin, error } = await supabase
      .from(PLATFORM_ADMINS_TABLE)
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!admin) {
      invalidCredentials(res);
      return;
    }

    const isValidPassword = await bcrypt.compare(password, admin.password);
    if (!isValidPassword) {
      invalidCredentials(res);
      return;
    }

    if (admin.is_active === false) {
      res.status(403).json({
        success: false,
        message: "Account is inactive.",
      });
      return;
    }

    const token = signPlatformAdminToken({
      platformAdminId: admin.id,
      email: admin.email,
    });

    res.json({
      success: true,
      message: "Login successful",
      token,
      data: toPublicPlatformAdmin(admin),
    });
  } catch (error) {
    console.error("[platform-login] failed", {
      message: error?.message,
      code: error?.code,
    });
    res.status(500).json({
      success: false,
      message: "Failed to login",
    });
  }
}

module.exports = {
  platformLogin,
};
