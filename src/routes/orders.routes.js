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
const { sendOrderToBosta, sendOrdersToBostaBulk } =
  require("../controllers/bostaFulfillment.controller");
const { importOrders } = require("../controllers/ordersImport.controller");
const { requireAuth } = require("../middlewares/auth.middleware");
const { bindTenantScope } = require("../middlewares/tenant.middleware");
const { requireCompanyFeature } = require("../middlewares/feature.middleware");
const { requireCompanyAdmin } = require("../middlewares/tenant.middleware");

const requireTenant = [requireAuth, bindTenantScope];
const requireOrders = [...requireTenant, requireCompanyFeature("orders")];
const requireAnalytics = [...requireTenant, requireCompanyFeature("analytics")];
const requireBosta = [...requireTenant, requireCompanyFeature("bosta")];
const requireImportAdmin = [
  ...requireTenant,
  requireCompanyAdmin,
  requireCompanyFeature("imports"),
];

router.get("/stats/trend", ...requireAnalytics, getOrdersStatsTrend);
router.get("/stats", ...requireAnalytics, getOrdersStats);
router.get("/analytics", ...requireAnalytics, getOrdersAnalytics);
router.get("/charts/product-sales", ...requireAnalytics, getProductSalesChartHandler);
router.post("/charts/order-cost", ...requireOrders, saveOrderCostDailyHandler);
router.get("/charts/order-cost", ...requireOrders, getOrderCostChartHandler);
router.get("/costs", ...requireOrders, getOrderCosts);
router.get("/export", ...requireOrders, exportOrders);
router.post("/export", ...requireOrders, exportOrders);
router.get("/reference/:orderReference", ...requireOrders, getOrderByReference);
router.get("/reference", ...requireOrders, getOrderByReference);
router.post("/send-to-bosta/bulk", ...requireBosta, sendOrdersToBostaBulk);
router.post("/import", ...requireImportAdmin, importOrders);
router.post("/", ...requireOrders, createOrder);
router.patch("/:orderId", ...requireOrders, updateOrder);
router.get("/", ...requireOrders, getOrders);
router.patch("/:orderId/status", ...requireOrders, changeOrderStatus);
router.post(
  "/:orderId/refresh-customer-status",
  ...requireOrders,
  refreshCustomerStatus,
);
router.get("/:orderId", ...requireOrders, getEasyOrderDetails);

router.post("/:orderId/send-to-bosta", ...requireBosta, sendOrderToBosta);

module.exports = router;
