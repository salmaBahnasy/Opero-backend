const {
  completeSallaOauthCallback,
  callbackRedirectUrl,
  safeCallbackErrorCode,
  verifySallaOauthState,
} = require("../services/sallaAuth.service");
const { getSallaOauthConfig } = require("../config/salla");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendCallbackResult(res, { companyId, status, code }) {
  const location = callbackRedirectUrl(companyId, {
    salla: status,
    code: status === "error" ? code : undefined,
  });
  if (location) {
    res.redirect(302, location);
    return;
  }
  const safeCode = escapeHtml(code || "SALLA_OAUTH_FAILED");
  const message =
    status === "connected"
      ? "Salla connected. You can close this window and return to Super Admin."
      : `Salla authorization failed (${safeCode}). You can close this window.`;
  res
    .status(status === "connected" ? 200 : 400)
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Salla</title></head><body><p>${message}</p></body></html>`,
    );
}

async function sallaOauthCallback(req, res) {
  try {
    const result = await completeSallaOauthCallback({
      code: req.query.code,
      state: req.query.state,
      forgedCompanyId: req.query.companyId || req.query.company_id,
    });
    sendCallbackResult(res, {
      companyId: result.companyId,
      status: "connected",
    });
  } catch (error) {
    const code = safeCallbackErrorCode(error);
    let companyId = "";
    try {
      const verified = verifySallaOauthState(
        req.query.state,
        getSallaOauthConfig().stateSecret,
        { ignoreExpiry: true },
      );
      companyId = verified.companyId;
    } catch {
      companyId = "";
    }
    sendCallbackResult(res, {
      companyId,
      status: "error",
      code,
    });
  }
}

module.exports = { sallaOauthCallback };
