import Transaction from "../../models/Transaction.js";
import User from "../../models/User.js";

const TX_STATUSES = ["pending", "completed", "failed", "refunded"];
const PAID_PLANS = ["starter", "pro", "agency"];
const PROVIDERS = ["razorpay", "lemon_squeezy"];
const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  amountDesc: { amount: -1 },
  amountAsc: { amount: 1 },
};
const EXPORT_LIMIT = 10000;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getUsdToInr = () => {
  const rate = Number(process.env.USD_TO_INR);
  return Number.isFinite(rate) && rate > 0 ? rate : 85;
};

/** Mongo expression: amount in INR paise (USD cents × rate). */
const amountInInrExpr = (rate) => ({
  $cond: [{ $eq: ["$currency", "USD"] }, { $multiply: ["$amount", rate] }, "$amount"],
});

const pctGrowth = (current, previous) =>
  previous > 0 ? (((current - previous) / previous) * 100).toFixed(1) : null;

/**
 * GET /api/admin/revenue/stats
 * All money values are INR paise (USD converted at USD_TO_INR).
 */
export const getRevenueStats = async (_req, res) => {
  try {
    const rate = getUsdToInr();
    const inr = amountInInrExpr(rate);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

    const completed = { status: "completed" };
    const sumInr = (match) =>
      Transaction.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: inr }, count: { $sum: 1 }, avg: { $avg: inr } } },
      ]);

    const [
      allTime,
      thisMonth,
      lastMonth,
      refunded,
      byPlanAgg,
      byProviderAgg,
      byCycleAgg,
      byStatusAgg,
      monthlyAgg,
      payingCustomers,
    ] = await Promise.all([
      sumInr(completed),
      sumInr({ ...completed, createdAt: { $gte: startOfMonth } }),
      sumInr({ ...completed, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      sumInr({ status: "refunded" }),
      Transaction.aggregate([
        { $match: completed },
        { $group: { _id: "$plan", total: { $sum: inr }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: completed },
        { $group: { _id: "$paymentProvider", total: { $sum: inr }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: completed },
        { $group: { _id: "$billingCycle", total: { $sum: inr }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Transaction.aggregate([
        { $match: { ...completed, createdAt: { $gte: twelveMonthsAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            total: { $sum: inr },
            count: { $sum: 1 },
          },
        },
      ]),
      Transaction.distinct("user", completed),
    ]);

    const toMap = (rows) =>
      Object.fromEntries(rows.map(({ _id, total, count }) => [_id || "unknown", { total: Math.round(total), count }]));

    const byStatus = { pending: 0, completed: 0, failed: 0, refunded: 0 };
    byStatusAgg.forEach(({ _id, count }) => { if (_id) byStatus[_id] = count; });
    const attempted = byStatus.completed + byStatus.failed;

    const monthlyMap = Object.fromEntries(monthlyAgg.map((m) => [m._id, m]));
    const monthly = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(twelveMonthsAgo.getUTCFullYear(), twelveMonthsAgo.getUTCMonth() + i, 1));
      const key = d.toISOString().slice(0, 7);
      monthly.push({
        month: key,
        revenue: Math.round(monthlyMap[key]?.total || 0),
        count: monthlyMap[key]?.count || 0,
      });
    }

    const mrr = Math.round(thisMonth[0]?.total || 0);
    const prevMrr = Math.round(lastMonth[0]?.total || 0);
    const newSubs = thisMonth[0]?.count || 0;
    const prevSubs = lastMonth[0]?.count || 0;

    return res.json({
      usdToInr: rate,
      totalRevenue: Math.round(allTime[0]?.total || 0),
      totalTransactions: allTime[0]?.count || 0,
      payingCustomers: payingCustomers.length,
      mrr,
      prevMrr,
      mrrGrowth: pctGrowth(mrr, prevMrr),
      newSubsThisMonth: newSubs,
      newSubsGrowth: pctGrowth(newSubs, prevSubs),
      avgOrderValue: Math.round(allTime[0]?.avg || 0),
      refundedAmount: Math.round(refunded[0]?.total || 0),
      successRate: attempted > 0 ? Number(((byStatus.completed / attempted) * 100).toFixed(1)) : null,
      byPlan: toMap(byPlanAgg),
      byProvider: toMap(byProviderAgg),
      byCycle: toMap(byCycleAgg),
      byStatus,
      monthly,
    });
  } catch (err) {
    console.error("Admin revenue stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/** Shared filter builder for list + export. */
const buildTransactionFilter = async (query) => {
  const filter = {};

  if (TX_STATUSES.includes(query.status)) filter.status = query.status;
  if (PAID_PLANS.includes(query.plan)) filter.plan = query.plan;
  if (PROVIDERS.includes(query.provider)) filter.paymentProvider = query.provider;
  if (["INR", "USD"].includes(query.currency)) filter.currency = query.currency;

  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : null;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    filter.createdAt = {};
    if (from && !Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.createdAt.$lte = to;
  }

  const search = query.search?.trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    const userIds = await User.find({ $or: [{ name: re }, { email: re }, { businessName: re }] })
      .select("_id")
      .limit(500)
      .lean();
    filter.$or = [
      { user: { $in: userIds.map((u) => u._id) } },
      { transactionId: re },
      { razorpayOrderId: re },
      { couponApplied: re },
    ];
  }

  return filter;
};

/**
 * GET /api/admin/revenue/transactions
 * Query: page, limit, status, plan, provider, currency, from, to, search, sort
 */
export const listTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;
    const rate = getUsdToInr();

    const filter = await buildTransactionFilter(req.query);
    const sort = SORTS[req.query.sort] || SORTS.newest;

    const [transactions, total, filteredSum] = await Promise.all([
      Transaction.find(filter)
        .populate("user", "name email businessName picture")
        .select("-razorpaySignature -idempotencyKey -lemonCheckoutUrl")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
      // Revenue = completed only, so a non-completed status filter yields 0.
      filter.status && filter.status !== "completed"
        ? Promise.resolve([])
        : Transaction.aggregate([
            { $match: { ...filter, status: "completed" } },
            { $group: { _id: null, total: { $sum: amountInInrExpr(rate) } } },
          ]),
    ]);

    return res.json({
      transactions: transactions.map((t) => ({
        ...t,
        amountInr: t.currency === "USD" ? Math.round(t.amount * rate) : t.amount,
      })),
      filteredRevenue: Math.round(filteredSum[0]?.total || 0),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Admin listTransactions error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const csvCell = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  // Prefix formula-like values so spreadsheets don't execute them.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * GET /api/admin/revenue/transactions/export
 * Same filters as the list; returns CSV (max 10,000 rows).
 */
export const exportTransactions = async (req, res) => {
  try {
    const rate = getUsdToInr();
    const filter = await buildTransactionFilter(req.query);
    const sort = SORTS[req.query.sort] || SORTS.newest;

    const rows = await Transaction.find(filter)
      .populate("user", "name email businessName")
      .sort(sort)
      .limit(EXPORT_LIMIT)
      .lean();

    const header = [
      "Date", "User", "Email", "Business", "Plan", "Billing", "Provider", "Status",
      "Currency", "Amount", "Amount (INR)", "Original amount", "Discount", "Coupon", "Transaction ID",
    ];
    const lines = rows.map((t) => {
      const amountInr = t.currency === "USD" ? t.amount * rate : t.amount;
      return [
        new Date(t.createdAt).toISOString(),
        t.user?.name || "",
        t.user?.email || "",
        t.user?.businessName || "",
        t.plan,
        t.billingCycle,
        t.paymentProvider,
        t.status,
        t.currency,
        (t.amount / 100).toFixed(2),
        (amountInr / 100).toFixed(2),
        ((t.originalAmount || 0) / 100).toFixed(2),
        ((t.discountAmount || 0) / 100).toFixed(2),
        t.couponApplied || "",
        t.transactionId || t.razorpayOrderId || t.lemonSqueezyCheckoutId || "",
      ].map(csvCell).join(",");
    });

    const filename = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send("\uFEFF" + [header.join(","), ...lines].join("\n"));
  } catch (err) {
    console.error("Admin exportTransactions error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
