const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { createApp } = require("./app");
const { getJwtSecret } = require("./config/jwt");
const { getIntegrationEncryptionKey } = require("./config/integrationSecrets");

getJwtSecret();
getIntegrationEncryptionKey();

const app = createApp();
const port = process.env.PORT || 5050;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
