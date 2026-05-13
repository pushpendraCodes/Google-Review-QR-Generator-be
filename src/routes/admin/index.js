/**
 * Admin API barrel — mounts all admin sub-routers under /api/admin
 *
 * Auth:       /api/admin/auth/*
 * Dashboard:  /api/admin/dashboard/*
 * Users:      /api/admin/users/*
 * Revenue:    /api/admin/revenue/*
 * QR Codes:   /api/admin/qrcodes/*
 */

import { Router } from "express";
import authRoutes from "./auth.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import usersRoutes from "./users.routes.js";
import revenueRoutes from "./revenue.routes.js";
import qrcodesRoutes from "./qrcodes.routes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/users", usersRoutes);
router.use("/revenue", revenueRoutes);
router.use("/qrcodes", qrcodesRoutes);

export default router;
