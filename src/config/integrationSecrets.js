const crypto = require("crypto");

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function getNodeEnv() {
  return String(process.env.NODE_ENV || "").trim().toLowerCase();
}

function parseEncryptionKey(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    const error = new Error(
      "INTEGRATION_ENCRYPTION_KEY is required. Set a 32-byte key (64 hex chars or base64) in .env.",
    );
    error.code = "INTEGRATION_ENCRYPTION_KEY_MISSING";
    throw error;
  }

  if (value === String(process.env.JWT_SECRET || "").trim()) {
    const error = new Error(
      "INTEGRATION_ENCRYPTION_KEY must not be the same as JWT_SECRET.",
    );
    error.code = "INTEGRATION_ENCRYPTION_KEY_INSECURE";
    throw error;
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  const asBase64 = Buffer.from(value, "base64");
  if (asBase64.length === KEY_BYTES) {
    return asBase64;
  }

  if (Buffer.byteLength(value, "utf8") === KEY_BYTES) {
    return Buffer.from(value, "utf8");
  }

  const error = new Error(
    "INTEGRATION_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).",
  );
  error.code = "INTEGRATION_ENCRYPTION_KEY_INVALID";
  throw error;
}

function getIntegrationEncryptionKey() {
  return parseEncryptionKey(process.env.INTEGRATION_ENCRYPTION_KEY);
}

function encryptJson(value) {
  const key = getIntegrationEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

function isEncryptedEnvelope(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number(value.v) === 1 &&
    value.alg === ALG &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.data === "string"
  );
}

function decryptJson(envelope) {
  if (!isEncryptedEnvelope(envelope)) {
    const error = new Error("Invalid encrypted secret envelope");
    error.code = "INTEGRATION_SECRET_INVALID";
    throw error;
  }

  const key = getIntegrationEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALG,
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function hashWebhookToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function generateWebhookToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function maskSecret(secret) {
  const value = String(secret || "");
  if (!value) return null;
  const last4 = value.slice(-4);
  return `****${last4}`;
}

function getNodeEnvName() {
  return getNodeEnv();
}

module.exports = {
  getIntegrationEncryptionKey,
  encryptJson,
  decryptJson,
  isEncryptedEnvelope,
  hashWebhookToken,
  generateWebhookToken,
  maskSecret,
  getNodeEnvName,
};
