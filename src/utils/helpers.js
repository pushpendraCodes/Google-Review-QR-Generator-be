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

// Paid plan with no expiry (e.g. granted manually) counts as active, matching planGuard.
const hasActivePaidPlan = (user) => {
  if (!user || !user.plan || user.plan === "free") return false;
  if (!user.planExpiresAt) return true;
  return new Date(user.planExpiresAt) > new Date();
};

// ── Pricing (admin-editable) ──────────────────────────────────────────────────
// Defaults used until the saved config is loaded from the database
// (see services/pricing.service.js). All amounts are in paise (INR) / cents (USD).
const DEFAULT_PRICING = {
  plans: {
    starter: { monthly: { INR: 19900, USD: 200 }, annual: { INR: 19900, USD: 200 } },
    pro: { monthly: { INR: 29900, USD: 300 }, annual: { INR: 29900, USD: 300 } },
    agency: { monthly: { INR: 99900, USD: 1000 }, annual: { INR: 99900, USD: 1000 } },
  },
  team: {
    includedSeats: 1,   // included in the Agency plan (owner not counted)
    maxSeats: 10,       // hard cap including purchased seats
    seatPriceMonthly: { INR: 19900, USD: 200 },
  },
};

// Live objects: mutated in place by applyPricingConfig so existing imports stay current.
const PLAN_PRICES = {};      // Razorpay (INR, paise)
const PLAN_PRICES_USD = {};  // Lemon Squeezy (USD, cents)
const SEAT_PRICE_MONTHLY = {};
const teamSeats = { included: 1, max: 10 };

const applyPricingConfig = (config) => {
  for (const plan of ["starter", "pro", "agency"]) {
    const p = config.plans[plan];
    PLAN_PRICES[plan] = { monthly: p.monthly.INR, annual: p.annual.INR };
    PLAN_PRICES_USD[plan] = { monthly: p.monthly.USD, annual: p.annual.USD };
  }
  SEAT_PRICE_MONTHLY.INR = config.team.seatPriceMonthly.INR;
  SEAT_PRICE_MONTHLY.USD = config.team.seatPriceMonthly.USD;
  teamSeats.included = config.team.includedSeats;
  teamSeats.max = config.team.maxSeats;
};
applyPricingConfig(DEFAULT_PRICING);

// ── Agency team seats ──────────────────────────────────────────────────────────
const teamBaseSeats = () => teamSeats.included;
const teamMaxSeats = () => teamSeats.max;
const teamMaxExtraSeats = () => Math.max(0, teamSeats.max - teamSeats.included);

const CYCLE_MONTHS = { monthly: 1, annual: 12 };

/** Cost of carrying `seats` extra seats for a full billing cycle (added to Agency renewals). */
const seatRenewalAmount = (seats, billingCycle, currency) =>
  Math.max(0, seats || 0) * SEAT_PRICE_MONTHLY[currency] * (CYCLE_MONTHS[billingCycle] || 1);

/**
 * Pro-rated price for adding seats mid-plan: seats only last until the current plan expiry.
 * A plan without an expiry date is charged as one month.
 */
const proratedSeatAmount = (seats, planExpiresAt, currency) => {
  const msLeft = planExpiresAt ? new Date(planExpiresAt).getTime() - Date.now() : 30 * 86400000;
  const days = Math.max(1, Math.ceil(msLeft / 86400000));
  const raw = (seats * SEAT_PRICE_MONTHLY[currency] * days) / 30;
  // INR is charged in whole rupees, USD to the cent.
  const amount = currency === "INR" ? Math.ceil(raw / 100) * 100 : Math.ceil(raw);
  return { amount, days };
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
    aiProfile: ["pro", "agency"],  // personalised AI reviews (services / highlights / staff)
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
  hasActivePaidPlan,
  DEFAULT_PRICING,
  applyPricingConfig,
  teamBaseSeats,
  teamMaxSeats,
  teamMaxExtraSeats,
  SEAT_PRICE_MONTHLY,
  seatRenewalAmount,
  proratedSeatAmount,
  PLAN_PRICES,
  PLAN_PRICES_USD,
  getCountryFromRequest,
  getPaymentRegion,
  resolveCheckoutCurrency,
  QR_LIMITS,
  dataURLtoBuffer,
  canUseFeature
};