import QRCode from "../../models/QRCode.js";

/**
 * GET /api/admin/qrcodes/stats
 */
export const getQRStats = async (_req, res) => {
  try {
    const [total, active, archived, totalScansAgg, topQRs] = await Promise.all([
      QRCode.countDocuments(),
      QRCode.countDocuments({ status: "active" }),
      QRCode.countDocuments({ status: "archived" }),
      QRCode.aggregate([{ $group: { _id: null, total: { $sum: "$scanCount" } } }]),
      // Top 5 by scan count
      QRCode.find({ status: "active" })
        .sort({ scanCount: -1 })
        .limit(5)
        .select("businessName scanCount placeRating totalReviews")
        .lean(),
    ]);

    const totalScans = totalScansAgg[0]?.total || 0;
    const avgScans = total > 0 ? Math.round(totalScans / total) : 0;

    return res.json({
      total,
      active,
      archived,
      totalScans,
      avgScans,
      topQRs,
    });
  } catch (err) {
    console.error("Admin QR stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/qrcodes
 * Query: page, limit, status, search, sortBy (scanCount | createdAt)
 */
export const listQRCodes = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.status && ["active", "archived"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    if (req.query.search) {
      const re = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ businessName: re }, { placeAddress: re }, { shortCode: re }];
    }

    const sortField = req.query.sortBy === "scans" ? { scanCount: -1 } : { createdAt: -1 };

    const [qrCodes, total] = await Promise.all([
      QRCode.find(filter)
        .populate("owner", "name email businessName plan")
        .sort(sortField)
        .skip(skip)
        .limit(limit)
        .lean(),
      QRCode.countDocuments(filter),
    ]);

    // Compute conversion rate for each QR (scans → reviews)
    const data = qrCodes.map((qr) => ({
      ...qr,
      conversionRate:
        qr.scanCount > 0 && qr.totalReviews > 0
          ? ((qr.totalReviews / qr.scanCount) * 100).toFixed(1) + "%"
          : "0%",
    }));

    return res.json({
      qrCodes: data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Admin listQRCodes error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
