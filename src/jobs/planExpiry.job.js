import cron from "node-cron";
import User from "../models/User.js";
import QRCode from "../models/QRCode.js";
import {
  sendPlanExpiringEmail,
  sendPlanExpiredEmail,
  sendQrsPausedEmail,
  sendQrsStoppingEmail,
} from "../services/email.service.js";
import {
  DAY_MS,
  FREE_TRIAL_DAYS,
  PLAN_GRACE_DAYS,
  QR_STOP_WARNING_DAYS,
  STOP_FIELDS,
  lapseStopDate,
  planGraceInfo,
  shouldStopQrs,
  syncPlanPause,
  trialStopDate,
} from "../services/planGrace.service.js";
import { hasActivePaidPlan } from "../utils/helpers.js";

/**
 * Plan Expiry Job
 *
 * 1. Sends a warning email 3 days before plan expires
 * 2. Sends an expired email after plan expires + downgrades to free
 *
 * Runs daily at 9:00 AM IST.
 */
async function checkPlanExpiries() {
  console.log("⏰ Starting plan expiry check job...");

  try {
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // ── 1. Plans expiring within 3 days (warning email) ──────────────────────
    const expiringUsers = await User.find({
      plan: { $ne: "free" },
      planExpiresAt: { $gt: now, $lte: threeDaysFromNow },
      planExpiryWarningSent: false,
      emailNotifications: { $ne: false },
      status: "active",
    }).select("_id name email plan planExpiresAt");

    console.log(`🔔 Found ${expiringUsers.length} users with plans expiring soon.`);

    for (const user of expiringUsers) {
      try {
        await sendPlanExpiringEmail(user.email, {
          userName: user.name,
          plan: user.plan,
          expiresAt: user.planExpiresAt,
          graceDays: PLAN_GRACE_DAYS,
        });
        user.planExpiryWarningSent = true;
        await user.save({ validateBeforeSave: false });
        console.log(`✅ Expiry warning sent to ${user.email}`);
      } catch (err) {
        console.error(`❌ Failed to send expiry warning to ${user.email}:`, err.message);
      }
    }

    // ── 2. Plans already expired (expired email + downgrade to free) ─────────
    const expiredUsers = await User.find({
      plan: { $ne: "free" },
      planExpiresAt: { $lt: now },
      planExpiredNotifSent: false,
      status: "active",
    }).select("_id name email plan planExpiresAt teamOwner emailNotifications");

    console.log(`🔴 Found ${expiredUsers.length} users with expired plans.`);

    for (const user of expiredUsers) {
      try {
        const lapsedAt = user.planExpiresAt;
        const activeQrs = user.teamOwner ? 0 : await QRCode.countDocuments({ owner: user._id, status: "active" });

        // Send expired notification email
        if (user.emailNotifications !== false) {
          await sendPlanExpiredEmail(user.email, {
            userName: user.name,
            plan: user.plan,
            pauseOn: lapseStopDate(lapsedAt),
            qrCount: activeQrs,
          });
          console.log(`✅ Expiry notification sent to ${user.email}`);
        }

        // Downgrade to free plan; every QR stops when the grace period ends
        user.planExpiredNotifSent = true;
        user.planLapsedAt = lapsedAt;
        user.freeQrStopAt = lapseStopDate(lapsedAt);
        user.qrStopWarningSent = false;
        user.qrPauseNotifSent = false;
        user.plan = "free";
        user.planExpiresAt = null;
        await user.save({ validateBeforeSave: false });
        console.log(`⬇️ Downgraded ${user.email} to free plan.`);
      } catch (err) {
        console.error(`❌ Failed to process expiry for ${user.email}:`, err.message);
      }
    }

    console.log("⏰ Plan expiry check job complete.");
  } catch (err) {
    console.error("Plan expiry job error:", err.message);
  }
}

const OWNER_JOB_FIELDS = `name email ${STOP_FIELDS} qrStopWarningSent qrPauseNotifSent`;
const pricingLink = () => `${process.env.FRONTEND_URL}/pricing`;
const stopDaysFor = (reason) => (reason === "lapsed" ? PLAN_GRACE_DAYS : FREE_TRIAL_DAYS);

