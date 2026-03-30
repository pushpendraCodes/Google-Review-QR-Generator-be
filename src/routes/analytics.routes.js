import { Router } from "express";
import * as ctrl from "../controllers/users/analytics.controller.js";
import { protect, planGuard } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/summary", protect, planGuard("pro"), ctrl.getSummary);

export default router;
