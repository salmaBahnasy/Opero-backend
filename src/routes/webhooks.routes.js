const express = require("express");
const router = express.Router();

const { addWebhookOrder } = require("../services/webhookOrders.service");
const { applyBostaFulfillmentWebhook } = require("../services/webhookOrders.service");
const { runProviderWebhook } = require("../services/webhookTenant.service");
const { sendKnownServiceError } = require("../utils/httpErrors");

function rejectLegacyWebhook(req, res) {
  res.status(401).json({
    success: false,
    code: "WEBHOOK_TOKEN_REQUIRED",
    message: "Webhook token is required. Use the Super Admin generated URL.",
  });
}

async function handleCommerceWebhook(provider, req, res) {
  try {
    const savedOrder = await runProviderWebhook(
      provider,
      req.params.webhookToken,
      async ({ integration }) =>
        addWebhookOrder(req.body, {
          fromWebhook: true,
          sourceIntegrationId: integration.id,
        }),
    );
    res.status(200).json({
      success: true,
      message: "Webhook received",
      data: savedOrder,
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    res.status(500).json({
      success: false,
      message: "Failed to save webhook order",
      error: error.message,
    });
  }
}

async function handleShippingWebhook(provider, req, res) {
  try {
    const payload = req.body || {};
    if (
      !payload.orderAlias &&
      !payload.order_alias &&
      !payload.id &&
      !payload.orderId &&
      !payload.order_id
    ) {
      res.status(400).json({
        success: false,
        message: "orderAlias or shipping order id is required in webhook payload",
      });
      return;
    }

    const updatedOrder = await runProviderWebhook(
      provider,
      req.params.webhookToken,
      async ({ integration }) =>
        applyBostaFulfillmentWebhook(payload, {
          shippingIntegrationId: integration.id,
        }),
    );
    res.status(200).json({
      success: true,
      message: "Shipping webhook processed",
      data: updatedOrder,
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to process shipping webhook",
      error: error.message,
    });
  }
}

router.post("/easyorders/order-created", rejectLegacyWebhook);
router.post("/bosta/order-status", rejectLegacyWebhook);
router.get("/easyorders/orders", (req, res) => {
  res.status(401).json({
    success: false,
    code: "WEBHOOK_TOKEN_REQUIRED",
    message: "Use authenticated /api/orders.",
  });
});

router.post(
  "/easyorders/:webhookToken/order-created",
  (req, res) => handleCommerceWebhook("easyorders", req, res),
);
router.post(
  "/shopify/:webhookToken/orders",
  (req, res) => handleCommerceWebhook("shopify", req, res),
);
router.post(
  "/salla/:webhookToken/orders",
  (req, res) => handleCommerceWebhook("salla", req, res),
);
router.post(
  "/bosta/:webhookToken/order-status",
  (req, res) => handleShippingWebhook("bosta", req, res),
);
router.post(
  "/mylerz/:webhookToken/order-status",
  (req, res) => handleShippingWebhook("mylerz", req, res),
);

module.exports = router;
