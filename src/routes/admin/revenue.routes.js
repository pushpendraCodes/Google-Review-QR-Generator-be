import { Router } from "express";
import { getRevenueStats, listTransactions } from "../../controllers/admin/revenue.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/stats", getRevenueStats);
router.get("/transactions", listTransactions);

export default router;
