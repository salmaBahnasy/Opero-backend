const express = require("express");

const {
  login,
  getEmployees,
  addEmployee,
  deleteEmployee,
  editEmployee,
  setEmployeeActive,
} = require("../controllers/employees.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireCompanyAdmin } = require("../middlewares/tenant.middleware");

const router = express.Router();

router.post("/login", login);
/** @deprecated استخدم `POST /api/employees/login` */
router.post("/login-senior", login);

router.get("/", requireAuth, requireCompanyAdmin, getEmployees);
router.post("/", requireAuth, requireCompanyAdmin, addEmployee);
router.patch("/:employeeId/active", requireAuth, requireCompanyAdmin, setEmployeeActive);
router.patch("/:employeeId", requireAuth, requireCompanyAdmin, editEmployee);
router.delete("/:employeeId", requireAuth, requireCompanyAdmin, deleteEmployee);

module.exports = router;
