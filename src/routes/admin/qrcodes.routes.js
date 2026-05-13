import { Router } from "express";
import { getQRStats, listQRCodes } from "../../controllers/admin/qrcodes.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/stats", getQRStats);
router.get("/", listQRCodes);

export default router;
