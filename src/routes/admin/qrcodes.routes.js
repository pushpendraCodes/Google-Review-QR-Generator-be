import { Router } from "express";
import {
  getQRStats,
  listQRCodes,
  getQRCode,
  listQRScans,
  setQRActive,
} from "../../controllers/admin/qrcodes.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/stats", getQRStats);
router.get("/", listQRCodes);
router.get("/:id", getQRCode);
router.get("/:id/scans", listQRScans);
router.patch("/:id/active", setQRActive);

export default router;
