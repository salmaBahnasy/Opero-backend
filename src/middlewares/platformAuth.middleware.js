const { verifyPlatformAdminToken } = require("../config/jwt");
const { readBearerToken } = require("./auth.middleware");

function requirePlatformAdmin(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({
        success: false,
        message: "Unauthorized. Bearer token is required.",
      });
      return;
    }

    req.platformAdmin = verifyPlatformAdminToken(token);
    req.user = undefined;
    next();
  } catch (error) {
    const wrongScope = error && error.code === "JWT_WRONG_SCOPE";
    res.status(wrongScope ? 403 : 401).json({
      success: false,
      code: wrongScope ? "JWT_WRONG_SCOPE" : undefined,
      message: wrongScope
        ? "Forbidden. Platform admin token required."
        : "Invalid or expired token",
    });
  }
}

module.exports = {
  requirePlatformAdmin,
};
