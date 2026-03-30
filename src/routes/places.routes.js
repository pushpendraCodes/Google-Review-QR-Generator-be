import { Router } from "express";
import * as ctrl from "../controllers/users/places.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

// Both routes require JWT — user must be logged in to search businesses
router.get("/search", protect, ctrl.searchBusinesses);
router.get("/details/:placeId", protect, ctrl.getPlaceDetails);

export default router;
