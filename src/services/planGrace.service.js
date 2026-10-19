import mongoose from "mongoose";
import User from "../models/User.js";
import QRCode from "../models/QRCode.js";
import { hasActivePaidPlan } from "../utils/helpers.js";
import { delCache, invalidatePattern } from "../utils/cache.js";

export const DAY_MS = 86400000;
/** Days after a paid plan lapses before the account's QRs stop working. */
export const PLAN_GRACE_DAYS = Math.max(0, Number(process.env.PLAN_GRACE_DAYS) || 15);
/** Days a Free account's QRs work, counted from its first QR. */
export const FREE_TRIAL_DAYS = Math.max(1, Number(process.env.FREE_TRIAL_DAYS) || 15);
/** Days before the stop date that the warning email goes out. */
export const QR_STOP_WARNING_DAYS = 3;

export const STOP_FIELDS = "plan planExpiresAt planLapsedAt freeQrStopAt teamOwner";

/** When the paid plan ran out, or null while a paid plan is active / was never bought. */
export const planLapsedAt = (user) => {
  if (!user || hasActivePaidPlan(user)) return null;
  if (user.planLapsedAt) return new Date(user.planLapsedAt);
  if (user.plan !== "free" && user.planExpiresAt) return new Date(user.planExpiresAt);
  return null;
};

/** Stop date for a plan that lapsed at `lapsedAt`. */
export const lapseStopDate = (lapsedAt) => new Date(new Date(lapsedAt).getTime() + PLAN_GRACE_DAYS * DAY_MS);

/** Stop date for a Free period starting at `from`. */
export const trialStopDate = (from = new Date()) => new Date(new Date(from).getTime() + FREE_TRIAL_DAYS * DAY_MS);

/**
 * When every QR in the account stops working, or null while on an active paid plan
 * (or before a Free account has created its first QR).
 */
export const qrStopDate = (user) => {
  if (!user || user.teamOwner || hasActivePaidPlan(user)) return null;
  // Expired but not yet downgraded by the daily job
  if (user.plan !== "free" && user.planExpiresAt) return lapseStopDate(user.planExpiresAt);
  return user.freeQrStopAt ? new Date(user.freeQrStopAt) : null;
};

export const shouldStopQrs = (user, now = Date.now()) => {
  const stopOn = qrStopDate(user);
  return Boolean(stopOn && stopOn.getTime() <= now);
};

/** A paused QR only comes back with a paid plan, even if the account's stop date moves later. */
export const isQrPaused = (qr, owner) => {
  if (!owner) return Boolean(qr.planPaused);
  if (owner.teamOwner) return false;
  return shouldStopQrs(owner) || (Boolean(qr.planPaused) && !hasActivePaidPlan(owner));
};

/**
 * Why new QR downloads are refused for this account, or null when allowed: the Free period
 * or plan grace is over, or `qr` itself is paused and the account isn't on a paid plan.
 */
export const qrStopBlock = (account, qr = null) => {
  if (!account || account.teamOwner) return null;
  const stopped = shouldStopQrs(account) || (Boolean(qr?.planPaused) && !hasActivePaidPlan(account));
  if (!stopped) return null;
  const reason = planLapsedAt(account) ? "lapsed" : "trial";
  return {
    code: "qr_stopped",
    reason,
    upgrade: true,
    message:
      reason === "lapsed"
        ? "Your plan has expired and your QR codes are paused. Renew to download QR codes and bring them back instantly."
        : `Your ${FREE_TRIAL_DAYS}-day free period has ended and your QR code is paused. Upgrade to download QR codes and bring it back instantly.`,
  };
};

/** Stop info for the dashboard (owners only). */
export const planGraceInfo = (user) => {
  const stopOn = qrStopDate(user);
  if (!stopOn) return null;
  const lapsedAt = planLapsedAt(user);
  return {
    reason: lapsedAt ? "lapsed" : "trial",
    lapsedAt,
    pauseOn: stopOn,
    graceDays: PLAN_GRACE_DAYS,
    trialDays: FREE_TRIAL_DAYS,
  };
};

const clearQrCaches = async (owner, qrs) => {
  const viewers = new Set([String(owner._id), ...qrs.map((q) => String(q.createdBy || owner._id))]);
  await Promise.all([
    ...qrs.flatMap((q) => [delCache(`qr:scan:${q.shortCode}`), delCache(`qr:landing:${q.shortCode}`)]),
    ...[...viewers].map((id) => invalidatePattern(`qr:list:${id}:*`)),
  ]);
};

/**
 * Pauses every active QR in the account once its stop date has passed, and un-pauses
 * them all on an active paid plan. Returns { paused, newlyPaused }.
 */
export const syncPlanPause = async (ownerOrId) => {
  const isId = !ownerOrId || typeof ownerOrId === "string" || ownerOrId instanceof mongoose.Types.ObjectId;
  const owner = isId ? await User.findById(ownerOrId).select(STOP_FIELDS).lean() : ownerOrId;
  if (!owner || owner.teamOwner) return { paused: 0, newlyPaused: 0 };

  const qrs = await QRCode.find({ owner: owner._id, status: "active" })
    .select("_id shortCode createdBy planPaused")
    .lean();

  const stop = shouldStopQrs(owner);
  const toPause = stop ? qrs.filter((q) => !q.planPaused) : [];
  const toResume = hasActivePaidPlan(owner) ? qrs.filter((q) => q.planPaused) : [];

  if (toPause.length) await QRCode.updateMany({ _id: { $in: toPause.map((q) => q._id) } }, { planPaused: true });
  if (toResume.length) await QRCode.updateMany({ _id: { $in: toResume.map((q) => q._id) } }, { planPaused: false });
  if (toPause.length || toResume.length) await clearQrCaches(owner, [...toPause, ...toResume]);

  const paused = stop ? qrs.length : qrs.filter((q) => q.planPaused).length - toResume.length;
  return { paused, newlyPaused: toPause.length };
};

/** Starts the Free period on an account's first QR. No-op on paid plans or once started. */
export const startFreeTrialIfNeeded = async (account) => {
  if (!account || account.teamOwner || hasActivePaidPlan(account) || account.freeQrStopAt) return;
  if (account.plan !== "free" && account.planExpiresAt) return;
  await User.updateOne(
    { _id: account._id, freeQrStopAt: null },
    { freeQrStopAt: trialStopDate(), qrStopWarningSent: false, qrPauseNotifSent: false },
  );
};
