import cron from "node-cron";
import User from "../models/User.js";
import { sendPlanExpiringEmail, sendPlanExpiredEmail } from "../services/email.service.js";

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
    }).select("_id name email plan planExpiresAt");

    console.log(`🔴 Found ${expiredUsers.length} users with expired plans.`);

    for (const user of expiredUsers) {
      try {
        // Send expired notification email
        if (user.emailNotifications !== false) {
          await sendPlanExpiredEmail(user.email, {
            userName: user.name,
            plan: user.plan,
          });
          console.log(`✅ Expiry notification sent to ${user.email}`);
        }

        // Downgrade to free plan
        user.planExpiredNotifSent = true;
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

function startPlanExpiryJob() {
  // Every day at 9:00 AM IST
  cron.schedule("0 9 * * *", checkPlanExpiries, {
    timezone: "Asia/Kolkata",
  });
  console.log("📅 Plan expiry cron job scheduled (Daily 9:00 AM IST)");
}

export { startPlanExpiryJob, checkPlanExpiries };
