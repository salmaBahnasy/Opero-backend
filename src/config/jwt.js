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
    },
    getJwtSecret(),
    { expiresIn: "7d" },
  );
}

function verifyEmployeeToken(token) {
  const decoded = jwt.verify(token, getJwtSecret());
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
  };
}

module.exports = {
  getJwtSecret,
  isRecognizedDevEnv,
  signEmployeeToken,
  verifyEmployeeToken,
  INSECURE_DEFAULT_SECRET,
};
