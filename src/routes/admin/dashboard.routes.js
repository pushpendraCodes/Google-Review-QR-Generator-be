import { Router } from "express";
import { getStats } from "../../controllers/admin/dashboard.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/stats", getStats);

export default router;
