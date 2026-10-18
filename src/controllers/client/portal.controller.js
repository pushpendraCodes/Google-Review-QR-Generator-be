import ClientAccount from "../../models/ClientAccount.js";
import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import DailyMetric from "../../models/DailyMetric.js";
import { getCache, setCache } from "../../utils/cache.js";
import { isGoogleDataStale, refreshQrsFromGoogle } from "../../services/googleSync.service.js";
import { signClientToken, resolveClientAgency } from "../../services/clientAuth.service.js";
import mongoose from "mongoose";
import PaymentClaim from "../../models/PaymentClaim.js";
import AgencyPaymentSettings from "../../models/AgencyPaymentSettings.js";
import {
  CLAIM_METHODS,
  billingBlock,
  buildBillingSummary,
  formatMoney,
  normalizeCurrency,
  publicPaymentMethods,
  serializeClaim,
} from "../../services/clientBilling.service.js";
import { sendPaymentClaimEmail } from "../../services/email.service.js";
import { appUrl } from "../../services/agencyNotify.service.js";

const CLAIM_METHOD_LABEL = { upi: "UPI", link: "Online payment link", paypal: "PayPal", bank: "Bank transfer", other: "Other" };

/** Overdue-payment block for the signed-in client (dashboard is blocked, payments stay open). */
const loadBillingBlock = async (client) => {
  const qrs = await QRCode.find({ _id: { $in: client.qrCodes }, owner: client.agency, status: "active" })
    .select("businessName agencyBilling.price agencyBilling.nextPaymentDate")
    .lean();
  const b = billingBlock(qrs);
  return { ...b, currency: normalizeCurrency(client.billingCurrency) };
};

const MIN_PASSWORD = 8;
const RANGES = { "7d": 7, "30d": 30, "90d": 90 };

const agencyInfo = (agency) => ({
  name: agency.businessName || agency.name,
  contactName: agency.name,
  email: agency.email,
  picture: agency.picture || "",
});

const clientInfo = (client) => ({ _id: client._id, name: client.name, email: client.email });
// ─── POST /api/client-portal/login  { email, password } ──────────────────────
export const login = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) return res.status(400).json({ message: "Enter your email and password." });

    const client = await ClientAccount.findOne({ email }).select("+password");
    const valid = client ? await client.comparePassword(password) : false;
    if (!client || !valid) return res.status(401).json({ message: "Incorrect email or password." });

    if (client.status !== "active") {
      return res.status(403).json({ code: "CLIENT_DISABLED", message: "This login has been turned off. Please contact your agency." });
    }

    const { agency, active } = await resolveClientAgency(client);
    if (!agency) return res.status(401).json({ message: "Incorrect email or password." });

    client.lastLoginAt = new Date();
    await client.save();

    return res.json({
      token: signClientToken(client),
      client: clientInfo(client),
      agency: agencyInfo(agency),
      agencyActive: active,
      billingBlock: await loadBillingBlock(client),
    });
  } catch (err) {
    console.error("Client login error:", err);
    return res.status(500).json({ message: "Sign in failed. Please try again." });
  }
};

// ─── GET /api/client-portal/me ────────────────────────────────────────────────
export const getMe = async (req, res) => {
  try {
    return res.json({
      client: clientInfo(req.client),
      agency: agencyInfo(req.agency),
      agencyActive: req.agencyActive,
      billingBlock: await loadBillingBlock(req.client),
    });
  } catch (err) {
    console.error("Client me error:", err);
    return res.status(500).json({ message: "Couldn't load your account." });
  }
};

