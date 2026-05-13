import { Router } from "express";
import { login, logout, getMe, seedAdmin } from "../../controllers/admin/auth.controller.js";
import { adminProtect } from "../../middlewares/admin.middleware.js";

const router = Router();

// Public routes
router.post("/login", login);
router.post("/seed", seedAdmin); // One-time setup — remove in production

// Protected routes
router.post("/logout", adminProtect, logout);
router.get("/me", adminProtect, getMe);

export default router;
