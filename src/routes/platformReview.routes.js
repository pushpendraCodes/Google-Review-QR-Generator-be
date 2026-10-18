import { Router } from "express";
import { getFeaturedReviews, submitReview } from "../controllers/users/platformReview.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/featured", getFeaturedReviews);
router.post("/", protect, submitReview);

export default router;
