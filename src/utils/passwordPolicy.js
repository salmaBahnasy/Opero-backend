const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_BYTES = 72;

function passwordPolicyError(message) {
  const error = new Error(message);
  error.code = "PASSWORD_INVALID";
  error.statusCode = 400;
  return error;
}

function assertPassword(password) {
  if (typeof password !== "string") {
    throw passwordPolicyError("Password must be at least 8 characters");
  }
  if (password.length < MIN_PASSWORD_CHARS) {
    throw passwordPolicyError("Password must be at least 8 characters");
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw passwordPolicyError("Password is too long");
  }
  return password;
}

module.exports = {
  MIN_PASSWORD_CHARS,
  MAX_PASSWORD_BYTES,
  assertPassword,
  passwordPolicyError,
};
