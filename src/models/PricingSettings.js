import mongoose from "mongoose";

const money = { INR: { type: Number, required: true }, USD: { type: Number, required: true } };
const planPrice = { monthly: money, annual: money };

// Single document (key "default") holding admin-editable prices, in paise / cents.
const pricingSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true },
    plans: {
      starter: planPrice,
      pro: planPrice,
      agency: planPrice,
    },
    team: {
      includedSeats: { type: Number, required: true },
      maxSeats: { type: Number, required: true },
      seatPriceMonthly: money,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("PricingSettings", pricingSettingsSchema);