// ─── GET /api/client-portal/summary?range=30d ────────────────────────────────
export const getSummary = async (req, res) => {
  try {
    if (!req.agencyActive) {
      return res.status(403).json({
        code: "AGENCY_INACTIVE",
        message: `Your dashboard is paused. Please contact ${req.agency.businessName || req.agency.name}.`,
      });
    }

    const block = await loadBillingBlock(req.client);
    if (block.blocked) {
      return res.status(403).json({
        code: "BILLING_BLOCKED",
        message: `Your dashboard is paused because ${formatMoney(block.overdueAmount, block.currency)} is overdue. Please pay ${req.agency.businessName || req.agency.name} to restore it.`,
        billingBlock: block,
      });
    }

    const range = RANGES[req.query.range] ? req.query.range : "30d";
    const days = RANGES[range];
    const cacheKey = `client:summary:v2:${req.client._id}:${range}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const since = new Date(Date.now() - days * 86400000);
    const qrCodes = await QRCode.find({ _id: { $in: req.client.qrCodes }, owner: req.client.agency, status: "active" });
    if (qrCodes.some((qr) => isGoogleDataStale(qr))) {
      await refreshQrsFromGoogle(qrCodes);
    }
    const qrIds = qrCodes.map((q) => q._id);
    const match = { qrCode: { $in: qrIds }, scannedAt: { $gte: since } };

    const [totalScans, daily, perQr, geography, devices, trends] = await Promise.all([
      ScanLog.countDocuments(match),
      ScanLog.aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$scannedAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      ScanLog.aggregate([{ $match: match }, { $group: { _id: "$qrCode", count: { $sum: 1 } } }]),
      ScanLog.aggregate([
        { $match: match },
        { $group: { _id: "$city", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      ScanLog.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $cond: [
                { $regexMatch: { input: "$userAgent", regex: /mobile/i } }, "Mobile",
                { $cond: [{ $regexMatch: { input: "$userAgent", regex: /tablet/i } }, "Tablet", "Desktop"] },
              ],
            },
            count: { $sum: 1 },
          },
        },
      ]),
      DailyMetric.find({ qrCode: { $in: qrIds }, date: { $gte: since } }).sort({ date: 1 }).select("date totalReviewsGrowth avgRatingGrowth").lean(),
    ]);

    const scansByQr = new Map(perQr.map((p) => [String(p._id), p.count]));
    const dailyMap = new Map(daily.map((d) => [d._id, d.count]));
    const dailyScans = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      dailyScans.push({ date: key, count: dailyMap.get(key) || 0 });
    }

    const rated = qrCodes.filter((q) => q.placeRating > 0);
    const totalReviews = qrCodes.reduce((sum, q) => sum + (q.totalReviews || 0), 0);
    const avgRating = rated.length
      ? Math.round((rated.reduce((s, q) => s + q.placeRating * Math.max(1, q.totalReviews || 0), 0) /
          rated.reduce((s, q) => s + Math.max(1, q.totalReviews || 0), 0)) * 10) / 10
      : 0;

    const result = {
      range,
      days,
      totals: {
        qrCodes: qrCodes.length,
        scans: totalScans,
        allTimeScans: qrCodes.reduce((sum, q) => sum + (q.scanCount || 0), 0),
        avgRating,
        totalReviews,
      },
      dailyScans,
      trends: trends.map((t) => ({
        date: t.date.toISOString().slice(0, 10),
        reviews: t.totalReviewsGrowth,
        rating: t.avgRatingGrowth,
      })),
      geography: geography.map((g) => ({ city: g._id || "Unknown", count: g.count })),
      devices: devices.map((d) => ({ type: d._id, count: d.count })),
      qrCodes: qrCodes.map((q) => ({
        id: q._id,
        businessName: q.businessName,
        label: q.label,
        placeAddress: q.placeAddress,
        rating: q.placeRating || 0,
        totalReviews: q.totalReviews || 0,
        allTimeScans: q.scanCount || 0,
        scans: scansByQr.get(String(q._id)) || 0,
        reviewUrl: q.reviewUrl,
        placeId: q.placeId,
        shortUrl: q.shortURL,
        qrConfig: {
          color: q.qrConfig?.color || "",
          shape: q.qrConfig?.shape || "square",
          logoUrl: q.qrConfig?.logoUrl || "",
        },
        standeeConfig: {
          template: q.standeeConfig?.template || "minimal",
          bgColor: q.standeeConfig?.bgColor || "",
          socialProof: q.standeeConfig?.socialProof || "",
          language: q.standeeConfig?.language || "en",
          whiteLabel: {
            enabled: Boolean(q.standeeConfig?.whiteLabel?.enabled),
            clientName: q.standeeConfig?.whiteLabel?.clientName || "",
          },
        },
        latestReviews: (q.latestReviews || []).slice(0, 5).map((r) => ({
          authorName: r.authorName,
          rating: r.rating,
          text: r.text,
          time: r.time,
        })),
        googleSyncedAt: q.googleSyncedAt,
      })),
    };

    await setCache(cacheKey, result, 120);
    return res.json(result);
  } catch (err) {
    console.error("Client summary error:", err);
    return res.status(500).json({ message: "Couldn't load your dashboard." });
  }
};

// ─── GET /api/client-portal/payments ─────────────────────────────────────────
// What the client pays the agency, as recorded by the agency on each QR (agencyBilling).
export const getPayments = async (req, res) => {
  try {
    if (!req.agencyActive) {
      return res.status(403).json({
        code: "AGENCY_INACTIVE",
        message: `Your dashboard is paused. Please contact ${req.agency.businessName || req.agency.name}.`,
      });
    }

    const qrCodes = await QRCode.find({ _id: { $in: req.client.qrCodes }, owner: req.client.agency, status: "active" })
      .select("businessName placeAddress agencyBilling")
      .lean();

    const names = new Map(qrCodes.map((q) => [String(q._id), q.businessName]));
    const [settings, claims] = await Promise.all([
      AgencyPaymentSettings.findOne({ agency: req.client.agency }).lean(),
      PaymentClaim.find({ client: req.client._id, status: { $in: ["pending", "rejected"] } }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    return res.json({
      ...buildBillingSummary(qrCodes, req.client.billingCurrency),
      paymentMethods: publicPaymentMethods(settings),
      claims: claims.map((c) => serializeClaim(c, names.get(String(c.qrCode)))),
    });
  } catch (err) {
    console.error("Client payments error:", err);
    return res.status(500).json({ message: "Failed to load payments." });
  }
};

// ─── POST /api/client-portal/payment-claims  { qrId, amount, method, reference?, note?, paidAt? } ──
const MAX_PENDING_CLAIMS = 10;

export const createPaymentClaim = async (req, res) => {
  try {
    if (!req.agencyActive) {
      return res.status(403).json({ code: "AGENCY_INACTIVE", message: "Your dashboard is paused. Please contact your agency." });
    }

    const qrId = String(req.body.qrId || "");
    if (!mongoose.isValidObjectId(qrId) || !req.client.qrCodes.some((id) => String(id) === qrId)) {
      return res.status(400).json({ message: "Pick which location this payment is for." });
    }
    const qr = await QRCode.exists({ _id: qrId, owner: req.client.agency, status: "active" });
    if (!qr) return res.status(400).json({ message: "Pick which location this payment is for." });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return res.status(400).json({ message: "Enter the amount you paid." });
    if (!CLAIM_METHODS.includes(req.body.method)) return res.status(400).json({ message: "Choose how you paid." });

    const paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) return res.status(400).json({ message: "Enter a valid payment date." });
    if (paidAt.getTime() > Date.now() + 86400000) return res.status(400).json({ message: "Payment date can't be in the future." });
    if (paidAt.getTime() < Date.now() - 366 * 86400000) return res.status(400).json({ message: "Payment date is too far in the past." });

    const reference = String(req.body.reference || "").trim().slice(0, 80);
    const note = String(req.body.note || "").trim().slice(0, 300);

    const pending = await PaymentClaim.countDocuments({ client: req.client._id, status: "pending" });
    if (pending >= MAX_PENDING_CLAIMS) {
      return res.status(429).json({ message: "You have several payments waiting for confirmation. Please wait for your agency to confirm them." });
    }

    const claim = await PaymentClaim.create({
      agency: req.client.agency,
      client: req.client._id,
      qrCode: qrId,
      amount: Math.round(amount * 100) / 100,
      currency: normalizeCurrency(req.client.billingCurrency),
      method: req.body.method,
      reference,
      note,
      paidAt,
    });

    if (req.agency.email) {
      const qrDoc = await QRCode.findById(qrId).select("businessName").lean();
      sendPaymentClaimEmail(req.agency.email, {
        ownerName: req.agency.name,
        clientName: req.client.name,
        businessName: qrDoc?.businessName || "",
        amount: formatMoney(claim.amount, claim.currency),
        method: CLAIM_METHOD_LABEL[claim.method],
        reference,
        paidAt: paidAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
        note,
        link: appUrl(`/dashboard/clients/${req.client._id}`),
      }).catch((err) => console.error("Payment claim email failed:", err.message));
    }

    return res.status(201).json({
      message: `Thanks! ${req.agency.businessName || req.agency.name} will confirm your payment shortly.`,
      claim: serializeClaim(claim),
    });
  } catch (err) {
    console.error("createPaymentClaim error:", err);
    return res.status(500).json({ message: "Couldn't submit your payment. Please try again." });
  }
};

// ─── POST /api/client-portal/change-password  { currentPassword, newPassword } ─
export const changePassword = async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ message: `New password must be at least ${MIN_PASSWORD} characters.` });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ message: "Choose a password different from the current one." });
    }

    const client = await ClientAccount.findById(req.client._id).select("+password");
    if (!(await client.comparePassword(currentPassword))) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    client.password = newPassword;
    client.tokenVersion = (client.tokenVersion || 0) + 1;
    await client.save();

    return res.json({ message: "Password changed.", token: signClientToken(client) });
  } catch (err) {
    console.error("Client changePassword error:", err);
    return res.status(500).json({ message: "Failed to change password." });
  }
};