/** Free accounts with QRs but no stop date yet (created before the Free period existed). */
async function startMissingFreePeriods() {
  const owners = await QRCode.distinct("owner", { status: "active" });
  const res = await User.updateMany(
    { _id: { $in: owners }, plan: "free", teamOwner: null, freeQrStopAt: null },
    { freeQrStopAt: trialStopDate(), qrStopWarningSent: false, qrPauseNotifSent: false },
  );
  if (res.modifiedCount) console.log(`🕒 Started the ${FREE_TRIAL_DAYS}-day Free period for ${res.modifiedCount} existing account(s).`);
}

/** Emails owners whose QRs stop within QR_STOP_WARNING_DAYS. */
async function sendStopWarnings(now) {
  const owners = await User.find({
    teamOwner: null,
    qrStopWarningSent: { $ne: true },
    freeQrStopAt: { $gt: now, $lte: new Date(now.getTime() + QR_STOP_WARNING_DAYS * DAY_MS) },
  }).select(OWNER_JOB_FIELDS);

  for (const owner of owners) {
    try {
      const info = planGraceInfo(owner);
      if (!info || info.pauseOn <= now) continue;
      const count = await QRCode.countDocuments({ owner: owner._id, status: "active" });
      if (!count) continue;

      await sendQrsStoppingEmail(owner.email, {
        userName: owner.name,
        count,
        stopOn: info.pauseOn,
        reason: info.reason,
        days: stopDaysFor(info.reason),
        link: pricingLink(),
      });
      owner.qrStopWarningSent = true;
      await owner.save({ validateBeforeSave: false });
      console.log(`📧 QR stop warning sent to ${owner.email}`);
    } catch (err) {
      console.error(`❌ QR stop warning to ${owner.email} failed:`, err.message);
    }
  }
}

/**
 * Starts the Free period for existing accounts, warns owners before their QRs stop,
 * pauses every QR once the Free period / plan grace ends (emailing once), and resumes
 * them after an upgrade or renewal. Runs hourly.
 */
async function checkPlanGrace() {
  try {
    const now = new Date();
    await startMissingFreePeriods();
    await sendStopWarnings(now);

    const pausedOwners = await QRCode.distinct("owner", { planPaused: true });
    const owners = await User.find({
      teamOwner: null,
      $or: [
        { freeQrStopAt: { $lte: now } },
        { planLapsedAt: { $ne: null } },
        { plan: { $ne: "free" }, planExpiresAt: { $lt: now } },
        { _id: { $in: pausedOwners } },
      ],
    }).select(OWNER_JOB_FIELDS);

    let newlyPausedOwners = 0;
    for (const owner of owners) {
      try {
        if (hasActivePaidPlan(owner) && (owner.planLapsedAt || owner.freeQrStopAt)) {
          owner.planLapsedAt = null;
          owner.freeQrStopAt = null;
          owner.qrPauseNotifSent = false;
          owner.qrStopWarningSent = false;
          await owner.save({ validateBeforeSave: false });
        }

        const reason = planGraceInfo(owner)?.reason;
        const { paused } = await syncPlanPause(owner);
        if (paused > 0 && !owner.qrPauseNotifSent && shouldStopQrs(owner)) {
          newlyPausedOwners++;
          owner.qrPauseNotifSent = true;
          await owner.save({ validateBeforeSave: false });
          await sendQrsPausedEmail(owner.email, {
            userName: owner.name,
            count: paused,
            reason,
            days: stopDaysFor(reason),
            link: pricingLink(),
          }).catch((err) => console.error(`❌ QR paused email to ${owner.email} failed:`, err.message));
        }
      } catch (err) {
        console.error(`❌ Plan grace check failed for ${owner._id}:`, err.message);
      }
    }
    if (newlyPausedOwners) console.log(`⏸️ Paused QR codes for ${newlyPausedOwners} account(s).`);
  } catch (err) {
    console.error("Plan grace job error:", err.message);
  }
}

function startPlanExpiryJob() {
  // Every day at 9:00 AM IST
  cron.schedule("0 9 * * *", checkPlanExpiries, {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("30 * * * *", checkPlanGrace, { timezone: "Asia/Kolkata" });
  console.log("📅 Plan expiry cron job scheduled (Daily 9:00 AM IST, QR stop check hourly)");
}

export { startPlanExpiryJob, checkPlanExpiries, checkPlanGrace };
