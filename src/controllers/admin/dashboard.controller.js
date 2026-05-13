import User from "../../models/User.js";
import QRCode from "../../models/QRCode.js";
import Transaction from "../../models/Transaction.js";
import ScanLog from "../../models/ScanLog.js";

/**
 * GET /api/admin/dashboard/stats
 * Returns high-level platform metrics.
 */
export const getStats = async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    // ── Users ──────────────────────────────────────────────────────────────────
    const [totalUsers, newUsersThisMonth, newUsersLastMonth] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfMonth } }),
      User.countDocuments({ createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
    ]);

    // ── Revenue (completed transactions only) ─────────────────────────────────
    const [revenueThisMonth, revenueLastMonth, totalRevenue] = await Promise.all([
      Transaction.aggregate([
        { $match: { status: "completed", createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        { $match: { status: "completed", createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Transaction.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    const mrr = revenueThisMonth[0]?.total || 0;
    const prevMrr = revenueLastMonth[0]?.total || 0;
    const mrrGrowth = prevMrr > 0 ? (((mrr - prevMrr) / prevMrr) * 100).toFixed(1) : null;

    // ── QR codes & scans ──────────────────────────────────────────────────────
    const [totalQRs, activeQRs, totalScans] = await Promise.all([
      QRCode.countDocuments(),
      QRCode.countDocuments({ status: "active" }),
      QRCode.aggregate([{ $group: { _id: null, total: { $sum: "$scanCount" } } }]),
    ]);

    // ── Platform plan breakdown ───────────────────────────────────────────────
    const planBreakdown = await User.aggregate([
      { $group: { _id: "$plan", count: { $sum: 1 } } },
    ]);
    const plans = { free: 0, starter: 0, pro: 0, agency: 0 };
    planBreakdown.forEach(({ _id, count }) => { plans[_id] = count; });

    // ── New subscriptions this month ──────────────────────────────────────────
    const newSubsThisMonth = await Transaction.countDocuments({
      status: "completed",
      createdAt: { $gte: startOfMonth },
    });

    // ── Avg order value ────────────────────────────────────────────────────────
    const avgOrderAgg = await Transaction.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, avg: { $avg: "$amount" } } },
    ]);
    const avgOrderValue = Math.round(avgOrderAgg[0]?.avg || 0);

    return res.json({
      users: {
        total: totalUsers,
        newThisMonth: newUsersThisMonth,
        growth: newUsersLastMonth > 0
          ? (((newUsersThisMonth - newUsersLastMonth) / newUsersLastMonth) * 100).toFixed(1)
          : null,
      },
      revenue: {
        total: totalRevenue[0]?.total || 0,
        mrr,
        prevMrr,
        mrrGrowth,
        newSubsThisMonth,
        avgOrderValue,
      },
      qrCodes: {
        total: totalQRs,
        active: activeQRs,
        totalScans: totalScans[0]?.total || 0,
      },
      plans,
    });
  } catch (err) {
    console.error("Admin dashboard stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
