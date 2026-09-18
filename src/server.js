const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { getJwtSecret } = require("./config/jwt");
const { createApp } = require("./app");

getJwtSecret();

const app = createApp();
const port = process.env.PORT || 5050;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
