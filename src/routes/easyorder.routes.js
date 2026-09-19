const express = require("express");

const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");
const { login } = require("../controllers/employees.controller");
const {
  getOrdersStats,
  getOrdersAnalytics,
  getProductSalesChartHandler,
  getOrderCosts,
  getOrderCostChartHandler,
  saveOrderCostDailyHandler,
} = require("../controllers/orders.controller");
const ordersRoutes = require("./orders.routes");
const employeesRoutes = require("./employees.routes");
const productsRoutes = require("./products.routes");
const sallaRoutes = require("./salla.routes");
const bostaRoutes = require("./bosta.routes");
const addedOrdersRoutes = require("./addedOrders.routes");

const router = express.Router();

/**
 * Frontend base: /api/easyorder/… mirrors the same handlers as /api/orders, /api/employees, /api/products, /api/salla.
 * Uses the same router modules (mounted again) so paths stay in sync without duplicating handler wiring.
 */
/** @deprecated Use POST /api/employees/login */
router.post("/auth/login", login);

const requireTenant = [requireAuth, bindTenantScope];
const requireOrders = [...requireTenant, requireCompanyFeature("orders")];
const requireAnalytics = [...requireTenant, requireCompanyFeature("analytics")];

/** Some clients use /api/easyorder/stats instead of /api/easyorder/orders/stats */
router.get("/stats", ...requireAnalytics, getOrdersStats);
router.get("/analytics", ...requireAnalytics, getOrdersAnalytics);
router.get("/charts/product-sales", ...requireAnalytics, getProductSalesChartHandler);
router.post("/charts/order-cost", ...requireOrders, saveOrderCostDailyHandler);
router.get("/charts/order-cost", ...requireOrders, getOrderCostChartHandler);
router.get("/costs", ...requireOrders, getOrderCosts);

router.use("/orders", ordersRoutes);
router.use("/employees", employeesRoutes);
router.use("/products", productsRoutes);
router.use("/salla", sallaRoutes);
router.use("/bosta", bostaRoutes);
router.use("/added-orders", addedOrdersRoutes);

module.exports = router;
