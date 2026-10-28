import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import DailyMetric from "../../models/DailyMetric.js";
import User from "../../models/User.js";
import { generateQRPng, generateQRSvg, generateQRPdf } from "../../services/qr.service.js";
import { uploadToB2 } from "../../services/b2.service.js";
import { buildReviewUrl, getPlaceDetails } from "../../services/places.service.js";
import { dataURLtoBuffer, generateShortCode, QR_LIMITS, canUseFeature, hasActivePaidPlan } from "../../utils/helpers.js";
import { getCache, setCache, delCache, invalidatePattern } from "../../utils/cache.js";
import axios from "axios";
import { deleteFromCloudinary, uploadToCloudinary } from "../../services/cloudinary.service.js";
import QRDownload from "../../models/QRDownload.js";
import { sendQrTipsEmail } from "../../services/email.service.js";
import { generateReviewSuggestions, generatePersonalisedReviews, draftReviewProfile } from "../../services/ai.service.js";
import {
  DEFAULT_LIKED,
  PROFILE_LIMITS,
  buildQuestions,
  profileEnabled,
  sanitizeProfile,
  validateAnswers,
} from "../../services/reviewProfile.service.js";
import { refreshQrFromGoogle } from "../../services/googleSync.service.js";
import { qrScope, invalidateQrCaches } from "../../services/team.service.js";
import { notifyOwnerOfStaffAction } from "../../services/agencyNotify.service.js";
import { STOP_FIELDS, isQrPaused, planGraceInfo, qrStopBlock, startFreeTrialIfNeeded, syncPlanPause } from "../../services/planGrace.service.js";

import mongoose from "mongoose";

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const RECENT_REVIEWS_KEPT = 15;

/** False when the QR was stopped by its owner, or its Free period / plan grace is over. */
const isQrServing = (qr, owner) => qr.isActive !== false && !isQrPaused(qr, owner);

const pausedQrPage = (businessName) => `
        <html>
          <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Temporarily unavailable</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 2rem; background: #f9f9f9;">
            <div style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px; margin: 2rem auto;">
              <h2 style="color: #b45309; margin-top: 0;">Temporarily unavailable</h2>
              <p style="color: #555; line-height: 1.5;">The review link for <strong>${escapeHtml(businessName || "this business")}</strong> is paused right now.</p>
              <p style="color: #555; line-height: 1.5;">Please let the staff know, or try again later.</p>
            </div>
          </body>
        </html>
      `;

