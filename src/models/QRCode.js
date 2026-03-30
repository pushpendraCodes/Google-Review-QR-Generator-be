import mongoose from "mongoose";

const qrCodeSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    businessName: { type: String, required: true, trim: true },

    // Place info (from Google Places API search)
    placeId: { type: String, required: true },
    placeAddress: { type: String, default: "" },

    reviewUrl: { type: String, required: true },

    // Generated QR
    qrImageUrl: { type: String, default: "" }, // Backblaze B2 CDN URL
    format: { type: String, enum: ["png", "svg", "pdf"], default: "png" },

    // Branding (paid plans)
    customColor: { type: String, default: "#000000" },
    logoUrl: { type: String, default: "" },
    hasWatermark: { type: Boolean, default: true },

    // Scan tracking
    scanCount: { type: Number, default: 0 },
    shortCode: { type: String, unique: true, required: true },

    status: { type: String, enum: ["active", "archived"], default: "active" },

    // Optional label set by user
    label: { type: String, default: "" },
  },
  { timestamps: true }
);

qrCodeSchema.index({ owner: 1, status: 1 });

export default mongoose.model("QRCode", qrCodeSchema);
