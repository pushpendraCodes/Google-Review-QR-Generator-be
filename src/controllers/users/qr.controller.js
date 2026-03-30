import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import User from "../../models/User.js";
import { generateQRPng, generateQRSvg, generateQRPdf } from "../../services/qr.service.js";
import { uploadToB2 } from "../../services/b2.service.js";
import { buildReviewUrl, getPlaceDetails } from "../../services/places.service.js";
import { generateShortCode, QR_LIMITS } from "../../utils/helpers.js";
import { getCache, setCache, delCache, invalidatePattern } from "../../utils/cache.js";
import axios from "axios";

// ─── Generate QR ──────────────────────────────────────────────────────────────
// POST /api/qr/generate
// Body: { placeId, format, color?, logoUrl?, label? }
export const generateQR = async (req, res) => {
  try {
    const { placeId, format = "png", color = "#000000", logoUrl, label } = req.body;

    if (!placeId) return res.status(400).json({ message: "placeId is required." });

    const user = req.user;
    const plan = user.plan;

    // ── Plan limits check ──────────────────────────────────────────────────────
    const qrLimit = QR_LIMITS[plan] ?? 1;
    const currentCount = await QRCode.countDocuments({ owner: user._id, status: "active" });

    if (currentCount >= qrLimit) {
      return res.status(403).json({
        message: `Your ${plan} plan allows a maximum of ${qrLimit} active QR code(s). Please upgrade to create more.`,
        upgrade: true,
      });
    }

    // ── Plan feature checks ────────────────────────────────────────────────────
    const canCustomColor = ["starter", "pro", "agency"].includes(plan);
    const canLogo = ["pro", "agency"].includes(plan);
    const canSvgPdf = ["starter", "pro", "agency"].includes(plan);
    const hasWatermark = plan === "free";

    if (format !== "png" && !canSvgPdf) {
      return res.status(403).json({ message: "SVG/PDF download requires Starter plan or above." });
    }

    // ── Fetch place details from Google ────────────────────────────────────────
    let placeDetails;
    try {
      placeDetails = await getPlaceDetails(placeId);
    } catch {
      return res.status(400).json({ message: "Invalid placeId or unable to fetch place details." });
    }

    const reviewUrl = buildReviewUrl(placeId);
    const shortCode = generateShortCode();
    const redirectUrl = `${process.env.BACKEND_URL || process.env.FRONTEND_URL}/r/${shortCode}`;

    // ── Download logo buffer if provided ────────────────────────────────────────
    let logoBuf = null;
    if (logoUrl && canLogo) {
      try {
        const resp = await axios.get(logoUrl, { responseType: "arraybuffer", timeout: 5000 });
        logoBuf = Buffer.from(resp.data);
      } catch {
        // Logo fetch failed — proceed without logo
      }
    }

    const effectiveColor = canCustomColor ? color : "#000000";

    // ── Generate QR buffer ─────────────────────────────────────────────────────
    let fileBuffer;
    let mimeType;
    let fileExt;

    if (format === "svg") {
      fileBuffer = await generateQRSvg(redirectUrl, effectiveColor);
      mimeType = "image/svg+xml";
      fileExt = "svg";
    } else if (format === "pdf") {
      const pngBuf = await generateQRPng(redirectUrl, effectiveColor, logoBuf, hasWatermark);
      fileBuffer = await generateQRPdf(redirectUrl, placeDetails.name, pngBuf);
      mimeType = "application/pdf";
      fileExt = "pdf";
    } else {
      fileBuffer = await generateQRPng(redirectUrl, effectiveColor, logoBuf, hasWatermark);
      mimeType = "image/png";
      fileExt = "png";
    }

    // ── Upload to Backblaze B2 ─────────────────────────────────────────────────
    const b2FileName = `qrcodes/${user._id}/${shortCode}.${fileExt}`;
    const qrImageUrl = await uploadToB2(fileBuffer, b2FileName, mimeType);

    // ── Save to DB ─────────────────────────────────────────────────────────────
    const qr = await QRCode.create({
      owner: user._id,
      businessName: label || placeDetails.name,
      placeId,
      placeAddress: placeDetails.address,
      reviewUrl,
      qrImageUrl,
      format,
      customColor: effectiveColor,
      logoUrl: canLogo && logoUrl ? logoUrl : "",
      hasWatermark,
      shortCode,
      label: label || placeDetails.name,
      status: "active",
    });

    // Invalidate QR list & analytics caches for this user
    const userId = user._id.toString();
    await invalidatePattern(`qr:list:${userId}:*`);
    await invalidatePattern(`analytics:*:${userId}:*`);

    res.status(201).json({
      message: "QR code generated successfully.",
      qr,
    });
  } catch (err) {
    console.error("QR generate error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── List QR codes ────────────────────────────────────────────────────────────
// GET /api/qr?page=1&limit=10&search=salon
export const listQRCodes = async (req, res) => {
  try {
    const { page = 1, limit = 10, search } = req.query;
    const userId = req.user._id.toString();
    const cacheKey = `qr:list:${userId}:${page}:${limit}:${search || ""}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = { owner: req.user._id, status: "active" };

    if (search) {
      query.$or = [
        { businessName: { $regex: search, $options: "i" } },
        { label: { $regex: search, $options: "i" } },
      ];
    }

    const [qrCodes, total] = await Promise.all([
      QRCode.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      QRCode.countDocuments(query),
    ]);

    const result = {
      qrCodes,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / limit),
      },
    };

    // Cache for 60 seconds
    await setCache(cacheKey, result, 60);

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Get single QR ────────────────────────────────────────────────────────────
export const getQRCode = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const qrId = req.params.id;
    const cacheKey = `qr:detail:${userId}:${qrId}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const qr = await QRCode.findOne({ _id: qrId, owner: req.user._id });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const result = { qr };
    await setCache(cacheKey, result, 120); // 2 min

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Update QR ────────────────────────────────────────────────────────────────
export const updateQRCode = async (req, res) => {
  try {
    const { label, color, logoUrl } = req.body;
    const qr = await QRCode.findOne({ _id: req.params.id, owner: req.user._id });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const plan = req.user.plan;
    if (label !== undefined) qr.label = label;
    if (color && ["starter", "pro", "agency"].includes(plan)) qr.customColor = color;
    if (logoUrl !== undefined && ["pro", "agency"].includes(plan)) qr.logoUrl = logoUrl;

    await qr.save();

    // Invalidate caches
    const userId = req.user._id.toString();
    await delCache(`qr:detail:${userId}:${req.params.id}`);
    await invalidatePattern(`qr:list:${userId}:*`);

    res.json({ message: "QR code updated.", qr });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Archive / Delete QR ──────────────────────────────────────────────────────
export const deleteQRCode = async (req, res) => {
  try {
    const qr = await QRCode.findOne({ _id: req.params.id, owner: req.user._id });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    qr.status = "archived";
    await qr.save();

    // Invalidate caches
    const userId = req.user._id.toString();
    await delCache(`qr:detail:${userId}:${req.params.id}`);
    await invalidatePattern(`qr:list:${userId}:*`);
    await invalidatePattern(`analytics:*:${userId}:*`);

    res.json({ message: "QR code archived." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Download QR ──────────────────────────────────────────────────────────────
// GET /api/qr/:id/download?format=svg
export const downloadQRCode = async (req, res) => {
  try {
    const qr = await QRCode.findOne({ _id: req.params.id, owner: req.user._id });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const requestedFormat = req.query.format || qr.format;
    const plan = req.user.plan;

    if (requestedFormat !== "png" && plan === "free") {
      return res.status(403).json({ message: "SVG/PDF download requires a paid plan." });
    }

    const redirectUrl = `${process.env.BACKEND_URL || process.env.FRONTEND_URL}/r/${qr.shortCode}`;

    let fileBuffer, mimeType, ext;
    if (requestedFormat === "svg") {
      fileBuffer = await generateQRSvg(redirectUrl, qr.customColor);
      mimeType = "image/svg+xml";
      ext = "svg";
    } else if (requestedFormat === "pdf") {
      const pngBuf = await generateQRPng(redirectUrl, qr.customColor, null, qr.hasWatermark);
      fileBuffer = await generateQRPdf(redirectUrl, qr.businessName, pngBuf);
      mimeType = "application/pdf";
      ext = "pdf";
    } else {
      fileBuffer = await generateQRPng(redirectUrl, qr.customColor, null, qr.hasWatermark);
      mimeType = "image/png";
      ext = "png";
    }

    const safeName = qr.businessName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    res.set("Content-Type", mimeType);
    res.set("Content-Disposition", `attachment; filename="${safeName}_qr.${ext}"`);
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Scan redirect ────────────────────────────────────────────────────────────
// GET /r/:shortCode  — no auth, logs scan and 302 → Google review URL
export const scanRedirect = async (req, res) => {
  try {
    const shortCode = req.params.shortCode;

    // Cache the QR lookup since this is the most hit endpoint
    const cacheKey = `qr:scan:${shortCode}`;
    let qr;
    const cached = await getCache(cacheKey);

    if (cached) {
      qr = cached;
    } else {
      qr = await QRCode.findOne({ shortCode, status: "active" }).lean();
      if (!qr) return res.status(404).send("QR code not found.");
      // Cache for 10 minutes — scan redirect is the hottest path
      await setCache(cacheKey, qr, 600);
    }

    // Increment scan count (fire-and-forget)
    QRCode.findByIdAndUpdate(qr._id, { $inc: { scanCount: 1 } }).exec();

    // Log scan details
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "";
    const userAgent = req.headers["user-agent"] || "";
    const hashedIp = ScanLog.hashIp(ip);

    // Geo-lookup via ip-api (free tier, fire-and-forget)
    let city = "";
    let country = "";
    try {
      const geo = await axios.get(`http://ip-api.com/json/${ip}?fields=city,country`, {
        timeout: 2000,
      });
      city = geo.data.city || "";
      country = geo.data.country || "";
    } catch {
      // Geo lookup failure is non-fatal
    }

    await ScanLog.create({ qrCode: qr._id, userAgent, ip: hashedIp, city, country });

    res.redirect(302, qr.reviewUrl);
  } catch (err) {
    console.error("Scan redirect error:", err.message);
    res.redirect(302, "https://google.com");
  }
};

// ─── Analytics for single QR ──────────────────────────────────────────────────
// GET /api/qr/:id/analytics?range=7d
export const getQRAnalytics = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const qrId = req.params.id;
    const range = req.query.range || "7d";
    const cacheKey = `analytics:qr:${userId}:${qrId}:${range}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const qr = await QRCode.findOne({ _id: qrId, owner: req.user._id });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const days = range === "30d" ? 30 : range === "90d" ? 90 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalScans, dailyData, topHours, cityData] = await Promise.all([
      ScanLog.countDocuments({ qrCode: qr._id, scannedAt: { $gte: since } }),

      ScanLog.aggregate([
        { $match: { qrCode: qr._id, scannedAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$scannedAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      ScanLog.aggregate([
        { $match: { qrCode: qr._id, scannedAt: { $gte: since } } },
        { $group: { _id: { $hour: "$scannedAt" }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),

      ScanLog.aggregate([
        { $match: { qrCode: qr._id, scannedAt: { $gte: since } } },
        { $group: { _id: "$city", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const result = {
      qr: { id: qr._id, businessName: qr.businessName, totalScanCount: qr.scanCount },
      period: { range, days, since },
      totalScans,
      dailyData,
      topHours,
      cityData,
    };

    // Cache for 2 minutes
    await setCache(cacheKey, result, 120);

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
