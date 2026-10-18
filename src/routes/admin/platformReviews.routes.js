import { Router } from "express";
import {
  getPlatformReviewStats,
  listPlatformReviews,
  updatePlatformReview,
  deletePlatformReview,
} from "../../controllers/admin/platformReviews.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/stats", getPlatformReviewStats);
router.get("/", listPlatformReviews);
router.patch("/:id", updatePlatformReview);
router.delete("/:id", deletePlatformReview);

export default router;
