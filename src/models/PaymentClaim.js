import mongoose from "mongoose";

// A client saying "I've paid" from the portal. The agency confirms it (which records the
// payment on the QR's agencyBilling history) or rejects it.
const paymentClaimSchema = new mongoose.Schema(
  {
    agency: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "ClientAccount", required: true, index: true },
    qrCode: { type: mongoose.Schema.Types.ObjectId, ref: "QRCode", required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    method: { type: String, enum: ["upi", "link", "paypal", "bank", "other"], required: true },
    reference: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    paidAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "confirmed", "rejected"], default: "pending", index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

paymentClaimSchema.index({ client: 1, status: 1, createdAt: -1 });

export default mongoose.model("PaymentClaim", paymentClaimSchema);
