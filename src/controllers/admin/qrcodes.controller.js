import mongoose from "mongoose";
import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import User from "../../models/User.js";
import { delCache } from "../../utils/cache.js";
import { hasProfile } from "../../services/reviewProfile.service.js";

const PLANS = ["free", "starter", "pro", "agency"];
const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  scans: { scanCount: -1 },
  rating: { placeRating: -1 },
  reviews: { totalReviews: -1 },
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pctGrowth = (current, previous) =>
  previous > 0 ? (((current - previous) / previous) * 100).toFixed(1) : null;

const deviceExpr = {
  $switch: {
    branches: [
      { case: { $regexMatch: { input: "$userAgent", regex: /iphone|ipad|ipod/i } }, then: "iOS" },
      { case: { $regexMatch: { input: "$userAgent", regex: /android/i } }, then: "Android" },
      { case: { $regexMatch: { input: "$userAgent", regex: /windows|macintosh|linux|cros/i } }, then: "Desktop" },
    ],
    default: "Other",
  },
};

const dailySeries = (rows, start, days) => {
  const map = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, value: map[key] || 0 });
  }
  return series;
};

const utcDaysAgo = (days) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
};

/**
 * GET /api/admin/qrcodes/stats
 */
export const getQRStats = async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const seriesStart = utcDaysAgo(29);

    const [
      total,
      active,
      archived,
      paused,
      neverScanned,
      totalsAgg,
      scansThisMonth,
      scansLastMonth,
      seriesAgg,
      devicesAgg,
      citiesAgg,
    ] = await Promise.all([
      QRCode.countDocuments(),
      QRCode.countDocuments({ status: "active", isActive: { $ne: false } }),
      QRCode.countDocuments({ status: "archived" }),
      QRCode.countDocuments({ status: "active", isActive: false }),
      QRCode.countDocuments({ scanCount: { $in: [0, null] } }),
      QRCode.aggregate([
        {
          $group: {
            _id: null,
            scans: { $sum: "$scanCount" },
            reviews: { $sum: { $ifNull: ["$totalReviews", 0] } },
            avgRating: { $avg: { $cond: [{ $gt: ["$placeRating", 0] }, "$placeRating", null] } },
          },
        },
      ]),
      ScanLog.countDocuments({ scannedAt: { $gte: startOfMonth } }),
      ScanLog.countDocuments({ scannedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      ScanLog.aggregate([
        { $match: { scannedAt: { $gte: seriesStart } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$scannedAt" } }, count: { $sum: 1 } } },
      ]),
      ScanLog.aggregate([
        { $match: { scannedAt: { $gte: seriesStart } } },
        { $group: { _id: deviceExpr, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      ScanLog.aggregate([
        { $match: { scannedAt: { $gte: seriesStart }, city: { $nin: ["", null] } } },
        { $group: { _id: { city: "$city", country: "$country" }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),
    ]);

    const totals = totalsAgg[0] || {};
    return res.json({
      total,
      active,
      archived,
      paused,
      neverScanned,
      totalScans: totals.scans || 0,
      totalReviews: totals.reviews || 0,
      avgRating: totals.avgRating ? Number(totals.avgRating.toFixed(2)) : 0,
      avgScans: total > 0 ? Math.round((totals.scans || 0) / total) : 0,
      scansThisMonth,
      scansGrowth: pctGrowth(scansThisMonth, scansLastMonth),
      scanSeries: dailySeries(seriesAgg, seriesStart, 30),
      devices: devicesAgg.map((d) => ({ device: d._id, count: d.count })),
      topCities: citiesAgg.map((c) => ({ city: c._id.city, country: c._id.country, count: c.count })),
    });
  } catch (err) {
    console.error("Admin QR stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/qrcodes
 * Query: page, limit, status (live|paused|archived), plan, search, sort
 */
export const listQRCodes = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;
    const sort = SORTS[req.query.sort] || SORTS.newest;

    const filter = {};

    if (req.query.status === "live") Object.assign(filter, { status: "active", isActive: { $ne: false } });
    else if (req.query.status === "paused") Object.assign(filter, { status: "active", isActive: false });
    else if (req.query.status === "archived") filter.status = "archived";

    const ownerConditions = [];
    if (PLANS.includes(req.query.plan)) {
      const owners = await User.find({ plan: req.query.plan }).select("_id").lean();
      ownerConditions.push({ owner: { $in: owners.map((o) => o._id) } });
    }

    const search = req.query.search?.trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      const owners = await User.find({ $or: [{ name: re }, { email: re }] }).select("_id").limit(500).lean();
      filter.$or = [
        { businessName: re },
        { placeAddress: re },
        { shortCode: re },
        { label: re },
        { owner: { $in: owners.map((o) => o._id) } },
      ];
    }
    if (ownerConditions.length) filter.$and = ownerConditions;

    const [qrCodes, total] = await Promise.all([
      QRCode.find(filter)
        .populate("owner", "name email businessName plan picture")
        .select("businessName label placeAddress placeRating totalReviews scanCount status isActive shortCode owner createdAt qrConfig.logoUrl reviewProfile.services.name reviewProfile.highlights")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      QRCode.countDocuments(filter),
    ]);

    const ids = qrCodes.map((q) => q._id);
    const weekAgo = utcDaysAgo(6);
    const scanMeta = ids.length
      ? await ScanLog.aggregate([
          { $match: { qrCode: { $in: ids } } },
          {
            $group: {
              _id: "$qrCode",
              lastScanAt: { $max: "$scannedAt" },
              scans7d: { $sum: { $cond: [{ $gte: ["$scannedAt", weekAgo] }, 1, 0] } },
            },
          },
        ])
      : [];
    const metaMap = Object.fromEntries(scanMeta.map((m) => [m._id.toString(), m]));

    return res.json({
      qrCodes: qrCodes.map(({ reviewProfile, ...qr }) => ({
        ...qr,
        hasAiProfile: hasProfile(reviewProfile),
        lastScanAt: metaMap[qr._id.toString()]?.lastScanAt || null,
        scans7d: metaMap[qr._id.toString()]?.scans7d || 0,
      })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Admin listQRCodes error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/qrcodes/:id
 */
export const getQRCode = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "QR code not found" });
    }

    const qr = await QRCode.findById(req.params.id)
      .populate("owner", "name email businessName plan planExpiresAt picture status")
      .select("-agencyBilling")
      .lean();
    if (!qr) return res.status(404).json({ message: "QR code not found" });

    const seriesStart = utcDaysAgo(29);
    const [seriesAgg, devicesAgg, citiesAgg, firstLast] = await Promise.all([
      ScanLog.aggregate([
        { $match: { qrCode: qr._id, scannedAt: { $gte: seriesStart } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$scannedAt" } }, count: { $sum: 1 } } },
      ]),
      ScanLog.aggregate([
        { $match: { qrCode: qr._id } },
        { $group: { _id: deviceExpr, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      ScanLog.aggregate([
        { $match: { qrCode: qr._id, city: { $nin: ["", null] } } },
        { $group: { _id: { city: "$city", country: "$country" }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),
      ScanLog.aggregate([
        { $match: { qrCode: qr._id } },
        { $group: { _id: null, first: { $min: "$scannedAt" }, last: { $max: "$scannedAt" }, logged: { $sum: 1 } } },
      ]),
    ]);

    const scanSeries = dailySeries(seriesAgg, seriesStart, 30);
    return res.json({
      qr,
      scanSeries,
      devices: devicesAgg.map((d) => ({ device: d._id, count: d.count })),
      topCities: citiesAgg.map((c) => ({ city: c._id.city, country: c._id.country, count: c.count })),
      stats: {
        scansLast30: scanSeries.reduce((sum, d) => sum + d.value, 0),
        firstScanAt: firstLast[0]?.first || null,
        lastScanAt: firstLast[0]?.last || null,
        loggedScans: firstLast[0]?.logged || 0,
      },
    });
  } catch (err) {
    console.error("Admin getQRCode error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/qrcodes/:id/scans?page&limit
 */
export const listQRScans = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "QR code not found" });
    }
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 10);
    const filter = { qrCode: new mongoose.Types.ObjectId(req.params.id) };

    const [scans, total] = await Promise.all([
      ScanLog.aggregate([
        { $match: filter },
        { $sort: { scannedAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { scannedAt: 1, city: 1, country: 1, device: deviceExpr } },
      ]),
      ScanLog.countDocuments(filter),
    ]);

    return res.json({
      scans,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Admin listQRScans error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PATCH /api/admin/qrcodes/:id/active
 * Body: { isActive: boolean } — paused QRs show a "disabled" page when scanned.
 */
export const setQRActive = async (req, res) => {
  try {
    if (typeof req.body.isActive !== "boolean") {
      return res.status(400).json({ message: "isActive must be true or false" });
    }
    const qr = await QRCode.findByIdAndUpdate(
      req.params.id,
      { isActive: req.body.isActive },
      { new: true }
    ).select("shortCode isActive");
    if (!qr) return res.status(404).json({ message: "QR code not found" });

    await Promise.all([delCache(`qr:scan:${qr.shortCode}`), delCache(`qr:landing:${qr.shortCode}`)]);

    return res.json({ message: qr.isActive ? "QR code resumed" : "QR code paused", isActive: qr.isActive });
  } catch (err) {
    console.error("Admin setQRActive error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
