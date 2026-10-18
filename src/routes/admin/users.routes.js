import { Router } from "express";
import {
  listUsers,
  getUser,
  updateUserStatus,
  updateUserPlan,
  updateUserSeats,
  deleteUser,
} from "../../controllers/admin/users.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/", listUsers);
router.get("/:id", getUser);
router.patch("/:id/status", updateUserStatus);
router.patch("/:id/plan", updateUserPlan);
router.patch("/:id/seats", updateUserSeats);
router.delete("/:id", deleteUser);

export default router;
