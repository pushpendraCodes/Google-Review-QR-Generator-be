import { Router } from "express";
import * as ctrl from "../controllers/client/portal.controller.js";
import { clientProtect } from "../middlewares/clientAuth.middleware.js";
import { authLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.post("/login", authLimiter, ctrl.login);
router.get("/me", clientProtect, ctrl.getMe);
router.get("/summary", clientProtect, ctrl.getSummary);
router.get("/payments", clientProtect, ctrl.getPayments);
router.post("/payment-claims", clientProtect, ctrl.createPaymentClaim);
router.post("/change-password", clientProtect, authLimiter, ctrl.changePassword);

export default router;
