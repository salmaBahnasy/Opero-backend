const { signupCompanyWorkspace } = require("../services/publicSignup.service");

function safeSignupMessage(error) {
  if (error?.code === "SIGNUP_INVALID_INPUT") return "بيانات إنشاء الحساب غير صالحة.";
  if (error?.code === "SIGNUP_SLUG_CONFLICT") {
    return "رابط مساحة العمل مستخدم بالفعل، اختر رابطًا آخر.";
  }
  if (error?.code === "SIGNUP_EMPLOYEE_CONFLICT") {
    return "تعذر إنشاء الحساب بهذا البريد الإلكتروني.";
  }
  return "تعذر إنشاء الحساب. حاول مرة أخرى.";
}

async function publicSignup(req, res) {
  try {
    const data = await signupCompanyWorkspace(req.body || {});
    res.status(201).json({
      success: true,
      token: data.token,
      data: {
        company: data.company,
        employee: data.employee,
      },
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    res.status(status).json({
      success: false,
      code: error.code || "SIGNUP_FAILED",
      message: status === 500 ? "Failed to create account" : safeSignupMessage(error),
    });
  }
}

module.exports = { publicSignup };
