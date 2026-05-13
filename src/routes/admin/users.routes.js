import { Router } from "express";
import {
  listUsers,
  getUser,
  updateUserStatus,
  deleteUser,
} from "../../controllers/admin/users.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

router.use(adminProtect);

router.get("/", listUsers);
router.get("/:id", getUser);
router.patch("/:id/status", updateUserStatus);
router.delete("/:id", deleteUser);

export default router;
