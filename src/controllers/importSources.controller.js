const { sendKnownServiceError } = require("../utils/httpErrors");
const { sendInternalError } = require("../utils/safeError");
const {
  listImportSources,
  getImportSource,
  createImportSource,
  updateImportSource,
} = require("../services/importSources.service");

function handleImportSourceError(res, error, fallbackMessage) {
  if (sendKnownServiceError(res, error)) return;
  if (error.code === "IMPORT_SOURCE_NOT_FOUND") {
    res.status(404).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  if (error.code === "IMPORT_SOURCE_NAME_REQUIRED" || error.code === "INTEGRATION_NAME_REQUIRED") {
    res.status(400).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  if (error.code === "TENANT_CONTEXT_MISSING") {
    res.status(401).json({
      success: false,
      code: error.code,
      message: "Unauthorized. Token must include companyId.",
    });
    return;
  }
  sendInternalError(res, fallbackMessage, error, "imports");
}

async function listSources(req, res) {
  try {
    const data = await listImportSources();
    res.json({ success: true, data });
  } catch (error) {
    handleImportSourceError(res, error, "Failed to list historical migration sources");
  }
}

async function getSource(req, res) {
  try {
    const data = await getImportSource(req.params.sourceId);
    res.json({ success: true, data });
  } catch (error) {
    handleImportSourceError(res, error, "Failed to get historical migration source");
  }
}

async function createSource(req, res) {
  try {
    const data = await createImportSource(req.body || {});
    res.status(201).json({ success: true, data });
  } catch (error) {
    handleImportSourceError(res, error, "Failed to create historical migration source");
  }
}

async function updateSource(req, res) {
  try {
    const data = await updateImportSource(req.params.sourceId, req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleImportSourceError(res, error, "Failed to update historical migration source");
  }
}

module.exports = {
  listSources,
  getSource,
  createSource,
  updateSource,
};
