import mongoose from "mongoose";

const dailyMetricSchema = new mongoose.Schema(
  {
    qrCode: { type: mongoose.Schema.Types.ObjectId, ref: "QRCode", required: true, index: true },
    date: { type: Date, required: true, index: true }, // Normalized to start of day
    
    // Stats for this specific day
    scans: { type: Number, default: 0 },
    
    // Growth stats (total count as of this day)
    totalReviewsGrowth: { type: Number, default: 0 }, // totalReviews count on Google
    avgRatingGrowth: { type: Number, default: 0 },  // rating on Google
    
    // Breakdowns
    cities: [
      {
        name: { type: String },
        count: { type: Number, default: 0 },
      }
    ],
    devices: {
      mobile: { type: Number, default: 0 },
      desktop: { type: Number, default: 0 },
      tablet: { type: Number, default: 0 },
    }
  },
  { timestamps: true }
);

// Unique metric per QR per day
dailyMetricSchema.index({ qrCode: 1, date: 1 }, { unique: true });

export default mongoose.model("DailyMetric", dailyMetricSchema);
