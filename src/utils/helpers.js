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
    expiresIn: process.env.ACCESS_TOKEN_EXPIRE || "1m",
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

// Plan prices in paise (Razorpay — India, smallest currency unit)
const PLAN_PRICES = {
  starter: { monthly: 19900, annual: 19900 },
  pro: { monthly: 29900, annual: 29900 },
  agency: { monthly: 99900, annual: 99900 },
};

/** INR rupees → USD dollars for display/checkout (₹199 → $2, ₹299 → $3, ₹999 → $10). */
const inrPaiseToUsdCents = (paise) =>
  Math.round(paise / 100 / 100) * 100;

// Fixed USD prices in cents (Lemon Squeezy — international; must match variant prices in LS dashboard)
const PLAN_PRICES_USD = {
  starter: {
    monthly: inrPaiseToUsdCents(PLAN_PRICES.starter.monthly),
    annual: inrPaiseToUsdCents(PLAN_PRICES.starter.annual),
  },
  pro: {
    monthly: inrPaiseToUsdCents(PLAN_PRICES.pro.monthly),
    annual: inrPaiseToUsdCents(PLAN_PRICES.pro.annual),
  },
  agency: {
    monthly: inrPaiseToUsdCents(PLAN_PRICES.agency.monthly),
    annual: inrPaiseToUsdCents(PLAN_PRICES.agency.annual),
  },
};

/** Country code from CDN / hosting headers (Vercel, Cloudflare). */
const getCountryFromRequest = (req) => {
  const raw =
    req.headers["cf-ipcountry"] ||
    req.headers["x-vercel-ip-country"] ||
    req.headers["x-country-code"] ||
    "";
  return String(raw).toUpperCase() || null;
};

/** India → Razorpay (INR); everyone else → Lemon Squeezy (USD). */
const getPaymentRegion = (req) => {
  const country = getCountryFromRequest(req);
  if (country === "IN") return { region: "india", currency: "INR", country };
  return { region: "international", currency: "USD", country: country || "unknown" };
};

/** Explicit currency from client overrides geo; otherwise fall back to IP region. */
const resolveCheckoutCurrency = (req, requestedCurrency) => {
  if (requestedCurrency === "INR" || requestedCurrency === "USD") {
    return requestedCurrency;
  }
  return getPaymentRegion(req).currency;
};

// QR limits per plan
const QR_LIMITS = { free: 1, starter: 3, pro: 10, agency: Infinity };
// ── Plan feature gates ─────────────────────────────────────────────────────────
const canUseFeature = (plan, feature) => {
  const gates = {
    customColor: ["starter", "pro", "agency"],
    customShape: ["pro", "agency"],
    logo: ["pro", "agency"],
    svgPdf: ["starter", "pro", "agency"],
    standeeExtras: ["pro", "agency"],  // template, bgColor, socialProof, language
    whiteLabel: ["agency"],
  };
  return gates[feature]?.includes(plan) ?? false;
};

// Convert Data URL to Buffer
function dataURLtoBuffer(dataUrl) {
  const base64Data = dataUrl.split(",")[1]; // remove "data:image/png;base64,"
  return Buffer.from(base64Data, "base64");
}

export {
  generateShortCode,
  generateOTP,
  signToken,
  signAccessToken,
  signRefreshToken,
  getPlanExpiry,
  PLAN_PRICES,
  PLAN_PRICES_USD,
  getCountryFromRequest,
  getPaymentRegion,
  resolveCheckoutCurrency,
  QR_LIMITS,
  dataURLtoBuffer,
  canUseFeature
};