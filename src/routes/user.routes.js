import { Router } from "express";
import * as ctrl from "../controllers/users/user.controller.js";
import { protect } from "../middlewares/auth.middleware.js";
import { handleImageUpload } from "../middlewares/Upload.middleware.js";


const router = Router();

router.get("/profile", protect, ctrl.getProfile);
router.put("/profile", protect, handleImageUpload, ctrl.updateProfile);
router.put("/change-password", protect, ctrl.changePassword);
router.delete("/account", protect, ctrl.deleteAccount);

export default router;
