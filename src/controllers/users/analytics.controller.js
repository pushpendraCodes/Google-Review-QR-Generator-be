import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
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
    const qrCodes = await QRCode.find({ owner: req.user._id, status: "active" }).select("_id businessName scanCount");
    const qrIds = qrCodes.map((q) => q._id);

    const [totalScans, dailyData, topQRs] = await Promise.all([
      ScanLog.countDocuments({ qrCode: { $in: qrIds }, scannedAt: { $gte: since } }),

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

      ScanLog.aggregate([
        { $match: { qrCode: { $in: qrIds }, scannedAt: { $gte: since } } },
        { $group: { _id: "$qrCode", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "qrcodes",
            localField: "_id",
            foreignField: "_id",
            as: "qr",
          },
        },
        { $unwind: "$qr" },
        { $project: { businessName: "$qr.businessName", count: 1 } },
      ]),
    ]);

    const result = {
      period: { range, days, since },
      totalQRCodes: qrCodes.length,
      totalScans,
      dailyData,
      topQRs,
      qrCodes: qrCodes.map((q) => ({
        id: q._id,
        businessName: q.businessName,
        totalScanCount: q.scanCount,
      })),
    };

    // Cache for 2 minutes — analytics data doesn't need to be real-time
    await setCache(cacheKey, result, 120);

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
