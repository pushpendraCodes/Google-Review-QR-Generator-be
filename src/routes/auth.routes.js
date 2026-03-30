import { Router } from "express";
import passport from "passport";
import * as ctrl from "../controllers/users/auth.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { authLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.post("/register", authLimiter, ctrl.register);
router.post("/verify-email", authLimiter, ctrl.verifyEmail);
router.post("/login", authLimiter, ctrl.login);
router.post("/forgot-password", authLimiter, ctrl.forgotPassword);
router.post("/verify-otp", authLimiter, ctrl.verifyOtp);
router.post("/reset-password", authLimiter, ctrl.resetPassword);
router.post("/resend-otp", authLimiter, ctrl.resendOtp);
router.post("/logout", protect, ctrl.logout);


router.post("/refresh-token", ctrl.refreshAccessToken);

// Google OAuth
router.get(
  "/google",
  passport.authenticate("google", { scope: ["profile", "email"], session: false })
);
router.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login?error=oauth_failed" }),
  ctrl.googleCallback
);

export default router;
