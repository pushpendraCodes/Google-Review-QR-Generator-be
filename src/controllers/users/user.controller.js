import User from "../../models/User.js";
import Transaction from "../../models/Transaction.js";
import QRCode from "../../models/QRCode.js";
import { getCache, setCache, delCache } from "../../utils/cache.js";
import { uploadToCloudinary, deleteFromCloudinary } from "../../services/cloudinary.service.js";



// ─── Helper: extract B2 relative path from stored URL ────────────────────────
const extractB2Path = (url) => {
  if (!url) return null;
  const marker = process.env.B2_CDN_HOST
    ? `${process.env.B2_CDN_HOST}/`
    : `${process.env.B2_BUCKET_NAME}/`;
  const parts = url.split(marker);
  return parts.length > 1 ? parts[1] : null;
};

// ─── Helper: upload a file buffer to B2 and return public URL ────────────────
const uploadFileToB2 = async (file, folder, userId) => {
  const isPdf = file.mimetype === "application/pdf";
  const ext = isPdf ? "pdf" : file.mimetype.split("/")[1];
  const fileName = `${folder}/${userId}_${Date.now()}.${ext}`;
  return uploadToCloudinary(file.buffer, fileName, "profile_pictures");
};

// ─── Get profile ──────────────────────────────────────────────────────────────
export const getProfile = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const cacheKey = `user:profile:${userId}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found." });

    const result = { user };
    await setCache(cacheKey, result, 300); // 5 min

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Update profile ───────────────────────────────────────────────────────────
export const updateProfile = async (req, res) => {
  try {
    const { name, mobile, businessName, businessType, businessCity } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found." });

    // ── Upload new profile picture if attached ────────────────────────────────
    if (req.file) {
      const oldPath = extractB2Path(user?.picture);
      if (oldPath) await deleteFromCloudinary(oldPath);

      user.picture = await uploadFileToB2(req.file, "profile-pictures", req.user._id);
    }

    // ── Update text fields ────────────────────────────────────────────────────
    if (name) user.name = name.trim();
    if (mobile !== undefined) user.mobile = mobile;
    if (businessName !== undefined) user.businessName = businessName;
    if (businessType !== undefined) user.businessType = businessType;
    if (businessCity !== undefined) user.businessCity = businessCity;

    if (user.firstLogin && businessName) user.firstLogin = false;

    await user.save();
    await delCache(`user:profile:${req.user._id.toString()}`);

    res.json({ message: "Profile updated.", user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Change password ──────────────────────────────────────────────────────────
export const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      return res.status(400).json({ message: "Both old and new password are required." });

    const user = await User.findById(req.user._id).select("+password");
    if (user.authProvider === "google")
      return res.status(400).json({ message: "Google accounts cannot change password." });

    const match = await user.comparePassword(oldPassword);
    if (!match) return res.status(401).json({ message: "Old password is incorrect." });

    user.password = newPassword;
    await user.save();
    res.json({ message: "Password changed successfully." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Delete account ───────────────────────────────────────────────────────────
export const deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id.toString();

    const activeSub = await Transaction.findOne({
      user: req.user._id,
      status: "completed",
      plan: { $ne: null },
    }).sort({ purchaseDate: -1 });

    if (activeSub && req.user.plan !== "free") {
      const expiry = await User.findById(req.user._id).select("planExpiresAt");
      if (expiry.planExpiresAt && new Date(expiry.planExpiresAt) > new Date()) {
        return res.status(400).json({
          message: "You have an active subscription. Please wait until it expires or contact support.",
        });
      }
    }

    // Archive QR codes instead of hard delete
    await QRCode.updateMany({ owner: req.user._id }, { status: "archived" });
    await User.findByIdAndDelete(req.user._id);

    // Invalidate all user caches
    await delCache(`user:profile:${userId}`);
    await delCache(`sub:active:${userId}`);

    res.json({ message: "Account deleted successfully." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
