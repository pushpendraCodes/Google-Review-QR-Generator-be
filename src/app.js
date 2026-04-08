import express from "express";
import cors from "cors";
import passport from "passport";
import "./config/passport.js";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import qrRoutes from "./routes/qr.routes.js";
import subscriptionRoutes from "./routes/subscription.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import placesRoutes from "./routes/places.routes.js";
import contactRoutes from "./routes/contactRoute.js";

const app = express();

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: ["http://localhost:5173", "https://google-review-qr-generator-fe.vercel.app"],
    credentials: true,
  })
);

// ─── Body parsers ─────────────────────────────────────────────────────────────
// Raw body needed for Razorpay webhook signature verification
app.use("/api/subscription/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// cookie parser
app.use(cookieParser());

// ─── Passport (Google OAuth session-less) ─────────────────────────────────────
app.use(passport.initialize());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/qr", qrRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/places", placesRoutes);         // business search
app.use("/r", qrRoutes);                      // scan redirect /r/:shortCode
app.use("/api/contact", contactRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ message: "Route not found" }));

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal server error" });
});

export default app;
