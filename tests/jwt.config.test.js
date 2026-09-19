process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getJwtSecret,
  signEmployeeToken,
  verifyEmployeeToken,
  signPlatformAdminToken,
  verifyPlatformAdminToken,
} = require("../src/config/jwt");

describe("JWT configuration", () => {
  it("signs and verifies a tenant payload", () => {
    const token = signEmployeeToken({
      employeeId: "emp-1",
      companyId: "co-1",
      role: "company_admin",
      email: "a@b.c",
    });
    const decoded = verifyEmployeeToken(token);
    assert.equal(decoded.employeeId, "emp-1");
    assert.equal(decoded.companyId, "co-1");
    assert.equal(decoded.role, "company_admin");
    assert.equal(decoded.email, "a@b.c");
  });

  it("rejects a token without companyId", () => {
    const jwt = require("jsonwebtoken");
    const token = jwt.sign(
      { employeeId: "emp-1", role: "company_admin", email: "a@b.c" },
      process.env.JWT_SECRET,
    );
    assert.throws(() => verifyEmployeeToken(token), (error) => {
      assert.equal(error.code, "JWT_COMPANY_ID_MISSING");
      return true;
    });
  });

  it("fails when JWT_SECRET is missing", () => {
    const previous = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      assert.throws(() => getJwtSecret(), (error) => {
        assert.equal(error.code, "JWT_SECRET_MISSING");
        return true;
      });
    } finally {
      process.env.JWT_SECRET = previous;
    }
  });

  it("platform admin tokens are rejected by employee verification", () => {
    const token = signPlatformAdminToken({
      platformAdminId: "padmin-1",
      email: "platform@saas.local",
    });
    const decoded = verifyPlatformAdminToken(token);
    assert.equal(decoded.scope, "platform_admin");
    assert.equal(decoded.platformAdminId, "padmin-1");
    assert.equal(decoded.companyId, undefined);
    assert.throws(() => verifyEmployeeToken(token), (error) => {
      assert.equal(error.code, "JWT_WRONG_SCOPE");
      return true;
    });
  });

  it("employee tokens are rejected by platform admin verification", () => {
    const token = signEmployeeToken({
      employeeId: "emp-1",
      companyId: "co-1",
      role: "company_admin",
      email: "a@b.c",
    });
    assert.throws(() => verifyPlatformAdminToken(token), (error) => {
      assert.equal(error.code, "JWT_WRONG_SCOPE");
      return true;
    });
  });

  it("rejects tokens that are not HS256", () => {
    const jwt = require("jsonwebtoken");
    const payload = {
      employeeId: "emp-1",
      companyId: "co-1",
      role: "company_admin",
      email: "a@b.c",
      scope: "company",
    };
    const hs384 = jwt.sign(payload, process.env.JWT_SECRET, { algorithm: "HS384" });
    assert.throws(() => verifyEmployeeToken(hs384));
  });
});
