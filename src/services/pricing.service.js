import PricingSettings from "../models/PricingSettings.js";
import { DEFAULT_PRICING, applyPricingConfig } from "../utils/helpers.js";

const PLANS = ["starter", "pro", "agency"];
const CYCLES = ["monthly", "annual"];
const CURRENCIES = ["INR", "USD"];
const REFRESH_MS = 60 * 1000;

// Razorpay needs at least ₹1; Lemon Squeezy at least $0.50.
const MIN_AMOUNT = { INR: 100, USD: 50 };
const MAX_AMOUNT = { INR: 100_000_000, USD: 1_000_000 };
const MAX_TEAM_SEATS = 100;

let current = structuredClone(DEFAULT_PRICING);
let meta = { updatedAt: null, updatedBy: null };

const toPlain = (doc) => ({
  plans: Object.fromEntries(
    PLANS.map((p) => [
      p,
      Object.fromEntries(CYCLES.map((c) => [c, { INR: doc.plans[p][c].INR, USD: doc.plans[p][c].USD }])),
    ])
  ),
  team: {
    includedSeats: doc.team.includedSeats,
    maxSeats: doc.team.maxSeats,
    seatPriceMonthly: { INR: doc.team.seatPriceMonthly.INR, USD: doc.team.seatPriceMonthly.USD },
  },
});

const apply = (config, info = {}) => {
  current = config;
  meta = { updatedAt: info.updatedAt ?? null, updatedBy: info.updatedBy ?? null };
  applyPricingConfig(config);
};

/** Load the saved config (or keep defaults when none has been saved yet). */
export const loadPricing = async () => {
  try {
    const doc = await PricingSettings.findOne({ key: "default" }).lean();
    if (doc) apply(toPlain(doc), doc);
  } catch (err) {
    console.error("Failed to load pricing settings:", err.message);
  }
  return current;
};

/** Load now and refresh periodically so every server instance picks up admin changes. */
export const startPricingSync = async () => {
  await loadPricing();
  setInterval(loadPricing, REFRESH_MS).unref();
};

export const getPricing = () => ({ ...structuredClone(current), ...meta });

const isAmount = (v, currency) =>
  Number.isInteger(v) && v >= MIN_AMOUNT[currency] && v <= MAX_AMOUNT[currency];

/**
 * Validates a full pricing config (amounts in paise / cents).
 * Returns { error } or { config } normalised to exactly the expected shape.
 */
export const validatePricing = (input) => {
  if (!input || typeof input !== "object") return { error: "Invalid pricing data." };

  const plans = {};
  for (const p of PLANS) {
    plans[p] = {};
    for (const c of CYCLES) {
      plans[p][c] = {};
      for (const cur of CURRENCIES) {
        const v = Number(input.plans?.[p]?.[c]?.[cur]);
        if (!isAmount(v, cur)) {
          return { error: `${p} ${c} ${cur} price must be at least ${cur === "INR" ? "₹1" : "$0.50"}.` };
        }
        plans[p][c][cur] = v;
      }
    }
  }

  const includedSeats = Number(input.team?.includedSeats);
  const maxSeats = Number(input.team?.maxSeats);
  if (!Number.isInteger(includedSeats) || includedSeats < 0 || includedSeats > MAX_TEAM_SEATS) {
    return { error: `Included seats must be a whole number from 0 to ${MAX_TEAM_SEATS}.` };
  }
  if (!Number.isInteger(maxSeats) || maxSeats < includedSeats || maxSeats > MAX_TEAM_SEATS) {
    return { error: `Maximum seats must be between the included seats and ${MAX_TEAM_SEATS}.` };
  }

  const seatPriceMonthly = {};
  for (const cur of CURRENCIES) {
    const v = Number(input.team?.seatPriceMonthly?.[cur]);
    if (!isAmount(v, cur)) {
      return { error: `Extra seat ${cur} price must be at least ${cur === "INR" ? "₹1" : "$0.50"}.` };
    }
    seatPriceMonthly[cur] = v;
  }

  return { config: { plans, team: { includedSeats, maxSeats, seatPriceMonthly } } };
};

export const savePricing = async (config, adminId) => {
  const doc = await PricingSettings.findOneAndUpdate(
    { key: "default" },
    { ...config, updatedBy: adminId || null },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  apply(toPlain(doc), doc);
  return getPricing();
};

/** Public shape for the website (no admin metadata). */
export const getPublicPricing = () => ({
  plans: structuredClone(current.plans),
  team: structuredClone(current.team),
});
