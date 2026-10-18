import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import GoogleBusinessConnection from "../../models/GoogleBusinessConnection.js";
import GbpReview from "../../models/GbpReview.js";
import { generateOwnerReplySuggestion } from "../../services/ai.service.js";
import {
  buildGbpAuthUrl,
  disconnectGbp,
  exchangeGbpCode,
  fetchAndStoreAccountsAndLocations,
  getConnectionForUser,
  GbpApiError,
  GbpAuthError,
  postReviewReply,
  saveConnectionTokens,
  syncReviewsForUser,
} from "../../services/googleBusiness.service.js";

function handleGbpError(res, err) {
  console.error("GBP error:", err.message, err.googleError || "");
  const status = err.statusCode || err.status || 500;
  return res.status(status).json({
    success: false,
    message: err.message || "Google Business Profile request failed.",
    reconnect: err.name === "GbpAuthError",
  });
}

function connectionPayload(connection) {
  if (!connection) {
    return { connected: false, locations: [], selectedLocationResourceName: "" };
  }
  return {
    connected: connection.status === "active",
    accountDisplayName: connection.googleAccountDisplayName,
    locations: connection.locations || [],
    selectedLocationResourceName: connection.selectedLocationResourceName || "",
    lastSyncAt: connection.lastSyncAt,
    connectedAt: connection.connectedAt,
    lastError: connection.lastError || "",
  };
}

