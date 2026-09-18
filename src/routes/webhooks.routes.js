const express = require("express");
const router = express.Router();

const { addWebhookOrder } = require("../services/webhookOrders.service");
const {
  handleBostaOrderStatusWebhook,
} = require("../controllers/bostaFulfillment.controller");

router.post("/bosta/order-status", handleBostaOrderStatusWebhook);

router.post("/easyorders/order-created", async (req, res) => {
  try {
    // Phase 4: resolve company from company_integrations. Do not guess tenant.
    const savedOrder = await addWebhookOrder(req.body, { fromWebhook: true });

    res.status(200).json({
      success: true,
      message: "Webhook received",
      data: savedOrder,
    });
  } catch (error) {
    if (error.code === "TENANT_CONTEXT_MISSING") {
      res.status(503).json({
        success: false,
        code: "TENANT_CONTEXT_MISSING",
        message:
          "EasyOrders webhook tenant resolution is not implemented yet. This endpoint cannot guess companyId.",
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to save webhook order",
      error: error.message,
    });
  }
});

router.get("/easyorders/orders", async (req, res) => {
  res.status(503).json({
    success: false,
    code: "TENANT_CONTEXT_MISSING",
    message:
      "Listing webhook orders without tenant context is disabled. Use authenticated /api/orders. Webhook tenant resolution is Phase 4.",
  });
});

module.exports = router;
