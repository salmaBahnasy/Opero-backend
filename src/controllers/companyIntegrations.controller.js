const { getCompanyId } = require("../middlewares/tenant.middleware");
const {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  rotateWebhookToken,
  testConnection,
} = require("../services/companyIntegrations.service");
const { createSallaAuthorizationUrl } = require("../services/sallaAuth.service");
const { handleIntegrationError } = require("./platformIntegrations.controller");

const COMPANY_SELF_SERVICE_PROVIDERS = {
  shopify: "commerce",
  salla: "commerce",
  easyorders: "commerce",
  bosta: "shipping",
};

function companyIdFromJwt(req) {
  return getCompanyId(req);
}

function stripClientTenantFields(body = {}) {
  const next = body && typeof body === "object" ? { ...body } : {};
  delete next.companyId;
  delete next.company_id;
  delete next.companySlug;
  delete next.company_slug;
  return next;
}

function assertSelfServiceProvider(provider, category) {
  const key = String(provider || "").trim().toLowerCase();
  const expectedCategory = COMPANY_SELF_SERVICE_PROVIDERS[key];
  if (!expectedCategory) {
    const error = new Error("This provider cannot be managed from Company Settings");
    error.code = "UNSUPPORTED_PROVIDER";
    throw error;
  }
  const incomingCategory = String(category || expectedCategory).trim().toLowerCase();
  if (incomingCategory && incomingCategory !== expectedCategory) {
    const error = new Error(
      `${key} is a ${expectedCategory} provider, not ${incomingCategory}`,
    );
    error.code = "PROVIDER_CATEGORY_MISMATCH";
    throw error;
  }
  return { provider: key, category: expectedCategory };
}

async function listCompanySelfServiceIntegrations(req, res) {
  try {
    const data = await listConnections(companyIdFromJwt(req));
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to list integrations");
  }
}

async function getCompanySelfServiceIntegration(req, res) {
  try {
    const data = await getConnection(
      companyIdFromJwt(req),
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to get integration");
  }
}

async function createCompanySelfServiceIntegration(req, res) {
  try {
    const body = stripClientTenantFields(req.body);
    const resolved = assertSelfServiceProvider(body.provider, body.category);
    const data = await createConnection(companyIdFromJwt(req), {
      ...body,
      provider: resolved.provider,
      category: resolved.category,
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to create integration");
  }
}

async function updateCompanySelfServiceIntegration(req, res) {
  try {
    const body = stripClientTenantFields(req.body);
    delete body.provider;
    delete body.category;
    const data = await updateConnection(
      companyIdFromJwt(req),
      req.params.integrationId,
      body,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to update integration");
  }
}

async function rotateCompanySelfServiceWebhook(req, res) {
  try {
    const data = await rotateWebhookToken(
      companyIdFromJwt(req),
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to rotate webhook token");
  }
}

async function testCompanySelfServiceIntegration(req, res) {
  try {
    const data = await testConnection(
      companyIdFromJwt(req),
      req.params.integrationId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to test integration");
  }
}

async function connectCompanySallaIntegration(req, res) {
  try {
    const data = await createSallaAuthorizationUrl(
      companyIdFromJwt(req),
      req.params.integrationId,
    );
    res.json({
      success: true,
      data: {
        provider: data.provider,
        integrationId: data.integrationId,
        authorizationUrl: data.authorizationUrl,
      },
    });
  } catch (error) {
    handleIntegrationError(res, error, "Failed to start Salla authorization");
  }
}

module.exports = {
  COMPANY_SELF_SERVICE_PROVIDERS,
  listCompanySelfServiceIntegrations,
  getCompanySelfServiceIntegration,
  createCompanySelfServiceIntegration,
  updateCompanySelfServiceIntegration,
  rotateCompanySelfServiceWebhook,
  testCompanySelfServiceIntegration,
  connectCompanySallaIntegration,
};
