import mongoose from "mongoose";
import PlatformReview from "../../models/PlatformReview.js";
import User from "../../models/User.js";

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  highest: { rating: -1, createdAt: -1 },
  lowest: { rating: 1, createdAt: -1 },
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * GET /api/admin/platform-reviews/stats
 */
export const getPlatformReviewStats = async (_req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [agg] = await PlatformReview.aggregate([
      {
        $facet: {
          overall: [{ $group: { _id: null, count: { $sum: 1 }, avg: { $avg: "$rating" } } }],
          distribution: [{ $group: { _id: "$rating", count: { $sum: 1 } } }],
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          featured: [{ $match: { featured: true } }, { $count: "count" }],
          last30: [
            { $match: { createdAt: { $gte: thirtyDaysAgo } } },
            { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: "$rating" } } },
          ],
          prev30: [
            { $match: { createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo } } },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    agg.distribution.forEach(({ _id, count }) => { distribution[_id] = count; });

    const byStatus = { published: 0, hidden: 0 };
    // Reviews created before moderation existed have no status field — they count as published.
    agg.byStatus.forEach(({ _id, count }) => { byStatus[_id === "hidden" ? "hidden" : "published"] += count; });

    const total = agg.overall[0]?.count || 0;
    const promoters = distribution[5] + distribution[4];
    const detractors = distribution[1] + distribution[2];
    const last30 = agg.last30[0]?.count || 0;
    const prev30 = agg.prev30[0]?.count || 0;

    return res.json({
      total,
      average: agg.overall[0]?.avg ? Number(agg.overall[0].avg.toFixed(2)) : 0,
      distribution,
      byStatus,
      featured: agg.featured[0]?.count || 0,
      last30,
      last30Average: agg.last30[0]?.avg ? Number(agg.last30[0].avg.toFixed(2)) : 0,
      last30Growth: prev30 > 0 ? (((last30 - prev30) / prev30) * 100).toFixed(1) : null,
      positivePct: total > 0 ? Math.round((promoters / total) * 100) : 0,
      negativePct: total > 0 ? Math.round((detractors / total) * 100) : 0,
    });
  } catch (err) {
    console.error("Admin platform review stats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * GET /api/admin/platform-reviews
 * Query: page, limit, rating (1-5), status (published|hidden|featured), search, sort
 */
export const listPlatformReviews = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 10);
    const sort = SORTS[req.query.sort] || SORTS.newest;

    const filter = {};
    const rating = parseInt(req.query.rating);
    if (rating >= 1 && rating <= 5) filter.rating = rating;

    if (req.query.status === "hidden") filter.status = "hidden";
    else if (req.query.status === "published") filter.status = { $ne: "hidden" };
    else if (req.query.status === "featured") filter.featured = true;

    const search = req.query.search?.trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      const users = await User.find({ $or: [{ name: re }, { email: re }, { businessName: re }] })
        .select("_id")
        .limit(500)
        .lean();
      filter.$or = [{ text: re }, { user: { $in: users.map((u) => u._id) } }];
    }

    const [reviews, total] = await Promise.all([
      PlatformReview.find(filter)
        .populate("user", "name email picture businessName businessType businessCity plan")
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PlatformReview.countDocuments(filter),
    ]);

    return res.json({
      reviews: reviews.map((r) => ({ ...r, status: r.status || "published", featured: !!r.featured })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Admin listPlatformReviews error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PATCH /api/admin/platform-reviews/:id
 * Body: { status?: "published" | "hidden", featured?: boolean }
 */
export const updatePlatformReview = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Review not found" });
    }

    const update = {};
    if (req.body.status !== undefined) {
      if (!["published", "hidden"].includes(req.body.status)) {
        return res.status(400).json({ message: "Status must be 'published' or 'hidden'" });
      }
      update.status = req.body.status;
      // A hidden review can't stay featured.
      if (req.body.status === "hidden") update.featured = false;
    }
    if (req.body.featured !== undefined) {
      if (typeof req.body.featured !== "boolean") {
        return res.status(400).json({ message: "featured must be true or false" });
      }
      update.featured = req.body.featured;
      if (req.body.featured) update.status = "published";
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const review = await PlatformReview.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!review) return res.status(404).json({ message: "Review not found" });

    return res.json({ message: "Review updated", review });
  } catch (err) {
    console.error("Admin updatePlatformReview error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * DELETE /api/admin/platform-reviews/:id
 */
export const deletePlatformReview = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Review not found" });
    }
    const review = await PlatformReview.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: "Review not found" });
    return res.json({ message: "Review deleted" });
  } catch (err) {
    console.error("Admin deletePlatformReview error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
