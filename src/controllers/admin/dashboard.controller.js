import User from "../../models/User.js";
import QRCode from "../../models/QRCode.js";
import Transaction from "../../models/Transaction.js";
import ScanLog from "../../models/ScanLog.js";

const ALLOWED_RANGES = [7, 30, 90];

const getUsdToInr = () => {
  const rate = Number(process.env.USD_TO_INR);
  return Number.isFinite(rate) && rate > 0 ? rate : 85;
};

const pctGrowth = (current, previous) =>
  previous > 0 ? (((current - previous) / previous) * 100).toFixed(1) : null;

/**
 * GET /api/admin/dashboard/stats?range=30
 * Returns high-level platform metrics plus a daily trend series for the range.
 * All revenue values are in INR paise; USD (cents) is converted at USD_TO_INR.
 */
export const getStats = async (req, res) => {
  try {
    const range = ALLOWED_RANGES.includes(Number(req.query.range)) ? Number(req.query.range) : 30;
    const usdToInr = getUsdToInr();

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    // UTC midnight so day buckets line up with $dateToString (which is UTC).
    const rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (range - 1)));

    const completed = { status: "completed" };
    const dayKey = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field } });
    // cents × rate = paise, since both are 1/100 of the major unit.
    const amountInInr = {
      $cond: [{ $eq: ["$currency", "USD"] }, { $multiply: ["$amount", usdToInr] }, "$amount"],
    };
    const revenueTotals = (match) =>
      Transaction.aggregate([
        { $match: { ...completed, ...match } },
        {
          $group: {
            _id: null,
            inr: { $sum: amountInInr },
            usdOriginal: { $sum: { $cond: [{ $eq: ["$currency", "USD"] }, "$amount", 0] } },
            avg: { $avg: amountInInr },
          },
        },
      ]);

    const [
      totalUsers,
      newUsersThisMonth,
      newUsersLastMonth,
      revenueThisMonth,
      revenueLastMonth,
      revenueAllTime,
      totalQRs,
      activeQRs,
      totalScansAgg,
      scansThisMonth,
      scansLastMonth,
      planBreakdown,
      activeSubscribers,
      newSubsThisMonth,
      ratingAgg,
      signupSeries,
      scanSeries,
      revenueSeries,
      recentUsers,
      recentTransactions,
      topQRs,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfMonth } }),
      User.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      revenueTotals({ createdAt: { $gte: startOfMonth } }),
      revenueTotals({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      revenueTotals({}),
      QRCode.countDocuments(),
      QRCode.countDocuments({ status: "active" }),
      QRCode.aggregate([{ $group: { _id: null, total: { $sum: "$scanCount" } } }]),
      ScanLog.countDocuments({ scannedAt: { $gte: startOfMonth } }),
      ScanLog.countDocuments({ scannedAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      User.aggregate([{ $group: { _id: "$plan", count: { $sum: 1 } } }]),
      User.countDocuments({
        plan: { $ne: "free" },
        $or: [{ planExpiresAt: null }, { planExpiresAt: { $gt: now } }],
      }),
      Transaction.countDocuments({ ...completed, createdAt: { $gte: startOfMonth } }),
      QRCode.aggregate([
        { $match: { placeRating: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            avg: { $avg: "$placeRating" },
            reviews: { $sum: { $ifNull: ["$totalReviews", 0] } },
          },
        },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: rangeStart } } },
        { $group: { _id: dayKey("$createdAt"), count: { $sum: 1 } } },
      ]),
      ScanLog.aggregate([
        { $match: { scannedAt: { $gte: rangeStart } } },
        { $group: { _id: dayKey("$scannedAt"), count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: { ...completed, createdAt: { $gte: rangeStart } } },
        { $group: { _id: dayKey("$createdAt"), total: { $sum: amountInInr } } },
      ]),
      User.find()
        .sort({ createdAt: -1 })
        .limit(6)
        .select("name email plan picture createdAt")
        .lean(),
      Transaction.find(completed)
        .sort({ createdAt: -1 })
        .limit(6)
        .populate("user", "name email")
        .select("plan amount currency billingCycle createdAt user")
        .lean(),
      QRCode.find({ scanCount: { $gt: 0 } })
        .sort({ scanCount: -1 })
        .limit(5)
        .populate("owner", "email plan")
        .select("businessName shortCode scanCount placeRating totalReviews owner")
        .lean(),
    ]);

    const plans = { free: 0, starter: 0, pro: 0, agency: 0 };
    planBreakdown.forEach(({ _id, count }) => { plans[_id || "free"] = count; });

    const signupMap = Object.fromEntries(signupSeries.map((r) => [r._id, r.count]));
    const scanMap = Object.fromEntries(scanSeries.map((r) => [r._id, r.count]));
    const revenueMap = Object.fromEntries(revenueSeries.map((r) => [r._id, r.total]));

    const series = [];
    for (let i = 0; i < range; i++) {
      const d = new Date(rangeStart);
      d.setUTCDate(rangeStart.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      series.push({
        date: key,
        signups: signupMap[key] || 0,
        scans: scanMap[key] || 0,
        revenue: Math.round(revenueMap[key] || 0),
      });
    }

    const mrr = Math.round(revenueThisMonth[0]?.inr || 0);
    const prevMrr = Math.round(revenueLastMonth[0]?.inr || 0);

    return res.json({
      range,
      usdToInr,
      users: {
        total: totalUsers,
        newThisMonth: newUsersThisMonth,
        growth: pctGrowth(newUsersThisMonth, newUsersLastMonth),
        activeSubscribers,
      },
      revenue: {
        total: Math.round(revenueAllTime[0]?.inr || 0),
        totalUsdOriginal: revenueAllTime[0]?.usdOriginal || 0,
        mrr,
        mrrUsdOriginal: revenueThisMonth[0]?.usdOriginal || 0,
        prevMrr,
        mrrGrowth: pctGrowth(mrr, prevMrr),
        newSubsThisMonth,
        avgOrderValue: Math.round(revenueAllTime[0]?.avg || 0),
      },
      qrCodes: {
        total: totalQRs,
        active: activeQRs,
        totalScans: totalScansAgg[0]?.total || 0,
        scansThisMonth,
        scansGrowth: pctGrowth(scansThisMonth, scansLastMonth),
      },
      ratings: {
        average: ratingAgg[0]?.avg ? Number(ratingAgg[0].avg.toFixed(2)) : 0,
        totalReviews: ratingAgg[0]?.reviews || 0,
      },
      plans,
      series,
      recentUsers,
      recentTransactions: recentTransactions.map((t) => ({
        ...t,
        amountInr: t.currency === "USD" ? Math.round(t.amount * usdToInr) : t.amount,
      })),
      topQRs,
    });
  } catch (err) {
    console.error("Admin dashboard stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
