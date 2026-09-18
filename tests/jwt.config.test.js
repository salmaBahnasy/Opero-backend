process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-do-not-use-elsewhere";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getJwtSecret,
  signEmployeeToken,
  verifyEmployeeToken,
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
});
