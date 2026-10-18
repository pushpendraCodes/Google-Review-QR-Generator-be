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

const agencyPaymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  notes: { type: String, default: "" }
});

const agencyBillingSchema = new mongoose.Schema({
  planType: { type: String, enum: ["monthly", "yearly", "none"], default: "none" },
  price: { type: Number, default: 0 },
  nextPaymentDate: { type: Date, default: null },
  history: [agencyPaymentSchema]
}, { _id: false });

// ── Main schema ────────────────────────────────────────────────────────────────
const qrCodeSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Person who created the QR. Differs from `owner` when an Agency staff member created it;
    // null on QRs created before teams existed (treated as created by the owner).
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    businessName: { type: String, required: true, trim: true },
    label: { type: String, default: "" },

    // Google Place info
    placeId: { type: String, required: true },
    placeAddress: { type: String, default: "" },
    placeRating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },
    googleSyncedAt: { type: Date, default: null },

    // The actual Google review deep-link
    reviewUrl: { type: String, required: true },

    // Short redirect (for scan tracking)
    shortCode: { type: String, unique: true, required: true },

    // QR customisation (plan-gated, validated in controller)
    qrConfig: { type: qrConfigSchema, default: () => ({}) },
    standeeConfig: { type: standeeConfigSchema, default: () => ({}) },

    // Agency billing config (for agency plan owners)
    agencyBilling: { type: agencyBillingSchema, default: () => ({ planType: "none", price: 0, nextPaymentDate: null, history: [] }) },

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
    isActive: { type: Boolean, default: true },
    // Over the Free plan limit after the owner's paid plan lapsed and the grace period ended.
    planPaused: { type: Boolean, default: false },

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
qrCodeSchema.index({ owner: 1, createdBy: 1, status: 1 });
qrCodeSchema.index({ shortCode: 1 });

export default mongoose.model("QRCode", qrCodeSchema);