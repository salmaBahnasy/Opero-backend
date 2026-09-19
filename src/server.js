const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { createApp } = require("./app");
const { getJwtSecret } = require("./config/jwt");
const { getIntegrationEncryptionKey } = require("./config/integrationSecrets");
const { assertProductionConfig } = require("./config/productionConfig");

getJwtSecret();
getIntegrationEncryptionKey();
assertProductionConfig();

const app = createApp();
const port = Number(process.env.PORT) || 5050;

app.listen(port, () => {
  const env = String(process.env.NODE_ENV || "development");
  console.log(`Server listening on port ${port} (NODE_ENV=${env})`);
});
