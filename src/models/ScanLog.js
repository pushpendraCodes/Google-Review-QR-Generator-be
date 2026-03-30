import mongoose from "mongoose";
import crypto from "crypto";

const scanLogSchema = new mongoose.Schema(
  {
    qrCode: { type: mongoose.Schema.Types.ObjectId, ref: "QRCode", required: true, index: true },
    scannedAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" }, // hashed for privacy
    city: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { timestamps: false }
);

scanLogSchema.index({ qrCode: 1, scannedAt: -1 });

// Static helper to hash IP
scanLogSchema.statics.hashIp = (ip) =>
  crypto.createHash("sha256").update(ip + process.env.IP_SALT || "qrsalt").digest("hex");

export default mongoose.model("ScanLog", scanLogSchema);
