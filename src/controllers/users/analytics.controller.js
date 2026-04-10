import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import DailyMetric from "../../models/DailyMetric.js";
import { getCache, setCache } from "../../utils/cache.js";

// ─── Summary analytics for all user QR codes ─────────────────────────────────
// GET /api/analytics/summary?range=7d
export const getSummary = async (req, res) => {
  try {
    const range = req.query.range || "7d";
    const userId = req.user._id.toString();
    const cacheKey = `analytics:summary:${userId}:${range}`;

    // Check cache first
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const days = range === "30d" ? 30 : range === "90d" ? 90 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Get all QR codes owned by user
    const qrCodes = await QRCode.find({ owner: req.user._id, status: "active" })
      .select("_id businessName scanCount placeRating totalReviews latestReviews");
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

    // Flatten and clean trends for frontend charts
    const formattedTrends = trends.map(t => ({
      date: t.date.toISOString().split("T")[0],
      reviews: t.totalReviewsGrowth,
      rating: t.avgRatingGrowth
    }));

    const result = {
      period: { range, days, since },
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

