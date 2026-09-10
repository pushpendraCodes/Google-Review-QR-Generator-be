import jwt from "jsonwebtoken";
import AdminUser from "../../models/AdminUser.js";
import { sendOtpEmail } from "../../services/email.service.js";
import { generateOTP } from "../../utils/helpers.js";

const ACCESS_SECRET =
  process.env.ADMIN_ACCESS_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * POST /api/admin/auth/login
 * Body: { email, password }
 */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() });
    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!admin.isActive) {
      return res.status(403).json({ message: "This admin account has been disabled" });
    }

    // Update last login
    admin.lastLoginAt = new Date();
    await admin.save();

    // Sign token
    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      ACCESS_SECRET,
      { expiresIn: "7d" }
    );

    // Set cookie
    res.cookie("admin_token", token, COOKIE_OPTIONS);

    return res.json({
      message: "Login successful",
      token,
      admin: admin.toJSON(),
    });
  } catch (err) {
    console.error("Admin login error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /api/admin/auth/logout
 */
export const logout = (_req, res) => {
  res.clearCookie("admin_token", { ...COOKIE_OPTIONS, maxAge: 0 });
  return res.json({ message: "Logged out successfully" });
};

/**
 * GET /api/admin/auth/me
 */
export const getMe = async (req, res) => {
  try {
    return res.json({ admin: req.admin.toJSON() });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * POST /api/admin/auth/seed
 * One-time seed: creates the first super-admin (only if zero admins exist).
 * REMOVE or guard this endpoint in production.
 */
/**
 * POST /api/admin/auth/forgot-password
 * Body: { email }
 */
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() }).select(
      "+emailOtp +emailOtpExpiry +otpVerified"
    );
    if (!admin) {
      return res.json({ success: false, message: "No admin account found with this email." });
    }
    if (!admin.isActive) {
      return res.json({ success: false, message: "This admin account has been disabled." });
    }

    const otp = generateOTP();
    admin.emailOtp = otp;
    admin.emailOtpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    admin.otpVerified = false;
    await admin.save();

    await sendOtpEmail(admin.email, otp, "reset");
    return res.json({ success: true, message: "Reset code sent to your email." });
  } catch (err) {
    console.error("Admin forgot password error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * POST /api/admin/auth/verify-otp
 * Body: { email, otp }
 */
export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required." });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() }).select(
      "+emailOtp +emailOtpExpiry +otpVerified"
    );
    if (!admin || !admin.emailOtp || admin.emailOtp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP." });
    }
    if (new Date() > admin.emailOtpExpiry) {
      return res.status(400).json({ success: false, message: "OTP expired." });
    }

    admin.otpVerified = true;
    await admin.save();
    return res.json({ success: true, message: "OTP verified." });
  } catch (err) {
    console.error("Admin verify OTP error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * POST /api/admin/auth/reset-password
 * Body: { email, newPassword }
 */
export const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: "Email and new password are required." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() }).select(
      "+emailOtp +emailOtpExpiry +otpVerified"
    );
    if (!admin || !admin.otpVerified) {
      return res.status(400).json({ success: false, message: "OTP not verified." });
    }

    admin.password = newPassword;
    admin.emailOtp = null;
    admin.emailOtpExpiry = null;
    admin.otpVerified = false;
    await admin.save();

    return res.json({ success: true, message: "Password reset successfully." });
  } catch (err) {
    console.error("Admin reset password error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * POST /api/admin/auth/resend-otp
 * Body: { email }
 */
export const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() }).select(
      "+emailOtp +emailOtpExpiry +otpVerified"
    );
    if (!admin) {
      return res.status(404).json({ success: false, message: "No admin account found with this email." });
    }
    if (!admin.isActive) {
      return res.status(403).json({ success: false, message: "This admin account has been disabled." });
    }

    const otp = generateOTP();
    admin.emailOtp = otp;
    admin.emailOtpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    admin.otpVerified = false;
    await admin.save();

    await sendOtpEmail(admin.email, otp, "reset");
    return res.json({ success: true, message: "OTP resent." });
  } catch (err) {
    console.error("Admin resend OTP error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const seedAdmin = async (req, res) => {
  try {
    const count = await AdminUser.countDocuments();
    if (count > 0) {
      return res.status(400).json({ message: "Admin already seeded" });
    }

    const { name = "Super Admin", email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const admin = await AdminUser.create({ name, email, password, role: "superadmin" });
    return res.status(201).json({ message: "Super admin created", admin: admin.toJSON() });
  } catch (err) {
    console.error("Seed error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
