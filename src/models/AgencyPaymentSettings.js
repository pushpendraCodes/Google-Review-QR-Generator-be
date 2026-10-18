import mongoose from "mongoose";

// How an agency's clients can pay it (shown on the client portal "Pay now" screen).
// Money goes straight to the agency; the platform never handles it.
const agencyPaymentSettingsSchema = new mongoose.Schema(
  {
    agency: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    upiId: { type: String, default: "", trim: true },
    upiName: { type: String, default: "", trim: true },
    paymentLink: { type: String, default: "", trim: true },
    paymentLinkLabel: { type: String, default: "", trim: true },
    paypalMe: { type: String, default: "", trim: true },
    bankDetails: { type: String, default: "", trim: true },
    instructions: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

export default mongoose.model("AgencyPaymentSettings", agencyPaymentSettingsSchema);
