import { Router } from "express";
import * as ctrl from "../controllers/users/clients.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

// Agency side: manage read-only client logins.
const router = Router();

router.use(protect);

router.get("/", ctrl.listClients);
router.post("/", ctrl.createClient);
router.get("/payment-methods", ctrl.getPaymentMethods);
router.put("/payment-methods", ctrl.updatePaymentMethods);
router.get("/:id", ctrl.getClient);
router.post("/:id/claims/:claimId/confirm", ctrl.confirmClaim);
router.post("/:id/claims/:claimId/reject", ctrl.rejectClaim);
router.patch("/:id", ctrl.updateClient);
router.patch("/:id/billing/:qrId", ctrl.updateClientBilling);
router.post("/:id/payments", ctrl.recordClientPayment);
router.delete("/:id/payments/:qrId/:paymentId", ctrl.deleteClientPayment);
router.post("/:id/reset-password", ctrl.resetClientPassword);
router.delete("/:id", ctrl.deleteClient);

export default router;
