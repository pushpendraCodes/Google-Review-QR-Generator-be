import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    plan: { type: String, enum: ["starter", "pro", "agency"], required: true },
    amount: { type: Number, required: true },
    originalAmount: { type: Number, required: true },
    discountAmount: { type: Number, default: 0 },
    couponApplied: { type: String, default: "" },
    billingCycle: { type: String, enum: ["monthly", "annual"], required: true },

    paymentProvider: {
      type: String,
      enum: ["razorpay", "lemon_squeezy"],
      default: "razorpay",
    },
    currency: { type: String, enum: ["INR", "USD"], default: "INR" },

    razorpayOrderId: { type: String, sparse: true, unique: true },
    lemonSqueezyCheckoutId: { type: String, sparse: true, unique: true },
    lemonCheckoutUrl: { type: String, default: "" },
    transactionId: { type: String, sparse: true, unique: true },
    razorpaySignature: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },

    idempotencyKey: { type: String, sparse: true, unique: true },
    webhookVerified: { type: Boolean, default: false },
    failureReason: { type: String, default: "" },
    purchaseDate: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Transaction", transactionSchema);
