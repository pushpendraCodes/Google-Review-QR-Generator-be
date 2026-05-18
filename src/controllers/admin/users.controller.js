import User from "../../models/User.js";
import QRCode from "../../models/QRCode.js";

/**
 * GET /api/admin/users
 * Query: page, limit, search, plan, status
 */
export const listUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = {};

    if (req.query.search) {
      const re = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ name: re }, { email: re }, { businessName: re }];
    }

    if (req.query.plan && ["free", "starter", "pro", "agency"].includes(req.query.plan)) {
      filter.plan = req.query.plan;
    }

    if (req.query.status && ["active", "block"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [users, total, statsAgg] = await Promise.all([
      User.find(filter)
        .select("-password -refreshToken -emailOtp -emailOtpExpiry")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),

      // Stats always run on ALL users, ignoring filters
      User.aggregate([
        {
          $facet: {
            totalAll: [{ $count: "count" }],
            activeAll: [{ $match: { status: "active" } }, { $count: "count" }],
            blockedAll: [{ $match: { status: "block" } }, { $count: "count" }],
            byPlan: [{ $group: { _id: "$plan", count: { $sum: 1 } } }],
            newThisMonth: [
              { $match: { createdAt: { $gte: thirtyDaysAgo } } },
              { $count: "count" }
            ],
            // Churned = had a paid plan, now expired and not renewed
            churned: [
              {
                $match: {
                  plan: "free",
                  planExpiresAt: { $lt: new Date(), $ne: null }
                }
              },
              { $count: "count" }
            ],
          }
        }
      ])
    ]);

    // Parse aggregation results
    const s = statsAgg[0];
    const totalAll = s.totalAll[0]?.count || 0;
    const activeAll = s.activeAll[0]?.count || 0;
    const blockedAll = s.blockedAll[0]?.count || 0;
    const newThisMonth = s.newThisMonth[0]?.count || 0;
    const churned = s.churned[0]?.count || 0;

    // Churn rate = churned / total (avoid divide by zero)
    const churnRate = totalAll > 0
      ? ((churned / totalAll) * 100).toFixed(1) + "%"
      : "0%";

    // Build plan breakdown as object { free: 10, starter: 3, ... }
    const byPlan = { free: 0, starter: 0, pro: 0, agency: 0 };
    s.byPlan.forEach(({ _id, count }) => { if (_id) byPlan[_id] = count; });

    return res.json({
      users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      stats: {
        total: totalAll,
        active: activeAll,
        blocked: blockedAll,
        newThisMonth,
        churned,
        churnRate,
        byPlan,            // { free, starter, pro, agency }
      }
    });

  } catch (err) {
    console.error("Admin listUsers error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/users/:id
 */
export const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("-password -refreshToken -emailOtp -emailOtpExpiry")
      .lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    // Also fetch their QR codes
    const qrCodes = await QRCode.find({ owner: user._id })
      .select("businessName placeAddress scanCount status shortCode createdAt")
      .sort({ scanCount: -1 })
      .lean();

    return res.json({ user, qrCodes });
  } catch (err) {
    console.error("Admin getUser error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PATCH /api/admin/users/:id/status
 * Body: { status: "active" | "block" }
 */
export const updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "block"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'active' or 'block'" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, select: "-password -refreshToken" }
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    return res.json({ message: `User ${status === "block" ? "blocked" : "unblocked"} successfully`, user });
  } catch (err) {
    console.error("Admin updateUserStatus error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * DELETE /api/admin/users/:id
 * Deletes user + all their QR codes
 */
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Delete related QR codes first
    await QRCode.deleteMany({ owner: user._id });
    await user.deleteOne();

    return res.json({ message: "User and all associated QR codes deleted successfully" });
  } catch (err) {
    console.error("Admin deleteUser error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
