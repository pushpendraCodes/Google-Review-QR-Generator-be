import { Router } from "express";
import {
  login,
  logout,
  getMe,
  seedAdmin,
  forgotPassword,
  verifyOtp,
  resetPassword,
  resendOtp,
} from "../../controllers/admin/auth.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";
import { authLimiter } from "../../middlewares/rateLimit.middleware.js";

const router = Router();

// Public routes
router.post("/login", authLimiter, login);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/verify-otp", authLimiter, verifyOtp);
router.post("/reset-password", authLimiter, resetPassword);
router.post("/resend-otp", authLimiter, resendOtp);
router.post("/seed", seedAdmin); // One-time setup — remove in production

// Protected routes
router.post("/logout", adminProtect, logout);
router.get("/me", adminProtect, getMe);

export default router;
