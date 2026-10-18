import { Router } from "express";
import * as ctrl from "../controllers/users/team.controller.js";
import { getSeatQuote, createSeatCheckout } from "../controllers/users/subscription.controller.js";
import { protect, ownerOnly } from "../middlewares/auth.middleware.js";

const router = Router();

// Public: invite preview for the accept page
router.get("/invite/:token", ctrl.getInviteInfo);

router.use(protect);

router.get("/", ctrl.getTeam);
router.post("/invites", ctrl.inviteMember);
router.post("/invites/:id/resend", ctrl.resendInvite);
router.delete("/invites/:id", ctrl.revokeInvite);
router.delete("/members/:id", ctrl.removeMember);
router.post("/accept", ctrl.acceptInvite);
router.post("/leave", ctrl.leaveTeam);

// Extra seats (owner only)
router.get("/seats/quote", ownerOnly, getSeatQuote);
router.post("/seats/checkout", ownerOnly, createSeatCheckout);
router.patch("/seats", ownerOnly, ctrl.reduceSeats);

export default router;
