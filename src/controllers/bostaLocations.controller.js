const {
  syncBostaLocationsFromApi,
  getCitiesFromDb,
  getDistrictsFromDb,
  getZonesFromDb,
} = require("../services/bostaLocations.service");
const { sendInternalError, shouldExposeErrorDetails } = require("../utils/safeError");

function pickLocationSearchQuery(req) {
  const raw =
    req.query.q ?? req.query.search ?? req.query.name ?? req.query.query;
  if (raw == null) return undefined;
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  return s === "" ? undefined : s;
}

async function syncLocations(req, res) {
  try {
    const result = await syncBostaLocationsFromApi();
    res.json({
      success: true,
      message: "Bosta cities and districts synced to database",
      data: result,
    });
  } catch (error) {
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        setupHint: shouldExposeErrorDetails() ? error.setupHint : undefined,
      });
      return;
    }
    if (error.code === "BOSTA_HTTP_ERROR") {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
        success: false,
        message: shouldExposeErrorDetails() ? error.message : "Bosta request failed",
        code: error.code,
      });
      return;
    }
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function listCities(req, res) {
  try {
    const search = pickLocationSearchQuery(req);
    const payload = await getCitiesFromDb({ search });
    res.json(payload);
  } catch (error) {
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        setupHint: shouldExposeErrorDetails() ? error.setupHint : undefined,
      });
      return;
    }
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function listDistricts(req, res) {
  try {
    const { cityId } = req.params;
    const search = pickLocationSearchQuery(req);
    const payload = await getDistrictsFromDb(cityId, { search });
    res.json(payload);
  } catch (error) {
    if (error.code === "INVALID_CITY_ID") {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error.code === "CITY_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        setupHint: shouldExposeErrorDetails() ? error.setupHint : undefined,
      });
      return;
    }
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

async function listZones(req, res) {
  try {
    const { cityId } = req.params;
    const search = pickLocationSearchQuery(req);
    const payload = await getZonesFromDb(cityId, { search });
    res.json(payload);
  } catch (error) {
    if (error.code === "INVALID_CITY_ID") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "CITY_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        setupHint: shouldExposeErrorDetails() ? error.setupHint : undefined,
      });
      return;
    }
    sendInternalError(res, "Request failed", error, "bosta");
  }
}

module.exports = {
  syncLocations,
  listCities,
  listDistricts,
  listZones,
};
