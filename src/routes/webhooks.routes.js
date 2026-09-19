const express = require("express");
const router = express.Router();

const { addWebhookOrder } = require("../services/webhookOrders.service");
const { applyBostaFulfillmentWebhook } = require("../services/webhookOrders.service");
const { runProviderWebhook } = require("../services/webhookTenant.service");
const { runWithTenantContext } = require("../utils/tenantScope");
const { markWebhookReceived } = require("../services/companyIntegrations.service");
const { verifyShopifyWebhookRequest } = require("../services/shopifyWebhook.service");
const { persistShopifyOrder } = require("../services/shopifyOrders.service");
const { verifySallaWebhookRequest, verifySallaLifecycleWebhookRequest } = require("../services/sallaWebhook.service");
const { persistSallaOrder } = require("../services/sallaOrders.service");
const {
  applySallaUninstallByMerchant,
  markSallaAuthorizationRevoked,
} = require("../services/sallaAuth.service");
const { sendKnownServiceError } = require("../utils/httpErrors");
const { sendInternalError } = require("../utils/safeError");

function webhookAck(savedOrder, extra = {}) {
  const id = savedOrder?.id || savedOrder?.localOrderId || null;
  return {
    ok: true,
    ...extra,
    data: {
      id,
      localOrderId: id,
      order_id: savedOrder?.order_id || null,
      order_reference: savedOrder?.order_reference ?? null,
      source_integration_id: savedOrder?.source_integration_id || null,
    },
  };
}

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
    res.status(200).json(webhookAck(savedOrder));
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    sendInternalError(res, "Failed to save webhook order", error, "webhook");
  }
}

async function handleShippingWebhook(provider, req, res) {
  if (provider !== "bosta") {
    res.status(501).json({
      success: false,
      code: "SHIPPING_PROVIDER_NOT_IMPLEMENTED",
      message: `${provider} shipping webhooks are not implemented yet`,
    });
    return;
  }
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
    void updatedOrder;
    res.status(200).json(webhookAck(updatedOrder));
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }
    sendInternalError(res, "Failed to process shipping webhook", error, "webhook");
  }
}

async function handleShopifyWebhook(req, res) {
  try {
    const context = await verifyShopifyWebhookRequest(req);
    if (!context.allowedTopic) {
      try {
        await markWebhookReceived(context.integrationId);
      } catch {
        // timestamp is best-effort
      }
      res.status(200).json({
        success: true,
        code: "SHOPIFY_TOPIC_IGNORED",
        message: "Shopify webhook topic is ignored",
        topic: context.topic || null,
      });
      return;
    }

    const savedOrder = await runWithTenantContext(
      {
        companyId: context.companyId,
        integration: context.integration,
      },
      () =>
        persistShopifyOrder({
          companyId: context.companyId,
          sourceIntegrationId: context.sourceIntegrationId,
          topic: context.topic,
          shopDomain: context.shopDomain,
          ingestedVia: "webhook",
          payload: context.payload,
          webhookId:
            req.get?.("X-Shopify-Webhook-Id") ||
            req.headers?.["x-shopify-webhook-id"] ||
            "",
        }),
    );
    try {
      await markWebhookReceived(context.integrationId);
    } catch {
      // timestamp is best-effort
    }
    res.status(200).json(webhookAck(savedOrder, { code: "SHOPIFY_WEBHOOK_ACCEPTED" }));
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "SHOPIFY_WEBHOOK_INVALID_JSON") {
      res.status(400).json({
        success: false,
        code: error.code,
        message: "Invalid webhook payload",
      });
      return;
    }
    sendInternalError(res, "Failed to process Shopify webhook", error, "webhook");
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
async function handleSallaWebhook(req, res) {
  try {
    const context = await verifySallaWebhookRequest(req);
    if (context.uninstallEvent) {
      await markSallaAuthorizationRevoked(context.integration);
      try {
        await markWebhookReceived(context.integrationId);
      } catch {
        // timestamp is best-effort
      }
      res.status(200).json({
        success: true,
        code: "SALLA_UNINSTALLED",
        message: "Salla authorization revoked",
        integrationId: context.integrationId,
      });
      return;
    }
    if (!context.allowedEvent) {
      try {
        await markWebhookReceived(context.integrationId);
      } catch {
        // timestamp is best-effort
      }
      res.status(200).json({
        success: true,
        code: "SALLA_EVENT_IGNORED",
        message: "Salla webhook event is ignored",
        event: context.event || null,
      });
      return;
    }

    const savedOrder = await runWithTenantContext(
      {
        companyId: context.companyId,
        integration: context.integration,
      },
      () =>
        persistSallaOrder({
          companyId: context.companyId,
          sourceIntegrationId: context.sourceIntegrationId,
          integration: context.integration,
          merchantId: context.merchantId,
          event: context.event,
          createdAt: context.createdAt,
          requestId: context.requestId,
          ingestedVia: "webhook",
          data: context.data,
        }),
    );
    try {
      await markWebhookReceived(context.integrationId);
    } catch {
      // timestamp is best-effort
    }
    res.status(200).json(webhookAck(savedOrder, { code: "SALLA_WEBHOOK_ACCEPTED" }));
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "SALLA_WEBHOOK_INVALID_JSON") {
      res.status(400).json({
        success: false,
        code: error.code,
        message: "Invalid webhook payload",
      });
      return;
    }
    sendInternalError(res, "Failed to process Salla webhook", error, "webhook");
  }
}

async function handleSallaLifecycleWebhook(req, res) {
  try {
    const context = await verifySallaLifecycleWebhookRequest(req);
    if (!context.uninstallEvent) {
      res.status(200).json({
        success: true,
        code: "SALLA_EVENT_IGNORED",
        message: "Salla webhook event is ignored",
        event: context.event || null,
      });
      return;
    }
    if (!context.merchantId) {
      res.status(200).json({
        success: true,
        code: "SALLA_EVENT_IGNORED",
        message: "Salla uninstall merchant is unknown",
        event: context.event || null,
      });
      return;
    }
    const result = await applySallaUninstallByMerchant(context.merchantId);
    if (result.ignored) {
      res.status(200).json({
        success: true,
        code: "SALLA_EVENT_IGNORED",
        message: "Salla uninstall merchant is unknown",
        event: context.event || null,
      });
      return;
    }
    res.status(200).json({
      success: true,
      code: "SALLA_UNINSTALLED",
      message: "Salla authorization revoked",
      integrationId: result.integrationId,
    });
  } catch (error) {
    if (sendKnownServiceError(res, error)) return;
    if (error.code === "SALLA_WEBHOOK_INVALID_JSON") {
      res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    sendInternalError(res, "Failed to process Salla lifecycle webhook", error, "webhook");
  }
}

router.post("/shopify/:webhookToken/orders", handleShopifyWebhook);
router.post("/salla/app", handleSallaLifecycleWebhook);
router.post("/salla/:webhookToken/orders", handleSallaWebhook);
router.post(
  "/bosta/:webhookToken/order-status",
  (req, res) => handleShippingWebhook("bosta", req, res),
);
router.post(
  "/mylerz/:webhookToken/order-status",
  (req, res) => handleShippingWebhook("mylerz", req, res),
);

module.exports = router;
