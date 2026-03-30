import jwt from "jsonwebtoken";
import User from "../models/User.js";

// ─── JWT protect ──────────────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    const user = await User.findById(decoded.id).select("-password");
    if (!user) return res.status(401).json({ message: "User not found" });
    if (user.status === "block") return res.status(403).json({ message: "Account suspended" });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ─── Plan hierarchy ───────────────────────────────────────────────────────────
const PLAN_LEVEL = { free: 0, starter: 1, pro: 2, agency: 3 };

const QR_LIMITS = { free: 1, starter: 3, pro: 10, agency: Infinity };

// planGuard('pro') → user must be on pro or agency
const planGuard = (requiredPlan) => (req, res, next) => {
  const userLevel = PLAN_LEVEL[req.user.plan] ?? 0;
  const requiredLevel = PLAN_LEVEL[requiredPlan] ?? 0;

  // Check plan expiry for non-free plans
  if (req.user.plan !== "free" && req.user.planExpiresAt) {
    if (new Date(req.user.planExpiresAt) < new Date()) {
      return res.status(403).json({
        message: "Your subscription has expired. Please renew to access this feature.",
        upgrade: true,
      });
    }
  }

  if (userLevel < requiredLevel) {
    return res.status(403).json({
      message: `This feature requires the ${requiredPlan} plan or higher.`,
      requiredPlan,
      upgrade: true,
    });
  }

  next();
};

// Attach plan limits to req for use in controllers
const attachPlanLimits = (req, _res, next) => {
  req.qrLimit = QR_LIMITS[req.user.plan] ?? 1;
  next();
};

export { protect, planGuard, attachPlanLimits, QR_LIMITS, PLAN_LEVEL };
