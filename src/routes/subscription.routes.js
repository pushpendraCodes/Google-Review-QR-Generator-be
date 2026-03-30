import { Router } from "express";
import * as ctrl from "../controllers/users/subscription.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { paymentLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.post("/create-order", protect, paymentLimiter, ctrl.createOrder);
router.post("/verify-payment", protect, ctrl.verifyPayment);
router.post("/webhook", ctrl.webhook);           // raw body — no JWT
router.post("/payment-failed", protect, ctrl.paymentFailed);
router.get("/active", protect, ctrl.getActiveSubscription);
router.get("/history", protect, ctrl.getHistory);

export default router;
