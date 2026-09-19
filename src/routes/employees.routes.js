const express = require("express");

const {
  login,
  getEmployees,
  getEmployeeDirectory,
  getEmployeeById,
  addEmployee,
  deleteEmployee,
  editEmployee,
  setEmployeeActive,
} = require("../controllers/employees.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  requireCompanyAdmin,
  bindTenantScope,
} = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");

const router = express.Router();
const requireEmployeesAdmin = [
  requireAuth,
  bindTenantScope,
  requireCompanyAdmin,
  requireCompanyFeature("employees"),
];
const requireEmployeesDirectory = [
  requireAuth,
  bindTenantScope,
  requireCompanyFeature("employees"),
];

router.post("/login", login);
/** @deprecated Use POST /api/employees/login. Same rate limit, body limit, and validation. */
router.post("/login-senior", login);

router.get("/", ...requireEmployeesAdmin, getEmployees);
router.get("/directory", ...requireEmployeesDirectory, getEmployeeDirectory);
router.post("/", ...requireEmployeesAdmin, addEmployee);
router.get("/:employeeId", ...requireEmployeesAdmin, getEmployeeById);
router.patch("/:employeeId/active", ...requireEmployeesAdmin, setEmployeeActive);
router.patch("/:employeeId", ...requireEmployeesAdmin, editEmployee);
router.delete("/:employeeId", ...requireEmployeesAdmin, deleteEmployee);

module.exports = router;
