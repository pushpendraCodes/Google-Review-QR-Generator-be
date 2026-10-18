import User from "../../models/User.js";
import { getPricing, savePricing, validatePricing } from "../../services/pricing.service.js";

/** GET /api/admin/settings/pricing */
export const getPricingSettings = async (req, res) => {
  try {
    const highestExtraSeats = await User.findOne({ extraSeats: { $gt: 0 } })
      .sort({ extraSeats: -1 })
      .select("extraSeats")
      .lean();
    return res.json({ pricing: getPricing(), highestExtraSeats: highestExtraSeats?.extraSeats || 0 });
  } catch (err) {
    console.error("Admin getPricingSettings error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PUT /api/admin/settings/pricing
 * Body: { plans: { starter|pro|agency: { monthly|annual: { INR, USD } } },
 *         team: { includedSeats, maxSeats, seatPriceMonthly: { INR, USD } } }  — paise / cents
 */
export const updatePricingSettings = async (req, res) => {
  try {
    const { config, error } = validatePricing(req.body);
    if (error) return res.status(400).json({ message: error });

    const pricing = await savePricing(config, req.admin?._id);
    return res.json({ message: "Pricing updated", pricing });
  } catch (err) {
    console.error("Admin updatePricingSettings error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
