import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";

// Generates a 7-char alphanumeric short code for scan tracking
const generateShortCode = () =>
  Math.random().toString(36).substring(2, 9).toUpperCase();

// 6-digit OTP
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// ─── Access Token (short-lived: 15 minutes) ───────────────────────────────────
const signAccessToken = (userId) =>
  jwt.sign({ id: userId }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRE || "15m",
  });

// ─── Refresh Token (long-lived: 7 days) ──────────────────────────────────────
const signRefreshToken = (userId) =>
  jwt.sign({ id: userId }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRE || "7d",
  });

// ─── Legacy signToken (kept for backward compat, points to access token) ─────
const signToken = signAccessToken;

// Plan expiry calculator
const getPlanExpiry = (billingCycle) => {
  const now = new Date();
  if (billingCycle === "annual") {
    now.setFullYear(now.getFullYear() + 1);
  } else {
    now.setMonth(now.getMonth() + 1);
  }
  return now;
};

// Plan prices in paise (Razorpay uses smallest currency unit)
const PLAN_PRICES = {
  starter: { monthly: 29900, annual: 251300 },
  pro: { monthly: 69900, annual: 587300 },
  agency: { monthly: 149900, annual: 1259300 },
};

// QR limits per plan
const QR_LIMITS = { free: 1, starter: 3, pro: 10, agency: Infinity };

export {
  generateShortCode,
  generateOTP,
  signToken,
  signAccessToken,
  signRefreshToken,
  getPlanExpiry,
  PLAN_PRICES,
  QR_LIMITS,
};