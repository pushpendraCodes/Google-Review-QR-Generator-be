import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// A read-only login an Agency gives to one of its clients (e.g. a restaurant owner).
// Kept separate from User so client sessions can never reach agency routes.
const clientAccountSchema = new mongoose.Schema(
  {
    agency: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    qrCodes: [{ type: mongoose.Schema.Types.ObjectId, ref: "QRCode" }],
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    // Currency the agency bills this client in (amounts on its QRs' agencyBilling).
    billingCurrency: { type: String, default: "INR" },
    // Bumped on password reset / disable so existing sessions stop working.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    // Set when the overdue-payment block email went out; cleared once the client is no longer overdue.
    billingBlockedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

clientAccountSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

clientAccountSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

export default mongoose.model("ClientAccount", clientAccountSchema);
