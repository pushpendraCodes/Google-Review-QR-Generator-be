import jwt from "jsonwebtoken";
import User from "../../models/User.js";
import { sendOtpEmail, sendWelcomeEmail } from "../../services/email.service.js";
import { generateOTP, signAccessToken, signRefreshToken } from "../../utils/helpers.js";

// ─── Helper: issue both tokens + persist refresh token ───────────────────────
const issueTokens = async (user) => {
  const accessToken = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);

  // Store hashed refresh token on the user document
  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return { accessToken, refreshToken };
};

// ─── Register ─────────────────────────────────────────────────────────────────
export const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ message: "Name, email and password are required." });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) {
      if (exists.authProvider === "google")
        return res.status(400).json({ message: "This email uses Google login. Please sign in with Google." });
      return res.status(400).json({ message: "Email already registered." });
    }

    const otp = generateOTP();
    await User.create({
      name,
      email,
      password,
      authProvider: "email",
      isEmailVerified: false,
      emailOtp: otp,
      emailOtpExpiry: new Date(Date.now() + 10 * 60 * 1000),
    });

    await sendOtpEmail(email, otp, "verify");
    res.status(201).json({ success: true, message: "Registered. Check your email for the OTP.", email });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Verify email OTP ─────────────────────────────────────────────────────────
export const verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.isEmailVerified) return res.status(400).json({ message: "Email already verified." });
    if (!user.emailOtp || user.emailOtp !== otp)
      return res.status(400).json({ message: "Invalid OTP." });
    if (new Date() > user.emailOtpExpiry)
      return res.status(400).json({ message: "OTP expired. Please request a new one." });

    user.isEmailVerified = true;
    user.emailOtp = null;
    user.emailOtpExpiry = null;
    user.lastLoginAt = new Date();

    const { accessToken, refreshToken } = await issueTokens(user);

    // Send refresh token as httpOnly cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ accessToken, user, firstLogin: user.firstLogin, success: true });

    // Send welcome email (fire-and-forget)
    sendWelcomeEmail(user.email, user.name).catch((err) =>
      console.error("Welcome email failed:", err.message)
    );
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Login ────────────────────────────────────────────────────────────────────
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() }).select("+password");
    if (!user) return res.status(401).json({ message: "Invalid credentials." });
    if (user.authProvider === "google" && !user.password)
      return res.status(400).json({ message: "This email uses Google login." });
    if (!user.isEmailVerified)
      return res.status(401).json({ message: "Please verify your email first." });
    if (user.status === "block")
      return res.status(403).json({ message: "Account suspended." });

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ message: "Invalid credentials." });

    user.lastLoginAt = new Date();

    const { accessToken, refreshToken } = await issueTokens(user);

    // Send refresh token as httpOnly cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ accessToken, success: true, user, firstLogin: user.firstLogin });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Google OAuth callback ────────────────────────────────────────────────────
export const googleCallback = async (req, res) => {
  try {
    const { accessToken, refreshToken } = await issueTokens(req.user);
    const firstLogin = req.user.firstLogin;

    // Send refresh token as httpOnly cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Redirect frontend with access token in query string
    const redirectUrl = new URL(
      firstLogin ? "/" : "/",
      process.env.FRONTEND_URL
    );
    redirectUrl.searchParams.set("token", accessToken);
    res.redirect(redirectUrl.toString());

    // Send welcome email if first login
    if (firstLogin) {
      sendWelcomeEmail(req.user.email, req.user.name).catch((err) =>
        console.error("Welcome email failed:", err.message)
      );
    }
  } catch (err) {
    res.redirect(`${process.env.FRONTEND_URL}/auth/login?error=oauth_failed`);
  }
};

// ─── Refresh Access Token ─────────────────────────────────────────────────────
export const refreshAccessToken = async (req, res) => {
  try {
    // Get refresh token from httpOnly cookie OR request body as fallback
    const token = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!token)
      return res.status(401).json({ message: "No refresh token provided." });

    // Verify the refresh token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    } catch (err) {
      console.log(err);
      return res.status(403).json({ message: "Invalid or expired refresh token." });
    }
    console.log(decoded, "decoded")
    // Find user and check stored refresh token matches
    const user = await User.findById(decoded.id).select("+refreshToken -password");
    console.log(user, token, "user")
    if (!user || user.refreshToken !== token)
      return res.status(403).json({ message: "Refresh token revoked or not found." });

    if (user.status === "block")
      return res.status(403).json({ message: "Account suspended." });

    // Issue new access token (rotate refresh token too for security)
    const { accessToken, refreshToken: newRefreshToken } = await issueTokens(user);

    // Update cookie with new refresh token
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ accessToken, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Forgot password ──────────────────────────────────────────────────────────
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) {
      return res.json({ success: false, message: "user not found with this email" });
    }

    if (user.authProvider == "google") {
      return res.json({ success: false, message: "This email uses Google login." });
    }

    if (user.status == "block") {
      return res.json({ success: false, message: "Account suspended." });
    }

    const otp = generateOTP();
    user.emailOtp = otp;
    user.emailOtpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    user.otpVerified = false;
    await user.save();

    await sendOtpEmail(email, otp, "reset");
    res.json({ success: true, message: "If that email exists, a reset OTP has been sent." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Verify OTP (for password reset) ─────────────────────────────────────────
export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user || !user.emailOtp || user.emailOtp !== otp)
      return res.status(400).json({ success: false, message: "Invalid OTP." });
    if (new Date() > user.emailOtpExpiry)
      return res.status(400).json({ success: false, message: "OTP expired." });

    user.otpVerified = true;
    await user.save();
    res.json({ success: true, message: "OTP verified." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Reset password ───────────────────────────────────────────────────────────
export const resetPassword = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user || !user.otpVerified)
      return res.status(400).json({ success: false, message: "OTP not verified." });

    user.password = newPassword;
    user.emailOtp = null;
    user.emailOtpExpiry = null;
    user.otpVerified = false;
    await user.save();

    res.json({ success: true, message: "Password reset successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Resend OTP ───────────────────────────────────────────────────────────────
export const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.isEmailVerified && !user.otpVerified === false)
      return res.status(400).json({ message: "Email already verified." });

    const otp = generateOTP();
    user.emailOtp = otp;
    user.emailOtpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    const type = user.isEmailVerified ? "reset" : "verify";
    await sendOtpEmail(email, otp, type);
    res.json({ message: "OTP resent." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("+password");
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}


// ─── Logout ───────────────────────────────────────────────────────────────────
export const logout = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;

    if (token) {
      // Revoke the refresh token from DB
      await User.findOneAndUpdate(
        { refreshToken: token },
        { $unset: { refreshToken: 1 } }
      );
    }

    // Clear the cookie
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    });

    res.json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};