import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { resolveAccount } from "../services/team.service.js";

// Routes a staff member can still use after their Agency owner's plan lapsed
// (so they can see what happened, leave the team or manage their own profile).
const INACTIVE_TEAM_ALLOWED = ["/api/auth", "/api/team", "/api/user"];

// ─── JWT protect ──────────────────────────────────────────────────────────────
// Sets:
//   req.user    → the logged-in person
//   req.account → whose data/plan they act on (themselves, or their Agency owner)
//   req.isStaff → true for Agency team members
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

    const { account, isStaff, teamActive } = await resolveAccount(user);

    req.user = user;
    req.isStaff = isStaff;
    req.teamActive = teamActive;
    req.account = teamActive ? account : { _id: account?._id ?? user.teamOwner, plan: "free", planExpiresAt: null };

    if (isStaff && !teamActive && !INACTIVE_TEAM_ALLOWED.some((p) => req.baseUrl.startsWith(p))) {
      return res.status(403).json({
        code: "TEAM_INACTIVE",
        message: "Your agency's plan is no longer active. Ask your agency owner to renew, or leave the team from Team settings.",
      });
    }

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ─── Owner only (blocks Agency staff) ─────────────────────────────────────────
const ownerOnly = (req, res, next) => {
  if (req.isStaff) {
    return res.status(403).json({
      code: "STAFF_FORBIDDEN",
      message: "Only your agency owner can do this.",
    });
  }
  next();
};

// ─── Plan hierarchy ───────────────────────────────────────────────────────────
const PLAN_LEVEL = { free: 0, starter: 1, pro: 2, agency: 3 };

const QR_LIMITS = { free: 1, starter: 3, pro: 10, agency: Infinity };

// planGuard('pro') → account must be on pro or agency
const planGuard = (requiredPlan) => (req, res, next) => {
  const { plan, planExpiresAt } = req.account;
  const userLevel = PLAN_LEVEL[plan] ?? 0;
  const requiredLevel = PLAN_LEVEL[requiredPlan] ?? 0;

  // Check plan expiry for non-free plans
  if (plan !== "free" && planExpiresAt) {
    if (new Date(planExpiresAt) < new Date()) {
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
  req.qrLimit = QR_LIMITS[req.account.plan] ?? 1;
  next();
};

export { protect, ownerOnly, planGuard, attachPlanLimits, QR_LIMITS, PLAN_LEVEL };
