import { Router } from "express";
import * as ctrl from "../controllers/users/places.controller.js";
const router = Router();

// Both routes are public — any user can search businesses
router.get("/search", ctrl.searchBusinesses);
router.get("/details/:placeId", ctrl.getPlaceDetails);

export default router;
