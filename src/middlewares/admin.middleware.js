import jwt from "jsonwebtoken";
import AdminUser from "../models/AdminUser.js";

/**
 * Middleware: protect admin routes
 * Reads token from Authorization header OR from the `admin_token` cookie.
 */
const adminProtect = async (req, res, next) => {
  try {
    let token;

    // Prefer Authorization header
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      token = header.split(" ")[1];
    }
    // Fallback to cookie
    if (!token && req.cookies?.admin_token) {
      token = req.cookies.admin_token;
    }

    if (!token) {
      return res.status(401).json({ message: "Admin access token required" });
    }

    const decoded = jwt.verify(token, process.env.ADMIN_ACCESS_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET);

    const admin = await AdminUser.findById(decoded.id);
    if (!admin) return res.status(401).json({ message: "Admin account not found" });
    if (!admin.isActive) return res.status(403).json({ message: "Admin account is disabled" });

    req.admin = admin;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Admin token expired" });
    }
    return res.status(401).json({ message: "Invalid admin token" });
  }
};

export { adminProtect };
