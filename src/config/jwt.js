const jwt = require("jsonwebtoken");

const INSECURE_DEFAULT_SECRET = "dev-secret-change-me";
const RECOGNIZED_DEV_ENVS = new Set(["development", "dev", "test"]);

function getNodeEnv() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase();
}

function isRecognizedDevEnv(env = getNodeEnv()) {
  return RECOGNIZED_DEV_ENVS.has(env);
}

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  const env = getNodeEnv();
  const devLike = isRecognizedDevEnv(env);

  if (!secret) {
    const error = new Error(
      devLike
        ? "JWT_SECRET is required. Set it in the project root .env (see .env.example)."
        : "JWT_SECRET is not configured.",
    );
    error.code = "JWT_SECRET_MISSING";
    throw error;
  }

  if (secret === INSECURE_DEFAULT_SECRET && !devLike) {
    const error = new Error("JWT_SECRET is insecure for this environment.");
    error.code = "JWT_SECRET_INSECURE";
    throw error;
  }

  return secret;
}

const SCOPE_COMPANY = "company";
const SCOPE_PLATFORM_ADMIN = "platform_admin";

function signEmployeeToken({ employeeId, companyId, role, email }) {
  if (!employeeId || !companyId || !role || !email) {
    const error = new Error("employeeId, companyId, role, and email are required to sign a token");
    error.code = "JWT_PAYLOAD_INCOMPLETE";
    throw error;
  }

  return jwt.sign(
    {
      employeeId,
      companyId,
      role,
      email,
      scope: SCOPE_COMPANY,
    },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "7d" },
  );
}

function signPlatformAdminToken({ platformAdminId, email }) {
  if (!platformAdminId || !email) {
    const error = new Error("platformAdminId and email are required to sign a token");
    error.code = "JWT_PAYLOAD_INCOMPLETE";
    throw error;
  }

  return jwt.sign(
    {
      platformAdminId,
      scope: SCOPE_PLATFORM_ADMIN,
      email,
    },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "7d" },
  );
}

function isPlatformAdminPayload(decoded) {
  return (
    decoded &&
    (decoded.scope === SCOPE_PLATFORM_ADMIN || Boolean(decoded.platformAdminId))
  );
}

function verifyEmployeeToken(token) {
  const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
  if (isPlatformAdminPayload(decoded)) {
    const error = new Error("Platform admin token cannot be used for company routes");
    error.code = "JWT_WRONG_SCOPE";
    throw error;
  }

  const employeeId = decoded.employeeId || decoded.id;
  const companyId = decoded.companyId;
  const role = decoded.role;
  const email = decoded.email;

  if (!companyId || !employeeId) {
    const error = new Error("Token is missing companyId");
    error.code = "JWT_COMPANY_ID_MISSING";
    throw error;
  }

  return {
    employeeId,
    companyId,
    role,
    email,
    scope: SCOPE_COMPANY,
  };
}

function verifyPlatformAdminToken(token) {
  const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] });
  if (
    decoded.scope !== SCOPE_PLATFORM_ADMIN ||
    !decoded.platformAdminId ||
    decoded.companyId
  ) {
    const error = new Error("Platform admin token required");
    error.code = "JWT_WRONG_SCOPE";
    throw error;
  }

  return {
    platformAdminId: decoded.platformAdminId,
    scope: SCOPE_PLATFORM_ADMIN,
    email: decoded.email,
  };
}

module.exports = {
  getJwtSecret,
  isRecognizedDevEnv,
  signEmployeeToken,
  verifyEmployeeToken,
  signPlatformAdminToken,
  verifyPlatformAdminToken,
  SCOPE_COMPANY,
  SCOPE_PLATFORM_ADMIN,
  INSECURE_DEFAULT_SECRET,
};
