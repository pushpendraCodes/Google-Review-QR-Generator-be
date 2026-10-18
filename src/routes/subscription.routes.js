import { Router } from "express";
import * as ctrl from "../controllers/users/subscription.controller.js";
import { protect, ownerOnly } from "../middlewares/auth.middleware.js";
import { paymentLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.get("/pricing-region", ctrl.getPricingRegion);
router.get("/pricing", ctrl.getPricingConfig);
router.post("/create-order", protect, ownerOnly, paymentLimiter, ctrl.createOrder);
router.post("/create-lemon-checkout", protect, ownerOnly, paymentLimiter, ctrl.createLemonCheckoutHandler);
router.post("/verify-payment", protect, ownerOnly, ctrl.verifyPayment);
router.post("/verify-lemon-payment", protect, ownerOnly, ctrl.verifyLemonPayment);
router.post("/webhook", ctrl.webhook);                   // Razorpay — raw body
router.post("/lemon-webhook", ctrl.lemonWebhook);        // Lemon Squeezy — raw body
router.post("/payment-failed", protect, ownerOnly, ctrl.paymentFailed);
router.get("/active", protect, ctrl.getActiveSubscription);
router.get("/history", protect, ownerOnly, ctrl.getHistory);

export default router;
