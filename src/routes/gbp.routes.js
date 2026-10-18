import express from "express";
import {
  disconnect,
  generateAiReply,
  getConnectUrl,
  getStatus,
  listReviews,
  oauthCallback,
  refreshLocations,
  replyToReview,
  selectLocation,
  syncReviews,
} from "../controllers/users/gbp.controller.js";
import { protect, planGuard } from "../middlewares/auth.middleware.js";
import { aiReviewLimiter } from "../middlewares/rateLimit.middleware.js";

const router = express.Router();

router.get("/callback", oauthCallback);

router.use(protect, planGuard("pro"));

router.get("/connect-url", getConnectUrl);
router.get("/status", getStatus);
router.post("/refresh-locations", refreshLocations);
router.post("/location", selectLocation);
router.post("/sync", syncReviews);
router.get("/reviews", listReviews);
router.post("/reviews/:reviewId/reply", replyToReview);
router.post("/reviews/:reviewId/ai-reply", aiReviewLimiter, generateAiReply);
router.delete("/disconnect", disconnect);

export default router;
