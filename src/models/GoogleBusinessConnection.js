import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    locationResourceName: { type: String, required: true },
    title: { type: String, default: "" },
    placeId: { type: String, default: "" },
    address: { type: String, default: "" },
  },
  { _id: false }
);

const googleBusinessConnectionSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    googleAccountResourceName: { type: String, default: "" },
    googleAccountDisplayName: { type: String, default: "" },
    accessTokenEnc: { type: String, default: "" },
    refreshTokenEnc: { type: String, default: "" },
    accessTokenExpiresAt: { type: Date, default: null },
    scopes: [{ type: String }],
    locations: [locationSchema],
    selectedLocationResourceName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "revoked", "error"],
      default: "active",
    },
    lastError: { type: String, default: "" },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true }
);

googleBusinessConnectionSchema.index({ owner: 1 });

export default mongoose.model(
  "GoogleBusinessConnection",
  googleBusinessConnectionSchema
);
