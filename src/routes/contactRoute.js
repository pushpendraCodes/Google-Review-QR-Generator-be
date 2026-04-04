import express from "express";
import { sendEnquiry } from "../controllers/users/contactController.js";

const router = express.Router();

router.post("/enquiry", sendEnquiry);

export default router;