import mongoose from "mongoose";

const platformReviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, required: true, trim: true, maxlength: 1000 },

    // Admin moderation
    status: { type: String, enum: ["published", "hidden"], default: "published", index: true },
    featured: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

export default mongoose.model("PlatformReview", platformReviewSchema);