/** Logos are only ever hosted on our Cloudinary account; never store arbitrary URLs. */
const isUploadedLogoUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com";
  } catch {
    return false;
  }
};

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
    const account = req.account;
    const plan = account.plan;

    // ── Format gate ────────────────────────────────────────────────────────────
    if (format !== "png" && !canUseFeature(plan, "svgPdf")) {
      return res.status(403).json({
        success: false,
        message: "SVG/PDF download requires Starter plan or above.",
        upgrade: true,
      });
    }

    // ── Check if QR already exists for this account+business ───────────────────
    const existing = await QRCode.findOne({ owner: account._id, placeId });
    const reviving = existing?.status === "archived";

    if (existing && !reviving && req.isStaff && String(existing.createdBy) !== String(user._id)) {
      return res.status(409).json({
        success: false,
        message: "This business already has a QR code in your agency account. Ask your agency owner if you need access to it.",
      });
    }

    const stopBlock = req.isStaff ? null : qrStopBlock(account, existing);
    if (stopBlock) return res.status(403).json({ success: false, ...stopBlock });

    if (!existing || reviving) {
      // ── NEW or revived QR: check plan limit ──────────────────────────────────
      const qrLimit = QR_LIMITS[plan] ?? 1;
      const currentCount = await QRCode.countDocuments({ owner: account._id, status: "active" });

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
        const fileName = `logos_${account._id}_${placeId}`;
        const buffer = dataURLtoBuffer(logoData);
        qrConfig.logoUrl = await uploadToCloudinary(buffer, fileName, "business_logo");
      } catch (err) {
        console.error("Logo upload failed, continuing without logo:", err.message);
        // Non-fatal — proceed without logo
      }
    } else if (
      typeof logoData === "string" &&
      canUseFeature(plan, "logo") &&
      (logoData === existing?.qrConfig?.logoUrl || isUploadedLogoUrl(logoData))
    ) {
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
      { owner: account._id, placeId },
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
          // An archived QR brought back belongs to whoever revived it
          ...(reviving ? { createdBy: user._id } : {}),
        },
        // Only set shortCode and owner on insert, never overwrite
        $setOnInsert: {
          owner: account._id,
          placeId,
          shortCode: generateShortCode(),
          ...(reviving ? {} : { createdBy: user._id }),
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
      owner: account._id,
      format,
      planAtTime: plan,
    }).catch(err => console.error("Download log failed:", err.message));

    // ── Replace client-sent rating/review count with live Google data ─────────
    try {
      await refreshQrFromGoogle(qr);
    } catch (err) {
      console.error("Google sync on generate failed:", err.message);
    }

    if (!req.isStaff && (!existing || reviving)) {
      await startFreeTrialIfNeeded(account);
      await syncPlanPause(account._id);
    }

    // ── Invalidate caches ──────────────────────────────────────────────────────
    await invalidateQrCaches(req, { qrId: qr._id, createdBy: existing?.createdBy });

    if (!existing && user.emailNotifications !== false) {
      sendQrTipsEmail(user.email, {
        userName: user.name,
        businessName: qr.businessName,
      }).catch((err) => console.error("Tips email failed:", err.message));
    }

    if (!existing || reviving) {
      notifyOwnerOfStaffAction(req, {
        title: "Your team added a QR code",
        summary: "created a new Google Review QR code.",
        details: [
          ["Business", qr.businessName],
          ["Address", qr.placeAddress],
          ["Short link", qr.shortURL],
        ],
        path: "/dashboard/standees",
        linkText: "View QR codes",
      });
    }

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

    const plan = req.account.plan;

    const stopBlock = req.isStaff ? null : qrStopBlock(req.account);
    if (stopBlock) return res.status(403).json({ success: false, ...stopBlock });

    // ── Plan limits check (limits are per account, shared by the whole team) ──
    const qrLimit = QR_LIMITS[plan] ?? 1;
    const currentCount = await QRCode.countDocuments({ owner: req.account._id, status: "active" });

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
// GET /api/qr?page=1&limit=10&search=salon&member=me|<staffUserId>
// `member` is only honoured for account owners (staff always see just their own QRs).
export const listQRCodes = async (req, res) => {
  try {
    const { search } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const member = req.isStaff ? "" : String(req.query.member || "");
    const userId = req.user._id.toString();
    const cacheKey = `qr:list:${userId}:${page}:${limit}:${search || ""}:${member}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = { ...qrScope(req), status: "active" };

    if (member === "me") {
      query.createdBy = { $in: [null, req.user._id] };
    } else if (member && mongoose.isValidObjectId(member)) {
      query.createdBy = member;
    }

    if (search) {
      const pattern = String(search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { businessName: { $regex: pattern, $options: "i" } },
        { label: { $regex: pattern, $options: "i" } },
      ];
    }

    const accountActive = { owner: req.account._id, status: "active" };
    const [qrCodes, total, accountTotal, accountPaused] = await Promise.all([
      QRCode.find(query)
        .populate("createdBy", "name email picture")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      QRCode.countDocuments(query),
      req.isStaff ? null : QRCode.countDocuments(accountActive),
      req.isStaff ? null : QRCode.countDocuments({ ...accountActive, planPaused: true }),
    ]);

    const result = {
      qrCodes,
      total,
      // Whole-account counts (owners only), independent of page / member filter.
      accountTotal,
      accountPaused,
      qrStop: req.isStaff ? null : planGraceInfo(req.account),
      pagination: {
        total,
        page,
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
    if (!mongoose.isValidObjectId(qrId)) return res.status(404).json({ message: "QR code not found." });
    const cacheKey = `qr:detail:${userId}:${qrId}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const qr = await QRCode.findOne({ _id: qrId, ...qrScope(req) });
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
      isActive,
      // qrConfig fields
      color, shape, logoData,
      // standeeConfig fields
      template, bgColor, socialProof, language, whiteLabel,
    } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "QR code not found." });
    }
    const qr = await QRCode.findOne({ _id: req.params.id, ...qrScope(req) });
    if (!qr) return res.status(404).json({ success: false, message: "QR code not found." });

    const plan = req.account.plan;

    // ── Label (any plan) ───────────────────────────────────────────────────────
    if (label !== undefined) qr.label = label;
    if (isActive !== undefined) qr.isActive = isActive;

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

        const fileName = `logos_${qr.owner}_${qr.placeId}`;
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

    await Promise.all([
      invalidateQrCaches(req, { qrId: qr._id, createdBy: qr.createdBy }),
      delCache(`qr:scan:${qr.shortCode}`),
      delCache(`qr:landing:${qr.shortCode}`),
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "QR code not found." });
    const qr = await QRCode.findOne({ _id: req.params.id, ...qrScope(req) });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    qr.status = "archived";
    await qr.save();

    await invalidateQrCaches(req, { qrId: qr._id, createdBy: qr.createdBy });

    res.json({ message: "QR code archived." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Download QR ──────────────────────────────────────────────────────────────
// GET /api/qr/:id/download?format=svg
export const downloadQRCode = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "QR code not found." });
    const qr = await QRCode.findOne({ _id: req.params.id, ...qrScope(req) });
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const requestedFormat = req.query.format || qr.format;
    const plan = req.account.plan;

    if (requestedFormat !== "png" && plan === "free") {
      return res.status(403).json({ message: "SVG/PDF download requires a paid plan." });
    }

    const stopBlock = req.isStaff ? null : qrStopBlock(req.account, qr);
    if (stopBlock) return res.status(403).json(stopBlock);

    // Printed QRs must always hit /r/ so scanRedirect can choose the destination
    // by the owner's current plan (upgrades/downgrades apply to already-printed QRs).
    const encodeUrl = `${process.env.BACKEND_URL || process.env.FRONTEND_URL}/r/${qr.shortCode}`;

    let fileBuffer, mimeType, ext;
    if (requestedFormat === "svg") {
      fileBuffer = await generateQRSvg(encodeUrl, qr.customColor);
      mimeType = "image/svg+xml";
      ext = "svg";
    } else if (requestedFormat === "pdf") {
      const pngBuf = await generateQRPng(encodeUrl, qr.customColor, null, qr.hasWatermark);
      fileBuffer = await generateQRPdf(encodeUrl, qr.businessName, pngBuf);
      mimeType = "application/pdf";
      ext = "pdf";
    } else {
      fileBuffer = await generateQRPng(encodeUrl, qr.customColor, null, qr.hasWatermark);
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
// GET /r/:shortCode  — no auth, logs scan and 302 → Google review URL or landing page
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

    if (qr.isActive === false) {
      const owner = await User.findById(qr.owner).select("name").lean();
      const ownerName = escapeHtml(owner ? owner.name : "the owner");
      return res.status(403).send(`
        <html>
          <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body style="font-family: sans-serif; text-align: center; padding: 2rem; background: #f9f9f9;">
            <div style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px; margin: 2rem auto;">
              <h2 style="color: #d32f2f; margin-top: 0;">QR Code Inactive</h2>
              <p style="color: #555; line-height: 1.5;">This QR code has been stopped by <strong>${ownerName}</strong>.</p>
              <p style="color: #555; line-height: 1.5;">Please contact them to restart it.</p>
            </div>
          </body>
        </html>
      `);
    }

    const owner = await User.findById(qr.owner).select(STOP_FIELDS).lean();
    const stopped = isQrPaused(qr, owner);
    if (owner && stopped !== Boolean(qr.planPaused)) {
      // Stop date passed or plan renewed since the last hourly sync: apply it now
      syncPlanPause(owner).catch((err) => console.error("Plan pause sync failed:", err.message));
    }
    if (stopped) return res.status(503).send(pausedQrPage(qr.businessName));

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

    // ── Smart redirect: active paid plan → landing page, else → Google Review ──
    if (hasActivePaidPlan(owner)) {
      // Redirect to branded landing page with AI review suggestions
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      return res.redirect(302, `${frontendUrl}/review/${shortCode}`);
    }

    // Free or expired plan → direct Google review redirect
    res.redirect(302, qr.reviewUrl);
  } catch (err) {
    console.error("Scan redirect error:", err.message);
    res.redirect(302, "https://google.com");
  }
};

