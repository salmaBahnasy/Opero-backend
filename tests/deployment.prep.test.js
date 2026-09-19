process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { createApp } = require("../src/app");
const {
  assertProductionConfig,
} = require("../src/config/productionConfig");
const { getPublicApiBaseUrl } = require("../src/utils/publicUrl");

describe("Phase 15A deployment preparation", () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("GET /health returns minimal ok payload without secrets", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.service, "saas-backend");
    assert.ok(json.version);
    const blob = JSON.stringify(json);
    assert.equal(blob.includes("SUPABASE"), false);
    assert.equal(blob.includes("JWT"), false);
    assert.equal(blob.includes("service_role"), false);
  });

  it("production config requires HTTPS public URL and CORS allowlist", () => {
    assert.throws(
      () =>
        assertProductionConfig({
          NODE_ENV: "production",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "role",
          JWT_SECRET: "long-secret",
          INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
        }),
      /APP_PUBLIC_BASE_URL/,
    );

    assert.throws(
      () =>
        assertProductionConfig({
          NODE_ENV: "production",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "role",
          JWT_SECRET: "long-secret",
          INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
          APP_PUBLIC_BASE_URL: "http://localhost:5050",
          CORS_ALLOWED_ORIGINS: "https://app.example.com",
        }),
      /https/,
    );

    assert.throws(
      () =>
        assertProductionConfig({
          NODE_ENV: "production",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "role",
          JWT_SECRET: "long-secret",
          INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
          APP_PUBLIC_BASE_URL: "https://api.example.com",
          CORS_ALLOWED_ORIGINS: "*",
        }),
      /wildcard/i,
    );

    assert.doesNotThrow(() =>
      assertProductionConfig({
        NODE_ENV: "production",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "role",
        JWT_SECRET: "long-secret",
        INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
        APP_PUBLIC_BASE_URL: "https://api.example.com",
        CORS_ALLOWED_ORIGINS:
          "https://app.example.com,https://admin.example.com",
      }),
    );
  });

  it("public URL refuses localhost fallback in production", () => {
    const previous = process.env.NODE_ENV;
    const previousUrl = process.env.APP_PUBLIC_BASE_URL;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.APP_PUBLIC_BASE_URL;
      delete process.env.PUBLIC_BASE_URL;
      delete process.env.API_PUBLIC_BASE_URL;
      assert.throws(() => getPublicApiBaseUrl(), /APP_PUBLIC_BASE_URL/);
    } finally {
      process.env.NODE_ENV = previous;
      if (previousUrl == null) delete process.env.APP_PUBLIC_BASE_URL;
      else process.env.APP_PUBLIC_BASE_URL = previousUrl;
    }
  });

  it("platform admin bootstrap script exists and is confirm-gated", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../scripts/bootstrap-platform-admin.js"),
      "utf8",
    );
    assert.match(src, /--confirm/);
    assert.match(src, /platform_admins/);
    assert.match(src, /bcrypt/);
    assert.equal(src.includes("DevPassword123!"), false);
    assert.equal(src.includes("app.post"), false);
  });

  it("does not introduce migration 016", () => {
    const dir = path.join(__dirname, "../supabase/migrations");
    const files = fs.readdirSync(dir);
    assert.equal(files.some((name) => name.startsWith("016")), false);
  });
});
