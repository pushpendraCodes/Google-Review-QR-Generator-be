import rateLimit from "express-rate-limit";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const qrGenerateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 min
  max: 5,
  keyGenerator: (req) => req.user?.id || "anonymous",
  message: { message: "Too many QR generation requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 5,
  keyGenerator: (req) => req.user?.id || "anonymous",
  message: { message: "Too many payment requests. Please try again shortly." },
  standardHeaders: true,
  legacyHeaders: false,
});

export { authLimiter, qrGenerateLimiter, paymentLimiter };
