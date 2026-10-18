import cron from "node-cron";
import User from "../models/User.js";
import QRCode from "../models/QRCode.js";
import { sendPlanExpiringEmail, sendPlanExpiredEmail, sendQrsPausedEmail } from "../services/email.service.js";
import { FREE_QR_LIMIT, PLAN_GRACE_DAYS, syncPlanPause } from "../services/planGrace.service.js";
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
            pauseOn: new Date(new Date(lapsedAt).getTime() + PLAN_GRACE_DAYS * 86400000),
            extraQrs: Math.max(0, activeQrs - FREE_QR_LIMIT),
          });
          console.log(`✅ Expiry notification sent to ${user.email}`);
        }

        // Downgrade to free plan (keep when it lapsed for the QR grace period)
        user.planExpiredNotifSent = true;
        user.planLapsedAt = lapsedAt;
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

/**
 * Pauses QRs over the Free limit once a lapsed plan's grace period ends, emails the
 * owner once, and resumes them after renewal. Runs hourly.
 */
async function checkPlanGrace() {
  try {
    const now = new Date();
    const pausedOwners = await QRCode.distinct("owner", { planPaused: true });
    const owners = await User.find({
      teamOwner: null,
      $or: [
        { planLapsedAt: { $ne: null } },
        { plan: { $ne: "free" }, planExpiresAt: { $lt: now } },
        { _id: { $in: pausedOwners } },
      ],
    }).select("name email plan planExpiresAt planLapsedAt qrPauseNotifSent emailNotifications teamOwner");

    let newlyPausedOwners = 0;
    for (const owner of owners) {
      try {
        if (hasActivePaidPlan(owner) && owner.planLapsedAt) {
          owner.planLapsedAt = null;
          owner.qrPauseNotifSent = false;
          await owner.save({ validateBeforeSave: false });
        }

        const { newlyPaused, paused } = await syncPlanPause(owner);
        if (newlyPaused > 0 && !owner.qrPauseNotifSent) {
          newlyPausedOwners++;
          owner.qrPauseNotifSent = true;
          await owner.save({ validateBeforeSave: false });
          await sendQrsPausedEmail(owner.email, {
            userName: owner.name,
            count: paused,
            link: `${process.env.FRONTEND_URL}/pricing`,
          }).catch((err) => console.error(`❌ QR paused email to ${owner.email} failed:`, err.message));
        }
      } catch (err) {
        console.error(`❌ Plan grace check failed for ${owner._id}:`, err.message);
      }
    }
    if (newlyPausedOwners) console.log(`⏸️ Paused extra QR codes for ${newlyPausedOwners} lapsed account(s).`);
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
  console.log("📅 Plan expiry cron job scheduled (Daily 9:00 AM IST, QR grace check hourly)");
}

export { startPlanExpiryJob, checkPlanExpiries, checkPlanGrace };
