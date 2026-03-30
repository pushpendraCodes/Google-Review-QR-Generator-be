import { Router } from "express";
import * as ctrl from "../controllers/users/qr.controller.js";
import { protect, planGuard, attachPlanLimits } from "../middlewares/auth.middleware.js";
import { qrGenerateLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// Scan redirect — no auth required (mounted at /r in app.js)
router.get("/:shortCode", ctrl.scanRedirect);

// QR CRUD — all require JWT
router.post(
  "/generate",
  protect,
  attachPlanLimits,
  qrGenerateLimiter,
  ctrl.generateQR
);

router.get("/", protect, ctrl.listQRCodes);
router.get("/:id", protect, ctrl.getQRCode);
router.put("/:id", protect, ctrl.updateQRCode);
router.delete("/:id", protect, ctrl.deleteQRCode);
router.get("/:id/download", protect, ctrl.downloadQRCode);
router.get("/:id/analytics", protect, planGuard("pro"), ctrl.getQRAnalytics);

export default router;
