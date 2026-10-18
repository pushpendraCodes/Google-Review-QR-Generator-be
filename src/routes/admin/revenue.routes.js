import { Router } from "express";
import {
  getRevenueStats,
  listTransactions,
  exportTransactions,
} from "../../controllers/admin/revenue.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/stats", getRevenueStats);
router.get("/transactions", listTransactions);
router.get("/transactions/export", exportTransactions);

export default router;
