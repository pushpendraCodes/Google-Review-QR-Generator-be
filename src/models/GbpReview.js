import mongoose from "mongoose";

const gbpReviewSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    locationResourceName: { type: String, required: true, index: true },
    googleReviewId: { type: String, required: true },
    reviewResourceName: { type: String, required: true },
    reviewerDisplayName: { type: String, default: "Google User" },
    reviewerProfilePhotoUrl: { type: String, default: "" },
    starRating: { type: Number, min: 0, max: 5, default: 0 },
    comment: { type: String, default: "" },
    createTime: { type: Date, default: null },
    updateTime: { type: Date, default: null },
    replyComment: { type: String, default: "" },
    replyUpdateTime: { type: Date, default: null },
    replyStatus: {
      type: String,
      enum: ["replied", "unreplied"],
      default: "unreplied",
    },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

gbpReviewSchema.index(
  { owner: 1, locationResourceName: 1, googleReviewId: 1 },
  { unique: true }
);

export default mongoose.model("GbpReview", gbpReviewSchema);