// ─── Landing page data (public, no auth) ──────────────────────────────────────
// GET /api/qr/landing/:shortCode
export const getLandingData = async (req, res) => {
  try {
    const { shortCode } = req.params;

    const cacheKey = `qr:landing:${shortCode}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const qr = await QRCode.findOne({ shortCode, status: "active" }).lean();
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const owner = await User.findById(qr.owner)
      .select(`${STOP_FIELDS} businessName businessType`)
      .lean();
    if (!isQrServing(qr, owner)) return res.status(404).json({ message: "QR code not found." });

    const result = {
      success: true,
      businessName: qr.businessName,
      logoUrl: qr.qrConfig?.logoUrl || "",
      placeRating: qr.placeRating,
      totalReviews: qr.totalReviews,
      reviewUrl: qr.reviewUrl,
      placeAddress: qr.placeAddress,
      aiEnabled: hasActivePaidPlan(owner),
      questions: profileEnabled(owner, qr.reviewProfile) ? buildQuestions(qr.reviewProfile) : null,
    };

    // Cache for 5 minutes
    await setCache(cacheKey, result, 300);

    res.json(result);
  } catch (err) {
    console.error("Landing data error:", err.message);
    res.status(500).json({ message: "Failed to load landing data." });
  }
};

// ─── AI review generation (public, rate-limited) ──────────────────────────────
// POST /api/qr/ai-reviews  body: { shortCode, answers?: { services, liked, staff, language } }
export const generateAIReviews = async (req, res) => {
  try {
    const { shortCode, answers } = req.body;
    if (!shortCode || typeof shortCode !== "string") {
      return res.status(400).json({ message: "shortCode is required." });
    }

    const qr = await QRCode.findOne({ shortCode, status: "active" }).lean();
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    // Verify QR owner has active paid plan
    const owner = await User.findById(qr.owner)
      .select(`${STOP_FIELDS} businessType`)
      .lean();
    if (!isQrServing(qr, owner)) return res.status(404).json({ message: "QR code not found." });

    if (!hasActivePaidPlan(owner)) {
      return res.status(403).json({
        message: "AI review suggestions are not available for this business.",
      });
    }

    if (!profileEnabled(owner, qr.reviewProfile)) {
      const reviews = await generateReviewSuggestions({
        businessName: qr.businessName,
        businessType: owner.businessType || "",
        rating: qr.placeRating,
      });
      return res.json({ success: true, reviews, personalised: false });
    }

    const recentKey = `ai:recent:${qr._id}`;
    const cachedRecent = await getCache(recentKey);
    const recent = Array.isArray(cachedRecent) ? cachedRecent : [];
    const reviews = await generatePersonalisedReviews({
      businessName: qr.businessName,
      businessType: owner.businessType || "",
      profile: qr.reviewProfile,
      answers: validateAnswers(qr.reviewProfile, answers && typeof answers === "object" ? answers : {}),
      recent: recent.slice(0, 6),
    });
    await setCache(recentKey, [...reviews, ...recent].slice(0, RECENT_REVIEWS_KEPT), 7 * 24 * 3600);

    res.json({ success: true, reviews, personalised: true });
  } catch (err) {
    console.error("AI review generation error:", err.message);
    res.status(500).json({ message: "Failed to generate review suggestions." });
  }
};

// ─── AI review profile (owner, Pro/Agency) ────────────────────────────────────
const profileGate = (req, res) => {
  if (canUseFeature(req.account?.plan, "aiProfile") && hasActivePaidPlan(req.account)) return true;
  res.status(403).json({
    code: "plan_required",
    message: "Personalised AI reviews are available on the Pro and Agency plans.",
  });
  return false;
};

const findScopedQr = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: "QR code not found." });
    return null;
  }
  const qr = await QRCode.findOne({ _id: req.params.id, ...qrScope(req) });
  if (!qr) res.status(404).json({ message: "QR code not found." });
  return qr;
};

const profilePayload = (qr) => ({
  success: true,
  qr: { _id: qr._id, businessName: qr.businessName, placeAddress: qr.placeAddress, shortCode: qr.shortCode },
  profile: sanitizeProfile(qr.reviewProfile || {}),
  updatedAt: qr.reviewProfile?.updatedAt || null,
  limits: PROFILE_LIMITS,
  defaultLiked: DEFAULT_LIKED,
});

// GET /api/qr/:id/review-profile
export const getReviewProfile = async (req, res) => {
  try {
    const qr = await findScopedQr(req, res);
    if (!qr) return;
    res.json({ ...profilePayload(qr), allowed: canUseFeature(req.account?.plan, "aiProfile") });
  } catch (err) {
    console.error("Get review profile error:", err.message);
    res.status(500).json({ message: "Failed to load AI review profile." });
  }
};

// PUT /api/qr/:id/review-profile
export const updateReviewProfile = async (req, res) => {
  try {
    if (!profileGate(req, res)) return;
    const qr = await findScopedQr(req, res);
    if (!qr) return;

    qr.reviewProfile = { ...sanitizeProfile(req.body || {}), updatedAt: new Date() };
    await qr.save();
    await Promise.all([
      delCache(`qr:landing:${qr.shortCode}`),
      delCache(`ai:recent:${qr._id}`),
    ]);

    res.json({ ...profilePayload(qr), allowed: true, message: "AI review profile saved." });
  } catch (err) {
    console.error("Update review profile error:", err.message);
    res.status(500).json({ message: "Failed to save AI review profile." });
  }
};

// POST /api/qr/:id/review-profile/autofill — AI draft from Google data; not saved
export const autofillReviewProfile = async (req, res) => {
  try {
    if (!profileGate(req, res)) return;
    const qr = await findScopedQr(req, res);
    if (!qr) return;

    let details = null;
    if (qr.placeId) {
      try {
        details = await getPlaceDetails(qr.placeId);
      } catch (err) {
        console.error("Autofill place details failed:", err.message);
      }
    }

    const reviews = (details?.reviews?.length ? details.reviews : qr.latestReviews || [])
      .filter((r) => (r.rating || 0) >= 4)
      .map((r) => r.text);

    const draft = await draftReviewProfile({
      businessName: qr.businessName,
      address: details?.address || qr.placeAddress || "",
      website: details?.website || "",
      reviews,
    });

    const profile = sanitizeProfile({ ...draft, staff: qr.reviewProfile?.staff || [], tone: qr.reviewProfile?.tone, languages: qr.reviewProfile?.languages });
    res.json({ success: true, profile });
  } catch (err) {
    console.error("Autofill review profile error:", err.message);
    res.status(502).json({ message: "Couldn't draft a profile right now. Please fill it in manually." });
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

    if (!mongoose.isValidObjectId(qrId)) return res.status(404).json({ message: "QR code not found." });
    const qr = await QRCode.findOne({ _id: qrId, ...qrScope(req) });
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

