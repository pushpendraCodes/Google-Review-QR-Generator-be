import mongoose from "mongoose";
import User from "../models/User.js";
import QRCode from "../models/QRCode.js";
import { QR_LIMITS, hasActivePaidPlan } from "../utils/helpers.js";
import { delCache, invalidatePattern } from "../utils/cache.js";

const DAY_MS = 86400000;
/** Days after a paid plan lapses before QRs over the Free limit stop working. */
export const PLAN_GRACE_DAYS = Math.max(0, Number(process.env.PLAN_GRACE_DAYS) || 15);
export const FREE_QR_LIMIT = QR_LIMITS.free;

/** When the paid plan ran out, or null while a paid plan is active / was never bought. */
export const planLapsedAt = (user) => {
  if (!user || hasActivePaidPlan(user)) return null;
  if (user.planLapsedAt) return new Date(user.planLapsedAt);
  if (user.plan !== "free" && user.planExpiresAt) return new Date(user.planExpiresAt);
  return null;
};

export const qrPauseDate = (user) => {
  const lapsed = planLapsedAt(user);
  return lapsed ? new Date(lapsed.getTime() + PLAN_GRACE_DAYS * DAY_MS) : null;
};

export const shouldPauseExtraQrs = (user, now = Date.now()) => {
  const pauseOn = qrPauseDate(user);
  return Boolean(pauseOn && pauseOn.getTime() <= now);
};

/** Grace info for the dashboard (owners only). */
export const planGraceInfo = (user) => {
  const lapsedAt = planLapsedAt(user);
  if (!lapsedAt) return null;
  return { lapsedAt, pauseOn: qrPauseDate(user), graceDays: PLAN_GRACE_DAYS, freeQrLimit: FREE_QR_LIMIT };
};

const clearQrCaches = async (owner, qrs) => {
  const viewers = new Set([String(owner._id), ...qrs.map((q) => String(q.createdBy || owner._id))]);
  await Promise.all([
    ...qrs.flatMap((q) => [delCache(`qr:scan:${q.shortCode}`), delCache(`qr:landing:${q.shortCode}`)]),
    ...[...viewers].map((id) => invalidatePattern(`qr:list:${id}:*`)),
  ]);
};

/**
 * Pauses the account's active QRs over the Free limit once the grace period is over,
 * keeping the most-scanned ones working. Un-pauses everything when no longer due
 * (renewed, or back under the limit). Returns { paused, newlyPaused }.
 */
export const syncPlanPause = async (ownerOrId) => {
  const isId = !ownerOrId || typeof ownerOrId === "string" || ownerOrId instanceof mongoose.Types.ObjectId;
  const owner = isId
    ? await User.findById(ownerOrId).select("plan planExpiresAt planLapsedAt teamOwner").lean()
    : ownerOrId;
  if (!owner || owner.teamOwner) return { paused: 0, newlyPaused: 0 };

  const qrs = await QRCode.find({ owner: owner._id, status: "active" })
    .select("_id shortCode scanCount createdAt createdBy planPaused")
    .sort({ scanCount: -1, createdAt: 1 })
    .lean();

  const pause = shouldPauseExtraQrs(owner);
  const toPause = pause ? qrs.slice(FREE_QR_LIMIT).filter((q) => !q.planPaused) : [];
  const toResume = qrs.filter((q, i) => q.planPaused && (!pause || i < FREE_QR_LIMIT));

  if (toPause.length) await QRCode.updateMany({ _id: { $in: toPause.map((q) => q._id) } }, { planPaused: true });
  if (toResume.length) await QRCode.updateMany({ _id: { $in: toResume.map((q) => q._id) } }, { planPaused: false });
  if (toPause.length || toResume.length) await clearQrCaches(owner, [...toPause, ...toResume]);

  const paused = qrs.filter((q) => q.planPaused).length + toPause.length - toResume.length;
  return { paused, newlyPaused: toPause.length };
};
