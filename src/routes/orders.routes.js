const express = require("express");
const router = express.Router();

const {
  createOrder,
  updateOrder,
  getOrders,
  getOrderByReference,
  changeOrderStatus,
  getEasyOrderDetails,
  refreshCustomerStatus,
  getOrdersStats,
  getOrdersStatsTrend,
  getOrdersAnalytics,
  getProductSalesChartHandler,
  getOrderCosts,
  getOrderCostChartHandler,
  saveOrderCostDailyHandler,
  exportOrders,
} = require("../controllers/orders.controller");
const {
  sendOrderToBosta,
  sendOrdersToBostaBulk,
} = require("../controllers/bostaFulfillment.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");

const requireTenant = [requireAuth, bindTenantScope];

router.get("/stats/trend", ...requireTenant, getOrdersStatsTrend);
router.get("/stats", ...requireTenant, getOrdersStats);
router.get("/analytics", ...requireTenant, getOrdersAnalytics);
router.get("/charts/product-sales", ...requireTenant, getProductSalesChartHandler);
router.post("/charts/order-cost", ...requireTenant, saveOrderCostDailyHandler);
router.get("/charts/order-cost", ...requireTenant, getOrderCostChartHandler);
router.get("/costs", ...requireTenant, getOrderCosts);
router.get("/export", ...requireTenant, exportOrders);
router.post("/export", ...requireTenant, exportOrders);
router.get("/reference/:orderReference", ...requireTenant, getOrderByReference);
router.get("/reference", ...requireTenant, getOrderByReference);
router.post("/send-to-bosta/bulk", ...requireTenant, sendOrdersToBostaBulk);
router.post("/", ...requireTenant, createOrder);
router.patch("/:orderId", ...requireTenant, updateOrder);
router.get("/", ...requireTenant, getOrders);
router.patch("/:orderId/status", ...requireTenant, changeOrderStatus);
router.post(
  "/:orderId/refresh-customer-status",
  ...requireTenant,
  refreshCustomerStatus,
);
router.get("/:orderId", ...requireTenant, getEasyOrderDetails);

router.post("/:orderId/send-to-bosta", ...requireTenant, sendOrderToBosta);

module.exports = router;
