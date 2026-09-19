const express = require("express");

const {
  applyTrustProxy,
  createCorsMiddleware,
  createHelmetMiddleware,
} = require("./config/httpSecurity");
const {
  createLoginLimiter,
  createPlatformLoginLimiter,
  createSignupLimiter,
  createTokenWebhookLimiter,
} = require("./middlewares/rateLimit.middleware");
const ordersRoutes = require("./routes/orders.routes");
const webhooksRoutes = require("./routes/webhooks.routes");
const employeesRoutes = require("./routes/employees.routes");
const productsRoutes = require("./routes/products.routes");
const sallaRoutes = require("./routes/salla.routes");
const easyorderRoutes = require("./routes/easyorder.routes");
const bostaRoutes = require("./routes/bosta.routes");
const addedOrdersRoutes = require("./routes/addedOrders.routes");
const platformRoutes = require("./routes/platform.routes");
const companyRoutes = require("./routes/company.routes");
const publicRoutes = require("./routes/public.routes");
const costsRoutes = require("./routes/costs.routes");
const sallaOauthPublicRoutes = require("./routes/sallaOauthPublic.routes");
const importSourcesRoutes = require("./routes/importSources.routes");
const analyticsRoutes = require("./routes/analytics.routes");

const AUTH_JSON_LIMIT = "32kb";
const TOKEN_WEBHOOK_JSON_LIMIT = "1mb";

function attachRawWebhookBody(req, _res, next) {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
  } else if (typeof req.body === "string") {
    req.rawBody = Buffer.from(req.body);
  } else {
    req.rawBody = Buffer.alloc(0);
  }
  next();
}

function createApp() {
  const app = express();
  applyTrustProxy(app);
  app.disable("x-powered-by");
  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware());

  const authJson = express.json({ limit: AUTH_JSON_LIMIT });
  const employeeLoginLimiter = createLoginLimiter();
  app.use("/api/employees/login", employeeLoginLimiter, authJson);
  app.use("/api/employees/login-senior", employeeLoginLimiter, authJson);
  app.use("/api/easyorder/auth/login", employeeLoginLimiter, authJson);
  app.use("/api/platform/auth/login", createPlatformLoginLimiter(), authJson);
  app.use("/api/public/signup", createSignupLimiter(), authJson);

  const tokenWebhookLimiter = createTokenWebhookLimiter();
  app.use(
    "/webhooks/easyorders",
    tokenWebhookLimiter,
    express.json({ limit: TOKEN_WEBHOOK_JSON_LIMIT }),
  );
  app.use(
    "/webhooks/bosta",
    tokenWebhookLimiter,
    express.json({ limit: TOKEN_WEBHOOK_JSON_LIMIT }),
  );
  app.use(
    "/webhooks/mylerz",
    tokenWebhookLimiter,
    express.json({ limit: TOKEN_WEBHOOK_JSON_LIMIT }),
  );

  app.use(
    "/webhooks/shopify",
    express.raw({ type: "*/*", limit: "10mb" }),
    attachRawWebhookBody,
  );
  app.use(
    "/webhooks/salla",
    express.raw({ type: "*/*", limit: "10mb" }),
    attachRawWebhookBody,
  );
  app.use(express.json({ limit: "10mb" }));

  app.get("/", (req, res) => {
    res.json({
      message: "EasyOrder Bosta Backend is running",
    });
  });

  app.get("/health", (req, res) => {
    const { getPackageVersion } = require("./config/productionConfig");
    res.status(200).json({
      ok: true,
      service: "saas-backend",
      version: getPackageVersion(),
    });
  });

  app.use("/api/orders", ordersRoutes);
  app.use("/webhooks", webhooksRoutes);
  app.use("/api/employees", employeesRoutes);
  app.use("/api/easyorder", easyorderRoutes);
  app.use("/api/products", productsRoutes);
  app.use("/api/salla", sallaRoutes);
  app.use("/api/integrations/salla", sallaOauthPublicRoutes);
  app.use("/api/bosta", bostaRoutes);
  app.use("/api/added-orders", addedOrdersRoutes);
  app.use("/api/platform", platformRoutes);
  app.use("/api/company", companyRoutes);
  app.use("/api/costs", costsRoutes);
  app.use("/api/import-sources", importSourcesRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/public", publicRoutes);

  return app;
}

module.exports = { createApp };
