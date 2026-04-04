// models/QRDownload.js
import mongoose from "mongoose";

const qrDownloadSchema = new mongoose.Schema(
    {
        qrCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "QRCode", required: true },
        owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        format: { type: String, enum: ["png", "svg", "pdf"], required: true },
        planAtTime: { type: String, required: true },
    },
    { timestamps: true }   // createdAt = download timestamp
);

qrDownloadSchema.index({ owner: 1 });
qrDownloadSchema.index({ qrCodeId: 1 });

export default mongoose.model("QRDownload", qrDownloadSchema);