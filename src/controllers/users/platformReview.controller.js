import PlatformReview from "../../models/PlatformReview.js";
import { delCache, getCache, setCache } from "../../utils/cache.js";

export const FEATURED_CACHE_KEY = "platform-reviews:featured";

// @desc    Reviews the admin featured, for the public website testimonials
// @route   GET /api/reviews/featured
// @access  Public
export const getFeaturedReviews = async (req, res) => {
  try {
    const cached = await getCache(FEATURED_CACHE_KEY);
    if (cached) return res.json(cached);

    const docs = await PlatformReview.find({ featured: true, status: { $ne: "hidden" } })
      .populate("user", "name businessName businessCity")
      .sort({ updatedAt: -1 })
      .limit(6)
      .lean();

    const result = {
      reviews: docs
        .filter((d) => d.user)
        .map((d) => ({
          _id: d._id,
          name: d.user.name,
          business: [d.user.businessName, d.user.businessCity].filter(Boolean).join(", "),
          rating: d.rating,
          text: d.text,
        })),
    };
    await setCache(FEATURED_CACHE_KEY, result, 300);
    res.json(result);
  } catch (err) {
    console.error("Featured reviews error:", err);
    res.status(500).json({ message: "Failed to load reviews." });
  }
};

// @desc    Submit a review for the platform
// @route   POST /api/reviews
// @access  Private
export const submitReview = async (req, res) => {
  try {
    const { rating, text } = req.body;

    if (!rating || !text) {
      return res.status(400).json({ message: "Rating and text are required." });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5." });
    }

    // Check if user already submitted a review, if so update it or just create a new one.
    // Let's allow updating existing review for simplicity if they submit again.
    let review = await PlatformReview.findOne({ user: req.user._id });

    if (review) {
      review.rating = rating;
      review.text = text;
      await review.save();
      if (review.featured) await delCache(FEATURED_CACHE_KEY);
      return res.status(200).json({ message: "Review updated successfully.", review });
    } else {
      review = await PlatformReview.create({
        user: req.user._id,
        rating,
        text,
      });
      return res.status(201).json({ message: "Review submitted successfully.", review });
    }
  } catch (err) {
    console.error("Submit Review Error:", err);
    res.status(500).json({ message: err.message || "Server error while submitting review." });
  }
};
