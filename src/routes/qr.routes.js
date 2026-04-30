import { Router } from "express";
import * as ctrl from "../controllers/users/qr.controller.js";
import { protect, planGuard, attachPlanLimits } from "../middlewares/auth.middleware.js";
import { qrGenerateLimiter, aiReviewLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// Scan redirect — no auth required (mounted at /r in app.js)
router.get("/:shortCode", ctrl.scanRedirect);

// Public landing page endpoints (no auth — called by customers)
router.get("/landing/:shortCode", ctrl.getLandingData);
router.post("/ai-reviews", aiReviewLimiter, ctrl.generateAIReviews);

// QR CRUD — all require JWT
router.get("/user/check-plan", protect, ctrl.checkUserPlan);
router.post(
  "/generate",
  protect,
  attachPlanLimits,
  qrGenerateLimiter,
  ctrl.generateQR
);
router.get("/get/:id", protect, ctrl.getQRCode);
router.put("/:id", protect, ctrl.updateQRCode);
router.delete("/:id", protect, ctrl.deleteQRCode);
router.get("/:id/download", protect, ctrl.downloadQRCode);
router.get("/:id/analytics", protect, planGuard("pro"), ctrl.getQRAnalytics);
router.get("/", protect, ctrl.listQRCodes);


export default router;
