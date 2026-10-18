import mongoose from "mongoose";

const teamInviteSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    // Only the SHA-256 of the invite token is stored; the raw token lives in the email link.
    tokenHash: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, default: Date.now },
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

teamInviteSchema.index({ owner: 1, email: 1, status: 1 });

export default mongoose.model("TeamInvite", teamInviteSchema);
