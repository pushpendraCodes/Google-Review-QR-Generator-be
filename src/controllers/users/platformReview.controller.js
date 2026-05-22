import PlatformReview from "../../models/PlatformReview.js";

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