// The OAuth state is only honoured in the browser that requested it (nonce cookie), so a
// connect link can't be handed to someone else to attach their Google account to ours.
const OAUTH_NONCE_COOKIE = "gbp_oauth_nonce";
const OAUTH_NONCE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/gbp",
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// GET /api/gbp/connect-url
export const getConnectUrl = async (req, res) => {
  try {
    const nonce = crypto.randomBytes(32).toString("hex");
    const state = jwt.sign(
      { id: req.user._id.toString(), purpose: "gbp", nonce: sha256(nonce) },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "15m" }
    );
    res.cookie(OAUTH_NONCE_COOKIE, nonce, { ...OAUTH_NONCE_COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });
    const url = buildGbpAuthUrl(state);
    res.json({ success: true, url });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// GET /api/gbp/callback?code=&state=
export const oauthCallback = async (req, res) => {
  const frontend =
    process.env.FRONTEND_URL || "http://localhost:3000";
  const fail = (msg) =>
    res.redirect(
      `${frontend}/dashboard/google-reviews?error=${encodeURIComponent(msg)}`
    );

  try {
    const { code, state, error } = req.query;
    if (error) return fail(String(error));
    if (!code || !state) return fail("Missing OAuth parameters.");

    let decoded;
    try {
      decoded = jwt.verify(state, process.env.ACCESS_TOKEN_SECRET);
    } catch {
      return fail("OAuth session expired. Please try connecting again.");
    }
    if (decoded.purpose !== "gbp") return fail("Invalid OAuth state.");

    const nonce = req.cookies?.[OAUTH_NONCE_COOKIE];
    res.clearCookie(OAUTH_NONCE_COOKIE, OAUTH_NONCE_COOKIE_OPTIONS);
    const expected = Buffer.from(String(decoded.nonce || ""));
    const actual = Buffer.from(nonce ? sha256(nonce) : "");
    if (!nonce || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return fail("Please start the connection from your ReviewQR dashboard in this browser.");
    }

    const tokens = await exchangeGbpCode(code);
    await saveConnectionTokens(decoded.id, tokens);

    try {
      await fetchAndStoreAccountsAndLocations(decoded.id);
    } catch (locErr) {
      console.error("GBP location fetch after OAuth:", locErr.message);
      // Keep the OAuth connection; show actionable error on the dashboard
      const connection = await getConnectionForUser(decoded.id);
      if (connection) {
        connection.lastError = locErr.message;
        await connection.save();
      }
      return res.redirect(
        `${frontend}/dashboard/google-reviews?connected=1&error=${encodeURIComponent(locErr.message)}`
      );
    }

    try {
      await syncReviewsForUser(decoded.id);
    } catch (syncErr) {
      console.warn("Initial GBP review sync:", syncErr.message);
    }

    res.redirect(`${frontend}/dashboard/google-reviews?connected=1`);
  } catch (err) {
    fail(err.message || "Connection failed");
  }
};

// GET /api/gbp/status
export const getStatus = async (req, res) => {
  try {
    const connection = await getConnectionForUser(req.user._id);
    res.json({ success: true, ...connectionPayload(connection) });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// POST /api/gbp/refresh-locations
export const refreshLocations = async (req, res) => {
  try {
    const connection = await fetchAndStoreAccountsAndLocations(req.user._id);
    res.json({
      success: true,
      message: connection.locations?.length
        ? `Loaded ${connection.locations.length} location(s).`
        : "Connected, but no locations found yet.",
      ...connectionPayload(connection),
    });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// POST /api/gbp/location
export const selectLocation = async (req, res) => {
  try {
    const { locationResourceName } = req.body;
    if (!locationResourceName) {
      return res.status(400).json({ success: false, message: "locationResourceName is required." });
    }

    const connection = await getConnectionForUser(req.user._id);
    if (!connection) {
      return res.status(400).json({ success: false, message: "Connect Google Business Profile first." });
    }

    const allowed = (connection.locations || []).some(
      (l) => l.locationResourceName === locationResourceName
    );
    if (!allowed) {
      return res.status(400).json({ success: false, message: "Location not found on your account." });
    }

    connection.selectedLocationResourceName = locationResourceName;
    await connection.save();

    res.json({ success: true, ...connectionPayload(connection) });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// POST /api/gbp/sync
export const syncReviews = async (req, res) => {
  try {
    const result = await syncReviewsForUser(req.user._id);
    res.json({ success: true, message: "Reviews synced from Google.", ...result });
  } catch (err) {
    if (err instanceof GbpAuthError || err instanceof GbpApiError) {
      const connection = await getConnectionForUser(req.user._id);
      if (connection) {
        connection.lastError = err.message;
        if (err instanceof GbpAuthError) connection.status = "error";
        await connection.save();
      }
    }
    handleGbpError(res, err);
  }
};

// GET /api/gbp/reviews?stars=5&replyStatus=unreplied&page=1&limit=20
export const listReviews = async (req, res) => {
  try {
    const connection = await getConnectionForUser(req.user._id);
    if (!connection?.selectedLocationResourceName) {
      return res.json({
        success: true,
        connected: !!connection,
        reviews: [],
        total: 0,
        stats: { averageRating: 0, totalReviewCount: 0 },
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {
      owner: req.user._id,
      locationResourceName: connection.selectedLocationResourceName,
    };

    if (req.query.stars) {
      const stars = String(req.query.stars)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => n >= 1 && n <= 5);
      if (stars.length) filter.starRating = { $in: stars };
    }

    if (req.query.replyStatus === "replied" || req.query.replyStatus === "unreplied") {
      filter.replyStatus = req.query.replyStatus;
    }

    const baseFilter = {
      owner: req.user._id,
      locationResourceName: connection.selectedLocationResourceName,
    };

    const [reviews, total, repliedCount, unrepliedCount] = await Promise.all([
      GbpReview.find(filter).sort({ createTime: -1 }).skip(skip).limit(limit).lean(),
      GbpReview.countDocuments(filter),
      GbpReview.countDocuments({ ...baseFilter, replyStatus: "replied" }),
      GbpReview.countDocuments({ ...baseFilter, replyStatus: "unreplied" }),
    ]);

    const agg = await GbpReview.aggregate([
      { $match: { owner: req.user._id, locationResourceName: connection.selectedLocationResourceName } },
      {
        $group: {
          _id: null,
          avg: { $avg: "$starRating" },
          count: { $sum: 1 },
        },
      },
    ]);

    res.json({
      success: true,
      connected: true,
      reviews,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      stats: {
        averageRating: agg[0]?.avg ? Number(agg[0].avg.toFixed(2)) : 0,
        totalReviewCount: agg[0]?.count || 0,
        repliedCount,
        unrepliedCount,
      },
      lastSyncAt: connection.lastSyncAt,
      ...connectionPayload(connection),
    });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// POST /api/gbp/reviews/:reviewId/reply
export const replyToReview = async (req, res) => {
  try {
    const { comment } = req.body;
    if (!comment?.trim()) {
      return res.status(400).json({ success: false, message: "Reply comment is required." });
    }

    const review = await GbpReview.findOne({
      owner: req.user._id,
      googleReviewId: req.params.reviewId,
    });
    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found. Sync reviews first." });
    }

    const data = await postReviewReply(req.user._id, review.reviewResourceName, comment);
    res.json({ success: true, message: "Reply posted to Google.", reply: data });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// POST /api/gbp/reviews/:reviewId/ai-reply
export const generateAiReply = async (req, res) => {
  try {
    const review = await GbpReview.findOne({
      owner: req.user._id,
      googleReviewId: req.params.reviewId,
    });
    if (!review) {
      return res.status(404).json({ success: false, message: "Review not found." });
    }

    const connection = await getConnectionForUser(req.user._id);
    const location = connection?.locations?.find(
      (l) => l.locationResourceName === review.locationResourceName
    );
    const businessName =
      location?.title || req.user.businessName || req.user.name || "our business";

    const suggestion = await generateOwnerReplySuggestion({
      businessName,
      reviewerName: review.reviewerDisplayName,
      starRating: review.starRating,
      reviewText: review.comment,
    });

    res.json({ success: true, suggestion });
  } catch (err) {
    handleGbpError(res, err);
  }
};

// DELETE /api/gbp/disconnect
export const disconnect = async (req, res) => {
  try {
    await disconnectGbp(req.user._id);
    res.json({ success: true, message: "Google Business Profile disconnected." });
  } catch (err) {
    handleGbpError(res, err);
  }
};
