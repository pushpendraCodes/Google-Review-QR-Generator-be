import { Router } from "express";
import { submitReview } from "../controllers/users/platformReview.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

router.post("/", protect, submitReview);

export default router;
