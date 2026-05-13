import Transaction from "../../models/Transaction.js";

/**
 * GET /api/admin/revenue/stats
 */
export const getRevenueStats = async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      totalRevAgg,
      mrrAgg,
      prevMrrAgg,
      newSubsCount,
      avgOrderAgg,
      planBreakdown,
      statusBreakdown,
    ] = await Promise.all([
      // All-time
      Transaction.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // This month
      Transaction.aggregate([
        { $match: { status: "completed", createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // Last month
      Transaction.aggregate([
        { $match: { status: "completed", createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      // New subs this month
      Transaction.countDocuments({ status: "completed", createdAt: { $gte: startOfMonth } }),
      // Avg order value
      Transaction.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, avg: { $avg: "$amount" } } },
      ]),
      // Revenue by plan
      Transaction.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: "$plan", total: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      // Transaction status counts
      Transaction.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const mrr = mrrAgg[0]?.total || 0;
    const prevMrr = prevMrrAgg[0]?.total || 0;
    const mrrGrowth = prevMrr > 0 ? (((mrr - prevMrr) / prevMrr) * 100).toFixed(1) : null;

    const byPlan = {};
    planBreakdown.forEach(({ _id, total, count }) => {
      byPlan[_id] = { total, count };
    });

    const byStatus = {};
    statusBreakdown.forEach(({ _id, count }) => {
      byStatus[_id] = count;
    });

    return res.json({
      totalRevenue: totalRevAgg[0]?.total || 0,
      mrr,
      prevMrr,
      mrrGrowth,
      newSubsThisMonth: newSubsCount,
      avgOrderValue: Math.round(avgOrderAgg[0]?.avg || 0),
      byPlan,
      byStatus,
    });
  } catch (err) {
    console.error("Admin revenue stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/revenue/transactions
 * Query: page, limit, status, plan, search (user name/email via populate)
 */
export const listTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.status && ["pending", "completed", "failed", "refunded"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    if (req.query.plan && ["starter", "pro", "agency"].includes(req.query.plan)) {
      filter.plan = req.query.plan;
    }

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .populate("user", "name email businessName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    return res.json({
      transactions,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Admin listTransactions error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
