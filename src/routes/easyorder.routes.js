const express = require("express");

const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
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
router.post("/auth/login", login);

const requireTenant = [requireAuth, bindTenantScope];

/** Some clients use /api/easyorder/stats instead of /api/easyorder/orders/stats */
router.get("/stats", ...requireTenant, getOrdersStats);
router.get("/analytics", ...requireTenant, getOrdersAnalytics);
router.get("/charts/product-sales", ...requireTenant, getProductSalesChartHandler);
router.post("/charts/order-cost", ...requireTenant, saveOrderCostDailyHandler);
router.get("/charts/order-cost", ...requireTenant, getOrderCostChartHandler);
router.get("/costs", ...requireTenant, getOrderCosts);

router.use("/orders", ordersRoutes);
router.use("/employees", employeesRoutes);
router.use("/products", productsRoutes);
router.use("/salla", sallaRoutes);
router.use("/bosta", bostaRoutes);
router.use("/added-orders", addedOrdersRoutes);

module.exports = router;
