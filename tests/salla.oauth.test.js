process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";
process.env.INTEGRATION_ENCRYPTION_KEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.APP_PUBLIC_BASE_URL = "https://api.example.test";
process.env.PLATFORM_ADMIN_PUBLIC_BASE_URL = "https://admin.example.test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SALLA_OAUTH_CLIENT_ID = "salla-client-id";
process.env.SALLA_OAUTH_CLIENT_SECRET = "salla-client-secret";
process.env.SALLA_OAUTH_REDIRECT_URI =
  "https://api.example.test/api/integrations/salla/oauth/callback";
process.env.SALLA_OAUTH_STATE_SECRET = "salla-oauth-state-secret-test";
process.env.SALLA_APP_WEBHOOK_SECRET = "salla-app-webhook-secret";
process.env.SHOPIFY_ADMIN_API_VERSION = "2026-07";

const { describe, it, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const { createFakeSupabase } = require("./helpers/fakeSupabase");
const supabase = require("../src/config/supabase");
const { createApp } = require("../src/app");
const { signEmployeeToken } = require("../src/config/jwt");
const {
  encryptJson,
  decryptJson,
  isEncryptedEnvelope,
} = require("../src/config/integrationSecrets");
const {
  signSallaOauthState,
  verifySallaOauthState,
} = require("../src/services/sallaAuth.service");
const { getSallaOauthConfig } = require("../src/config/salla");
const {
  ensureSallaAccessToken,
  sallaUserInfo,
  resetSallaRefreshLocksForTests,
} = require("../src/services/sallaClient.service");

const ENAYA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLATFORM_ADMIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ENAYA_ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FEATURE_ORDERS = "f1111111-1111-4111-8111-111111111111";
const FEATURE_PRODUCTS = "f2222222-2222-4222-8222-222222222222";
const FEATURE_EMPLOYEES = "f3333333-3333-4333-8333-333333333333";
const FEATURE_ANALYTICS = "f4444444-4444-4444-8444-444444444444";
const DEV_PASSWORD = "DevPassword123!";
const AUTH_CODE = "salla-auth-code-never-log";

let passwordHash;
let server;
let baseUrl;
let fake;
let tokenPosts = [];
let userInfoGets = 0;
let userInfoImpl = null;
let tokenImpl = null;
const originalAxiosGet = axios.get;
const originalAxiosPost = axios.post;
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
const capturedLogs = [];

function tokenFromWebhookUrl(url) {
  const parts = String(url || "").split("/");
  const idx = parts.indexOf("webhooks");
  return idx >= 0 ? decodeURIComponent(parts[idx + 2] || "") : "";
}

function recordLog(...args) {
  capturedLogs.push(args.map((item) => String(item)).join(" "));
}

async function request(method, pathName, { token, body, redirect } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: redirect || "follow",
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return {
    status: response.status,
    json,
    text,
    location: response.headers.get("location"),
  };
}

function employeeToken(companyId, employeeId, email) {
  return signEmployeeToken({
    employeeId,
    companyId,
    role: "company_admin",
    email,
  });
}

function seedClient() {
  return createFakeSupabase({
    companies: [
      { id: ENAYA_ID, name: "Enaya", slug: "enaya", is_active: true, deleted_at: null },
      { id: OTHER_ID, name: "Other Co", slug: "other", is_active: true, deleted_at: null },
    ],
    platform_admins: [
      {
        id: PLATFORM_ADMIN_ID,
        name: "Platform Super Admin",
        email: "platform@saas.local",
        password: passwordHash,
        is_active: true,
      },
    ],
    employees: [
      {
        id: ENAYA_ADMIN_ID,
        company_id: ENAYA_ID,
        name: "Enaya Admin",
        email: "admin@enaya.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
      {
        id: OTHER_ADMIN_ID,
        company_id: OTHER_ID,
        name: "Other Admin",
        email: "admin@other.local",
        password: passwordHash,
        role: "company_admin",
        is_active: true,
      },
    ],
    features: [
      { id: FEATURE_ORDERS, key: "orders", is_active: true },
      { id: FEATURE_PRODUCTS, key: "products", is_active: true },
      { id: FEATURE_EMPLOYEES, key: "employees", is_active: true },
      { id: FEATURE_ANALYTICS, key: "analytics", is_active: true },
    ],
    company_features: [
      { company_id: ENAYA_ID, feature_id: FEATURE_ORDERS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_PRODUCTS, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_EMPLOYEES, is_enabled: true },
      { company_id: ENAYA_ID, feature_id: FEATURE_ANALYTICS, is_enabled: true },
    ],
    orders: [],
    products: [],
    company_integrations: [],
  });
}

async function loginPlatform() {
  const { status, json } = await request("POST", "/api/platform/auth/login", {
    body: { email: "platform@saas.local", password: DEV_PASSWORD },
  });
  assert.equal(status, 200);
  return json.token;
}

async function createConnection(token, companyId, body) {
  const { status, json } = await request(
    "POST",
    `/api/platform/companies/${companyId}/integrations`,
    { token, body },
  );
  assert.equal(status, 201, json?.message || "create connection failed");
  return json.data;
}

function rowById(id) {
  return fake.__db.company_integrations.find((row) => String(row.id) === String(id));
}

function markConnected(id, patch = {}) {
  const row = rowById(id);
  row.credentials = encryptJson({
    accessToken: patch.accessToken || "access-old",
    refreshToken: patch.refreshToken || "refresh-old",
    tokenType: "bearer",
    scope: "offline_access",
  });
  row.settings = {
    ...(row.settings || {}),
    authorizationStatus: "connected",
    tokenExpiresAt:
      patch.tokenExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    merchantName: patch.merchantName || "Enaya Store",
  };
  row.provider_account_id = String(patch.merchantId || "1001");
  if (patch.enabled === false) row.is_enabled = false;
  return row;
}

function assertNoSecrets(payload) {
  const blob = JSON.stringify(payload);
  for (const value of [
    "salla-client-secret",
    "salla-oauth-state-secret-test",
    "salla-app-webhook-secret",
    AUTH_CODE,
    "access-new",
    "refresh-new",
    "access-old",
    "refresh-old",
    "refresh-rotated",
  ]) {
    assert.equal(blob.includes(value), false, `leaked ${value}`);
  }
}

before(async () => {
  passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const app = createApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  fake = seedClient();
  supabase.__setClientForTests(fake);
  resetSallaRefreshLocksForTests();
  tokenPosts = [];
  userInfoGets = 0;
  capturedLogs.length = 0;
  userInfoImpl = async () => ({
    status: 200,
    data: { data: { merchant: { id: 1001, name: "Enaya Store" } } },
  });
  tokenImpl = async (params) => {
    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      return {
        status: 200,
        data: {
          access_token: "access-new",
          refresh_token: "refresh-new",
          token_type: "bearer",
          scope: "offline_access",
          expires_in: 3600,
        },
      };
    }
    return {
      status: 200,
      data: {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        token_type: "bearer",
        expires_in: 3600,
      },
    };
  };
  axios.get = async (url, config) => {
    userInfoGets += 1;
    return userInfoImpl(url, config);
  };
  axios.post = async (url, body, config) => {
    const params = new URLSearchParams(String(body || ""));
    tokenPosts.push({ url: String(url), params, body: String(body || "") });
    return tokenImpl(params, config);
  };
  console.log = recordLog;
  console.info = recordLog;
  console.warn = recordLog;
  console.error = recordLog;
});

afterEach(() => {
  axios.get = originalAxiosGet;
  axios.post = originalAxiosPost;
  console.log = originalLog;
  console.info = originalInfo;
  console.warn = originalWarn;
  console.error = originalError;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

describe("PHASE 7I-B2 Salla OAuth + token lifecycle", () => {
  it("1-2. creates a pending Salla connection without requiring accessToken", async () => {
    const token = await loginPlatform();
    const created = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
      enabled: true,
    });
    assert.equal(created.authorizationStatus, "pending");
    assert.equal(created.configured, false);
    assert.equal(created.apiKeyMasked, null);
    assertNoSecrets(created);
    const row = rowById(created.id);
    const secrets = decryptJson(row.credentials);
    assert.equal(Boolean(secrets.accessToken), false);
  });

  it("3-6. OAuth connect is platform-admin only, company-bound, and Salla-only", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    const shopify = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "shopify",
      name: "Enaya Shopify",
      credentials: {
        accessToken: "shpat-test",
        webhookSecret: "whsec",
        shopDomain: "enaya-eg.myshopify.com",
      },
    });
    const otherSalla = await createConnection(token, OTHER_ID, {
      category: "commerce",
      provider: "salla",
      name: "Other Salla",
    });
    const companyJwt = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const companyAttempt = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token: companyJwt },
    );
    assert.equal(companyAttempt.status, 403);

    const cross = await request(
      "POST",
      `/api/platform/companies/${OTHER_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    assert.equal(cross.status, 403);
    assert.equal(cross.json.code, "INTEGRATION_NOT_OWNED");

    const wrongProvider = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${shopify.id}/salla/connect`,
      { token },
    );
    assert.equal(wrongProvider.status, 400);
    assert.equal(wrongProvider.json.code, "SALLA_PROVIDER_MISMATCH");

    const ok = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.provider, "salla");
    assert.equal(ok.json.data.integrationId, salla.id);
    assert.match(ok.json.data.authorizationUrl, /accounts\.salla\.sa/);
    assert.equal(ok.json.data.authorizationUrl.includes("client_secret"), false);
    assert.equal(JSON.stringify(ok.json).includes("salla-client-secret"), false);
    void otherSalla;
  });

  it("7-13. signed state binds company/integration, expires, is one-time, and rotates nonce", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    const first = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    const url = new URL(first.json.data.authorizationUrl);
    const state = url.searchParams.get("state");
    const verified = verifySallaOauthState(state, getSallaOauthConfig().stateSecret);
    assert.equal(verified.companyId, ENAYA_ID);
    assert.equal(verified.integrationId, salla.id);
    assert.ok(verified.nonce);

    const expired = signSallaOauthState(
      {
        companyId: ENAYA_ID,
        integrationId: salla.id,
        nonce: verified.nonce,
        exp: Date.now() - 1000,
      },
      getSallaOauthConfig().stateSecret,
    );
    const expiredCb = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(expired)}`,
      { redirect: "manual" },
    );
    assert.equal(expiredCb.status, 302);
    assert.match(expiredCb.location, /SALLA_OAUTH_STATE_EXPIRED/);

    const tampered = `${state.slice(0, -2)}xx`;
    const tamperCb = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(tampered)}`,
      { redirect: "manual" },
    );
    assert.equal(tamperCb.status, 400);
    assert.match(String(tamperCb.text || tamperCb.json?.raw || ""), /SALLA_OAUTH_STATE_INVALID/);

    const second = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    const secondState = new URL(second.json.data.authorizationUrl).searchParams.get("state");
    const replay = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(replay.status, 302);
    assert.match(replay.location, /SALLA_OAUTH_STATE_INVALID/);
    const secondVerified = verifySallaOauthState(
      secondState,
      getSallaOauthConfig().stateSecret,
    );
    assert.notEqual(secondVerified.nonce, verified.nonce);
  });

  it("14-23. callback exchanges code, encrypts tokens, and binds the merchant", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    const connect = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    const state = new URL(connect.json.data.authorizationUrl).searchParams.get("state");
    const missing = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?companyId=${OTHER_ID}`,
      { redirect: "manual" },
    );
    assert.equal(missing.status, 400);

    const cb = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}&companyId=${OTHER_ID}`,
      { redirect: "manual" },
    );
    assert.equal(cb.status, 302);
    assert.match(cb.location, new RegExp(`/platform/companies/${ENAYA_ID}`));
    assert.match(cb.location, /salla=connected/);
    assert.equal(cb.location.includes(AUTH_CODE), false);
    assert.equal(cb.location.includes("access-new"), false);
    assert.equal(
      capturedLogs.some((line) => line.includes(AUTH_CODE)),
      false,
    );

    const listed = await request(
      "GET",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}`,
      { token },
    );
    assert.equal(listed.json.data.authorizationStatus, "connected");
    assert.equal(listed.json.data.providerAccountId, "1001");
    assert.equal(listed.json.data.merchantName, "Enaya Store");
    assert.ok(listed.json.data.tokenExpiresAt);
    assertNoSecrets(listed.json);

    const row = rowById(salla.id);
    assert.equal(isEncryptedEnvelope(row.credentials), true);
    const secrets = decryptJson(row.credentials);
    assert.equal(secrets.accessToken, "access-new");
    assert.equal(secrets.refreshToken, "refresh-new");
    assert.equal(row.company_id, ENAYA_ID);
    assert.equal(JSON.stringify(row.settings).includes("access-new"), false);
  });

  it("24-25. reconnect requires the same merchant", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    markConnected(salla.id, { merchantId: "1001", accessToken: "access-old", refreshToken: "refresh-old" });

    const connect = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    const state = new URL(connect.json.data.authorizationUrl).searchParams.get("state");
    const same = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(same.status, 302);
    assert.match(same.location, /salla=connected/);
    assert.equal(decryptJson(rowById(salla.id).credentials).accessToken, "access-new");

    const connect2 = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/salla/connect`,
      { token },
    );
    const state2 = new URL(connect2.json.data.authorizationUrl).searchParams.get("state");
    userInfoImpl = async () => ({
      status: 200,
      data: { data: { merchant: { id: 2002, name: "Other Merchant" } } },
    });
    const mismatch = await request(
      "GET",
      `/api/integrations/salla/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state2)}`,
      { redirect: "manual" },
    );
    assert.equal(mismatch.status, 302);
    assert.match(mismatch.location, /SALLA_MERCHANT_MISMATCH/);
    assert.equal(rowById(salla.id).provider_account_id, "1001");
    assert.equal(decryptJson(rowById(salla.id).credentials).accessToken, "access-new");
  });

  it("26-29. near-expiry refresh rotates tokens once per store", async () => {
    const token = await loginPlatform();
    const storeA = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Store A",
    });
    const storeB = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Store B",
    });
    markConnected(storeA.id, {
      merchantId: "1001",
      tokenExpiresAt: new Date(Date.now() + 10 * 1000).toISOString(),
      accessToken: "access-a",
      refreshToken: "refresh-a",
    });
    markConnected(storeB.id, {
      merchantId: "2002",
      merchantName: "Store B",
      tokenExpiresAt: new Date(Date.now() + 10 * 1000).toISOString(),
      accessToken: "access-b",
      refreshToken: "refresh-b",
    });

    const rowA = rowById(storeA.id);
    await Promise.all(
      Array.from({ length: 5 }, () => ensureSallaAccessToken(rowA, { allowDisabled: true })),
    );
    const refreshA = tokenPosts.filter((row) => row.params.get("grant_type") === "refresh_token");
    assert.equal(refreshA.length, 1);
    assert.equal(decryptJson(rowById(storeA.id).credentials).refreshToken, "refresh-rotated");
    assert.equal(rowById(storeA.id).provider_account_id, "1001");

    tokenPosts.length = 0;
    await ensureSallaAccessToken(rowById(storeB.id), { allowDisabled: true });
    const refreshB = tokenPosts.filter((row) => row.params.get("grant_type") === "refresh_token");
    assert.equal(refreshB.length, 1);
    assert.equal(refreshB[0].params.get("refresh_token"), "refresh-b");
  });

  it("30-32. one 401 refresh+retry, then revoked refresh is persisted", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    markConnected(salla.id, {
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    let gets = 0;
    userInfoImpl = async () => {
      gets += 1;
      if (gets === 1) return { status: 401, data: { error: { details: "raw provider body" } } };
      return {
        status: 200,
        data: { data: { merchant: { id: 1001, name: "Enaya Store" } } },
      };
    };
    await sallaUserInfo({ integration: rowById(salla.id), allowDisabled: true });
    assert.equal(gets, 2);
    assert.equal(
      tokenPosts.filter((row) => row.params.get("grant_type") === "refresh_token").length,
      1,
    );

    markConnected(salla.id, {
      refreshToken: "refresh-dead",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    userInfoImpl = async () => ({ status: 401, data: { error: { details: "revoked" } } });
    tokenImpl = async () => ({ status: 401, data: { error: "invalid_grant" } });
    await assert.rejects(
      () => sallaUserInfo({ integration: rowById(salla.id), allowDisabled: true }),
      (error) => error.code === "SALLA_AUTHORIZATION_REVOKED",
    );
    assert.equal(rowById(salla.id).settings.authorizationStatus, "revoked");
  });

  it("33-35. live testConnection returns safe merchant metadata", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    const pending = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/test`,
      { token },
    );
    assert.equal(pending.status, 409);
    assert.equal(pending.json.code, "SALLA_AUTHORIZATION_PENDING");

    markConnected(salla.id);
    const ok = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/test`,
      { token },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.connected, true);
    assert.equal(ok.json.data.merchantId, "1001");
    assert.equal(ok.json.data.merchantName, "Enaya Store");
    assert.equal(ok.json.data.integrationId, salla.id);
    assertNoSecrets(ok.json);

    userInfoImpl = async () => ({
      status: 200,
      data: { data: { merchant: { id: 9999, name: "Wrong" } } },
    });
    const mismatch = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${salla.id}/test`,
      { token },
    );
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.code, "SALLA_MERCHANT_MISMATCH");
    assertNoSecrets(mismatch.json);
  });

  it("36-39. exact-connection, bootstrap, pending/revoked/disabled are not operational", async () => {
    const token = await loginPlatform();
    const pending = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Pending Salla",
    });
    const revoked = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Revoked Salla",
    });
    const disabled = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Disabled Salla",
    });
    const live = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Live Salla",
    });
    markConnected(revoked.id);
    rowById(revoked.id).settings.authorizationStatus = "revoked";
    markConnected(disabled.id, { enabled: false });
    markConnected(live.id, { merchantName: "Live Store" });

    const companyJwt = employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local");
    const autoPick = await request("POST", "/api/salla/auth/login", { token: companyJwt });
    assert.equal(autoPick.status, 400);
    assert.equal(autoPick.json.code, "SALLA_INTEGRATION_REQUIRED");
    const proxy = await request("GET", "/api/salla/orders", { token: companyJwt });
    assert.equal(proxy.status, 409);
    assert.equal(proxy.json.code, "SALLA_INTEGRATION_REQUIRED");
    const easyProxy = await request("GET", "/api/easyorder/salla/orders", {
      token: companyJwt,
    });
    assert.equal(easyProxy.status, 409);

    const bootstrap = await request("GET", "/api/company/bootstrap", { token: companyJwt });
    assert.equal(bootstrap.status, 200);
    const names = bootstrap.json.data.integrations.commerce.map((row) => row.name);
    assert.equal(names.includes("Live Salla"), true);
    assert.equal(names.includes("Pending Salla"), false);
    assert.equal(names.includes("Revoked Salla"), false);
    assert.equal(names.includes("Disabled Salla"), false);
    assertNoSecrets(bootstrap.json);
    void pending;
  });

  it("40-45. Salla generic webhook cannot persist; other providers stay intact", async () => {
    const token = await loginPlatform();
    const salla = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "salla",
      name: "Enaya Salla",
    });
    const eo = await createConnection(token, ENAYA_ID, {
      category: "commerce",
      provider: "easyorders",
      name: "Enaya EO",
      credentials: { apiKey: "eo-secret" },
    });
    const bosta = await createConnection(token, ENAYA_ID, {
      category: "shipping",
      provider: "bosta",
      name: "Enaya Bosta",
      credentials: { apiKey: "bosta-secret" },
    });
    markConnected(salla.id);
    const before = fake.__db.orders.length;
    const sallaHook = await request(
      "POST",
      `/webhooks/salla/${tokenFromWebhookUrl(salla.webhookUrl)}/orders`,
      { body: { id: "salla-should-not-write", company_id: ENAYA_ID } },
    );
    assert.equal(sallaHook.status, 401);
    assert.equal(sallaHook.json.code, "SALLA_WEBHOOK_HMAC_INVALID");
    assert.equal(fake.__db.orders.length, before);

    const eoHook = await request(
      "POST",
      `/webhooks/easyorders/${tokenFromWebhookUrl(eo.webhookUrl)}/order-created`,
      { body: { id: "eo-ok", full_name: "EO" } },
    );
    assert.equal(eoHook.status, 200);
    assert.equal(fake.__db.orders.some((row) => row.order_id === "eo-ok"), true);

    const shopifyHook = await request("POST", "/webhooks/shopify/not-a-token/orders", {
      body: { id: 1 },
    });
    assert.notEqual(shopifyHook.json?.code, "SALLA_WEBHOOK_NOT_READY");

    const bostaTest = await request(
      "POST",
      `/api/platform/companies/${ENAYA_ID}/integrations/${bosta.id}/test`,
      { token },
    );
    assert.equal(bostaTest.status, 200);
    assert.equal(bostaTest.json.data.provider, "bosta");

    const shopifyImport = await request("POST", "/api/orders/import", {
      token: employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local"),
      body: {},
    });
    assert.notEqual(shopifyImport.json?.code, "SALLA_WEBHOOK_NOT_READY");
    const shopifySync = await request("POST", "/api/products/sync", {
      token: employeeToken(ENAYA_ID, ENAYA_ADMIN_ID, "admin@enaya.local"),
      body: { provider: "shopify" },
    });
    assert.notEqual(shopifySync.json?.code, "SALLA_WEBHOOK_NOT_READY");
  });

  it("46. does not add extra Migration 015 files beyond atomic signup", () => {
    const migrations = path.join(__dirname, "../supabase/migrations");
    const files = fs.readdirSync(migrations);
    assert.equal(files.some((name) => name.startsWith("014_")), true);
    assert.equal(
      files.some((name) => name.startsWith("015_") && name !== "015_atomic_company_signup.sql"),
      false,
    );
  });
});
