import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import DailyMetric from "../../models/DailyMetric.js";
import { getCache, setCache, invalidatePattern } from "../../utils/cache.js";
import { isGoogleDataStale, refreshQrsFromGoogle } from "../../services/googleSync.service.js";
import { qrScope } from "../../services/team.service.js";
import mongoose from "mongoose";

// ─── Summary analytics for all user QR codes ─────────────────────────────────
// GET /api/analytics/summary?range=7d&qrId=<optional, one QR only>
export const getSummary = async (req, res) => {
  try {
    const range = ["7d", "30d", "90d"].includes(req.query.range) ? req.query.range : "7d";
    const qrId = req.query.qrId ? String(req.query.qrId) : "";
    if (qrId && !mongoose.isValidObjectId(qrId)) return res.status(404).json({ message: "QR code not found." });

    const userId = req.user._id.toString();
    const cacheKey = `analytics:summary:${userId}:${range}:${qrId || "all"}`;

    // Check cache first
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const days = range === "30d" ? 30 : range === "90d" ? 90 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const allQrCodes = await QRCode.find({ ...qrScope(req), status: "active" }).sort({ createdAt: -1 });
    const qrCodes = qrId ? allQrCodes.filter((q) => String(q._id) === qrId) : allQrCodes;
    if (qrId && qrCodes.length === 0) return res.status(404).json({ message: "QR code not found." });

    if (qrCodes.some((qr) => isGoogleDataStale(qr))) {
      await refreshQrsFromGoogle(qrCodes);
    }
    const qrIds = qrCodes.map((q) => q._id);

    const [totalScans, dailyScanData, trends, geoData, deviceData] = await Promise.all([
      // 1. Total Scans for Period
      ScanLog.countDocuments({ qrCode: { $in: qrIds }, scannedAt: { $gte: since } }),

      // 2. Daily Scan Counts
      ScanLog.aggregate([
        { $match: { qrCode: { $in: qrIds }, scannedAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$scannedAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // 3. Growth Trends (Rating & Reviews)
      DailyMetric.find({ qrCode: { $in: qrIds }, date: { $gte: since } })
        .sort({ date: 1 })
        .select("date totalReviewsGrowth avgRatingGrowth"),

      // 4. Geographical Breakdown
      ScanLog.aggregate([
        { $match: { qrCode: { $in: qrIds }, scannedAt: { $gte: since } } },
        { $group: { _id: "$city", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),

      // 5. Device Distribution
      ScanLog.aggregate([
        { $match: { qrCode: { $in: qrIds }, scannedAt: { $gte: since } } },
        {
          $group: {
            _id: {
              $cond: [
                { $regexMatch: { input: "$userAgent", regex: /mobile/i } }, "Mobile",
                { $cond: [{ $regexMatch: { input: "$userAgent", regex: /tablet/i } }, "Tablet", "Desktop"] }
              ]
            },
            count: { $sum: 1 }
          }
        }
      ]),
    ]);

    // One point per day: total reviews and review-weighted rating across the selected QRs
    const byDate = new Map();
    for (const t of trends) {
      const date = t.date.toISOString().split("T")[0];
      const d = byDate.get(date) || { reviews: 0, weighted: 0, weight: 0 };
      const reviews = t.totalReviewsGrowth || 0;
      d.reviews += reviews;
      if (t.avgRatingGrowth > 0) {
        const w = Math.max(1, reviews);
        d.weighted += t.avgRatingGrowth * w;
        d.weight += w;
      }
      byDate.set(date, d);
    }
    const formattedTrends = [...byDate.entries()].map(([date, d]) => ({
      date,
      reviews: d.reviews,
      rating: d.weight ? Math.round((d.weighted / d.weight) * 10) / 10 : 0,
    }));

    const result = {
      period: { range, days, since },
      selectedQrId: qrId || null,
      qrOptions: allQrCodes.map((q) => ({ id: q._id, businessName: q.businessName, placeAddress: q.placeAddress || "" })),
      totalQRCodes: qrCodes.length,
      totalScans,
      dailyScanData,
      trends: formattedTrends,
      geography: geoData.map(g => ({ city: g._id || "Unknown", count: g.count })),
      devices: deviceData.map(d => ({ type: d._id, count: d.count })),
      qrCodes: qrCodes.map((q) => ({
        id: q._id,
        businessName: q.businessName,
        totalScanCount: q.scanCount,
        currentRating: q.placeRating,
        totalReviews: q.totalReviews,
        latestReviews: q.latestReviews,
        googleSyncedAt: q.googleSyncedAt,
      })),
    };

    // Cache for 2 minutes — analytics data doesn't need to be real-time
    await setCache(cacheKey, result, 120);

    res.json(result);
  } catch (err) {
    console.error("Summary Analytics Error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── Manually sync latest reviews/ratings from Google ────────────────────────
// POST /api/analytics/sync
export const syncUserAnalytics = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    
    // 1. Get all active QRs this person can see
    const qrCodes = await QRCode.find({ ...qrScope(req), status: "active" });
    
    if (qrCodes.length === 0) {
      return res.json({ success: true, message: "No active QR codes to sync." });
    }

    const results = await refreshQrsFromGoogle(qrCodes, { force: true });

    await invalidatePattern(`analytics:*:${userId}:*`);

    const failed = results.filter((r) => r.status === "failed");
    if (failed.length === results.length) {
      return res.status(502).json({
        success: false,
        message: `Could not fetch data from Google: ${failed[0].error}`,
        results,
      });
    }

    res.json({
      success: true,
      message: failed.length
        ? `Synced ${results.length - failed.length} of ${results.length} QR codes.`
        : "Sync complete.",
      results,
    });
  } catch (err) {
    console.error("Sync Analytics Error:", err);
    res.status(500).json({ message: err.message });
  }
};

