import mongoose from "mongoose";

// ── Sub-schemas ────────────────────────────────────────────────────────────────
const qrConfigSchema = new mongoose.Schema({
  color: { type: String, default: "#1D9E75" },
  shape: { type: String, enum: ["square", "rounded", "dots", "classy", "extra-rounded"], default: "square" },
  logoUrl: { type: String, default: "" },        // Cloudinary CDN URL
}, { _id: false });

const standeeConfigSchema = new mongoose.Schema({
  template: { type: String, enum: ["minimal", "luxury", "bold", "festive"], default: "minimal" },
  bgColor: { type: String, default: "" },
  socialProof: { type: String, default: "" },
  language: { type: String, enum: ["en", "hi", "mr", "ta", "te"], default: "en" },
  whiteLabel: {
    enabled: { type: Boolean, default: false },
    clientName: { type: String, default: "" },
  },
}, { _id: false });

// ── Main schema ────────────────────────────────────────────────────────────────
const qrCodeSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    businessName: { type: String, required: true, trim: true },
    label: { type: String, default: "" },

    // Google Place info
    placeId: { type: String, required: true },
    placeAddress: { type: String, default: "" },
    placeRating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },

    // The actual Google review deep-link
    reviewUrl: { type: String, required: true },

    // Short redirect (for scan tracking)
    shortCode: { type: String, unique: true, required: true },

    // QR customisation (plan-gated, validated in controller)
    qrConfig: { type: qrConfigSchema, default: () => ({}) },
    standeeConfig: { type: standeeConfigSchema, default: () => ({}) },

    // Watermark flag (free plan)
    hasWatermark: { type: Boolean, default: true },

    // Scan tracking
    scanCount: { type: Number, default: 0 },

    // Cache for latest reviews
    latestReviews: [
      {
        authorName: { type: String },
        rating: { type: Number },
        text: { type: String },
        time: { type: Number },
      }
    ],

    status: { type: String, enum: ["active", "archived"], default: "active" },

  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

qrCodeSchema.virtual("shortURL").get(function () {
  const baseUrl = process.env.BACKEND_URL || "http://localhost:5000";
  return `${baseUrl}/r/${this.shortCode}`;
});

// Unique QR per user+business — enforces plan limits correctly
qrCodeSchema.index({ owner: 1, placeId: 1 }, { unique: true });
qrCodeSchema.index({ owner: 1, status: 1 });
qrCodeSchema.index({ shortCode: 1 });

export default mongoose.model("QRCode", qrCodeSchema);