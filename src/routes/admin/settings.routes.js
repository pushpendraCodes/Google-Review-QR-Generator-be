import { Router } from "express";
import { getPricingSettings, updatePricingSettings } from "../../controllers/admin/settings.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/pricing", getPricingSettings);
router.put("/pricing", updatePricingSettings);

export default router;
