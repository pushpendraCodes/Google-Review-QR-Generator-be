import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
// import User from "../../models/User.js";
import { generateQRPng, generateQRSvg, generateQRPdf } from "../../services/qr.service.js";
import { uploadToB2 } from "../../services/b2.service.js";
import { buildReviewUrl } from "../../services/places.service.js";
import { dataURLtoBuffer, generateShortCode, QR_LIMITS, canUseFeature } from "../../utils/helpers.js";
import { getCache, setCache, delCache, invalidatePattern } from "../../utils/cache.js";
import axios from "axios";
import { deleteFromCloudinary, uploadToCloudinary } from "../../services/cloudinary.service.js";
import QRDownload from "../../models/QRDownload.js";

// ─── Generate QR ──────────────────────────────────────────────────────────────
// POST /api/qr/generate
// Body: { placeId, format, color?, logoUrl?, label? }






export const generateQR = async (req, res) => {
  try {
    const {
      // Place
      placeId,
      businessName,
      placeAddress = "",
      placeRating = 0,
      totalReviews = 0,
      label,

      // Download format (for logging only — file is generated on frontend)
      format = "png",

      // QR config
      color = "#1D9E75",
      shape = "square",
      logoData = null,            // base64 data-URI from frontend upload

      // Standee config
      template = "minimal",
      bgColor = "",
      socialProof = "",
      language = "en",
      whiteLabel = { enabled: false, clientName: "" },
    } = req.body;

    if (!placeId) return res.status(400).json({ success: false, message: "placeId is required." });
    if (!businessName) return res.status(400).json({ success: false, message: "businessName is required." });

    const user = req.user;
    const plan = user.plan;

    // ── Format gate ────────────────────────────────────────────────────────────
    if (format !== "png" && !canUseFeature(plan, "svgPdf")) {
      return res.status(403).json({
        success: false,
        message: "SVG/PDF download requires Starter plan or above.",
        upgrade: true,
      });
    }

    // ── Check if QR already exists for this user+business ──────────────────────
    const existing = await QRCode.findOne({ owner: user._id, placeId });

    if (!existing) {
      // ── NEW QR: check plan limit ─────────────────────────────────────────────
      const qrLimit = QR_LIMITS[plan] ?? 1;
      const currentCount = await QRCode.countDocuments({ owner: user._id, status: "active" });

      if (currentCount >= qrLimit) {
        return res.status(403).json({
          success: false,
          message: `Your ${plan} plan allows ${qrLimit} active QR code(s). Upgrade to create more.`,
          upgrade: true,
        });
      }
    }

    // ── Build sanitised configs (strip features the plan doesn't allow) ─────────
    const qrConfig = {
      color: canUseFeature(plan, "customColor") ? color : "#1D9E75",
      shape: canUseFeature(plan, "customShape") ? shape : "square",
      logoUrl: "",  // filled below if logo uploaded
    };

    const standeeConfig = {
      template: canUseFeature(plan, "standeeExtras") ? template : "minimal",
      bgColor: canUseFeature(plan, "standeeExtras") ? bgColor : "",
      socialProof: canUseFeature(plan, "standeeExtras") ? socialProof : "",
      language: canUseFeature(plan, "standeeExtras") ? language : "en",
      whiteLabel: {
        enabled: canUseFeature(plan, "whiteLabel") ? whiteLabel.enabled : false,
        clientName: canUseFeature(plan, "whiteLabel") ? whiteLabel.clientName : "",
      },
    };

    // ── Logo upload (pro+ only) ────────────────────────────────────────────────
    if (logoData && typeof logoData === 'string' && logoData.startsWith('data:') && canUseFeature(plan, "logo")) {
      try {
        // Use stable public_id so re-uploads overwrite instead of creating dupes
        const fileName = `logos_${user._id}_${placeId}`;
        const buffer = dataURLtoBuffer(logoData);
        qrConfig.logoUrl = await uploadToCloudinary(buffer, fileName, "business_logo");
      } catch (err) {
        console.error("Logo upload failed, continuing without logo:", err.message);
        // Non-fatal — proceed without logo
      }
    } else if (logoData && typeof logoData === 'string' && logoData.startsWith('http')) {
      // If logoData is already a URL, keep it
      qrConfig.logoUrl = logoData;
    }

    // ── Preserve existing logoUrl if no new logo was uploaded ─────────────────
    if (!logoData && existing?.qrConfig?.logoUrl) {
      qrConfig.logoUrl = existing.qrConfig.logoUrl;
    }

    const reviewUrl = buildReviewUrl(placeId);
    const hasWatermark = plan === "free";

    // ── Upsert: update config if existing, create if new ──────────────────────
    const qr = await QRCode.findOneAndUpdate(
      { owner: user._id, placeId },
      {
        $set: {
          businessName: label || businessName,
          label: label || businessName,
          placeAddress,
          placeRating,
          totalReviews,
          reviewUrl,
          qrConfig,
          standeeConfig,
          hasWatermark,
          status: "active",
        },
        // Only set shortCode and owner on insert, never overwrite
        $setOnInsert: {
          owner: user._id,
          placeId,
          shortCode: generateShortCode(),
        },
      },
      {
        upsert: true,
        new: true,          // return the updated doc
        runValidators: true,
      }
    );

    // ── Log this download event (for analytics — never blocks the response) ────
    QRDownload.create({
      qrCodeId: qr._id,
      owner: user._id,
      format,
      planAtTime: plan,
    }).catch(err => console.error("Download log failed:", err.message));

    // ── Invalidate caches ──────────────────────────────────────────────────────
    const uid = user._id.toString();
    await Promise.all([
      invalidatePattern(`qr:list:${uid}:*`),
      invalidatePattern(`analytics:*:${uid}:*`),
      existing ? delCache(`qr:detail:${uid}:${qr._id}`) : Promise.resolve(),
    ]);

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: existing ? "QR config updated." : "QR code created.",
      isNew: !existing,
      qr,
    });

  } catch (err) {
    // Duplicate key on shortCode is extremely rare but handle it
    if (err.code === 11000 && err.keyPattern?.shortCode) {
      return res.status(500).json({ success: false, message: "Collision on shortCode, please retry." });
    }
    console.error("QR generate error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};


export const checkUserPlan = async (req, res) => {
  try {

    const user = req.user;
    const plan = user.plan;

    // ── Plan limits check ──────────────────────────────────────────────────────
    const qrLimit = QR_LIMITS[plan] ?? 1;
    const currentCount = await QRCode.countDocuments({ owner: user._id, status: "active" });

    if (currentCount >= qrLimit) {
      return res.status(403).json({
        message: `Your ${plan} plan allows a maximum of ${qrLimit} active QR code(s). Please upgrade to create more.`,
        upgrade: true,
        success: false,
      });
    }
    res.status(200).json({
      success: true,
      message: "User plan checked successfully.",
      plan,
      qrLimit,
      currentCount,
    });
  } catch (err) {
    console.error("User plan check error:", err);
    res.status(500).json({ success: false, message: err.message });
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
    console.log(req.user._id, "user")
    console.log(req.params.id, "qrId")
    const userId = req.user._id.toString();
    const qrId = req.params.id;
    const cacheKey = `qr:detail:${userId}:${qrId}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);


    const qr = await QRCode.findOne({ _id: qrId, owner: req.user._id });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const result = { success: true, qr };
    await setCache(cacheKey, result, 120); // 2 min

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Update QR ────────────────────────────────────────────────────────────────
export const updateQRCode = async (req, res) => {
  try {
    const {
      label,
      // qrConfig fields
      color, shape, logoData,
      // standeeConfig fields
      template, bgColor, socialProof, language, whiteLabel,
    } = req.body;

    const qr = await QRCode.findOne({ _id: req.params.id, owner: req.user._id });
    if (!qr) return res.status(404).json({ success: false, message: "QR code not found." });

    const plan = req.user.plan;

    // ── Label (any plan) ───────────────────────────────────────────────────────
    if (label !== undefined) qr.label = label;

    // ── QR config ─────────────────────────────────────────────────────────────
    if (color !== undefined && canUseFeature(plan, "customColor")) {
      qr.qrConfig.color = color;
    }
    if (shape !== undefined && canUseFeature(plan, "customShape")) {
      qr.qrConfig.shape = shape;
    }

    // Logo upload
    if (logoData && canUseFeature(plan, "logo")) {
      try {

        if (qr.qrConfig.logoUrl) {
          await deleteFromCloudinary(qr.qrConfig.logoUrl);
        }

        const fileName = `logos_${req.user._id}_${qr.placeId}`;
        const buffer = dataURLtoBuffer(logoData);
        qr.qrConfig.logoUrl = await uploadToCloudinary(buffer, fileName, "business_logo");
      } catch (err) {
        console.error("Logo update failed:", err.message);
      }
    }

    // ── Standee config ────────────────────────────────────────────────────────
    if (canUseFeature(plan, "standeeExtras")) {
      if (template !== undefined) qr.standeeConfig.template = template;
      if (bgColor !== undefined) qr.standeeConfig.bgColor = bgColor;
      if (socialProof !== undefined) qr.standeeConfig.socialProof = socialProof;
      if (language !== undefined) qr.standeeConfig.language = language;
    }

    if (whiteLabel !== undefined && canUseFeature(plan, "whiteLabel")) {
      qr.standeeConfig.whiteLabel = whiteLabel;
    }

    await qr.save();

    const uid = req.user._id.toString();
    await Promise.all([
      delCache(`qr:detail:${uid}:${req.params.id}`),
      invalidatePattern(`qr:list:${uid}:*`),
    ]);

    return res.json({ success: true, message: "QR code updated.", qr });

  } catch (err) {
    console.error("QR update error:", err);
    return res.status(500).json({ success: false, message: err.message });
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

    const [totalScans, dailyData, trends, deviceData, cityData] = await Promise.all([
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

      DailyMetric.find({ qrCode: qr._id, date: { $gte: since } })
        .sort({ date: 1 })
        .select("date totalReviewsGrowth avgRatingGrowth"),

      ScanLog.aggregate([
        { $match: { qrCode: qr._id, scannedAt: { $gte: since } } },
        {
          $group: {
            _id: {
              $cond: [
                { $regexMatch: { input: "$userAgent", regex: /mobile/i } }, "Mobile",
                { $cond: [{ $regexMatch: { input: "$userAgent", regex: /tablet/i } }, "Tablet", "Desktop"] }
              ]
            },
            count: { $sum: 1 }
          }
        }
      ]),

      ScanLog.aggregate([
        { $match: { qrCode: qr._id, scannedAt: { $gte: since } } },
        { $group: { _id: "$city", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const result = {
      qr: {
        id: qr._id,
        businessName: qr.businessName,
        totalScanCount: qr.scanCount,
        rating: qr.placeRating,
        totalReviews: qr.totalReviews,
        latestReviews: qr.latestReviews
      },
      period: { range, days, since },
      totalScans,
      dailyData,
      trends: trends.map(t => ({
        date: t.date.toISOString().split("T")[0],
        reviews: t.totalReviewsGrowth,
        rating: t.avgRatingGrowth
      })),
      devices: deviceData.map(d => ({ type: d._id, count: d.count })),
      cities: cityData.map(c => ({ name: c._id || "Unknown", count: c.count })),
    };

    // Cache for 2 minutes
    await setCache(cacheKey, result, 120);

    res.json(result);
  } catch (err) {
    console.error("QR Analytics Error:", err);
    res.status(500).json({ message: err.message });
  }
};

