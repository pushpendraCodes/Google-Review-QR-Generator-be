import { Router } from "express";
import * as ctrl from "../controllers/users/analytics.controller.js";
import { protect, planGuard } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/summary", protect, planGuard("pro"), ctrl.getSummary);
router.post("/sync", protect, planGuard("pro"), ctrl.syncUserAnalytics);

export default router;
