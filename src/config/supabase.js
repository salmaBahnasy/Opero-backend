const path = require("path");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Supabase env missing: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a .env file at the project root (copy from .env.example).",
  );
}

const realClient = createClient(supabaseUrl, supabaseKey);
let activeClient = realClient;

const supabase = {
  from(...args) {
    return activeClient.from(...args);
  },
  rpc(...args) {
    return activeClient.rpc(...args);
  },
  __setClientForTests(nextClient) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("supabase test client can only be replaced when NODE_ENV=test");
    }
    activeClient = nextClient || realClient;
  },
};

module.exports = supabase;
