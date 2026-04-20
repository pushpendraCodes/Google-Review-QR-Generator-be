import cron from "node-cron";
import User from "../models/User.js";
import QRCode from "../models/QRCode.js";
import { sendInactivityReminderEmail } from "../services/email.service.js";

async function sendInactivityReminders() {
  console.log("⏰ Starting inactivity reminder job...");

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find users who signed up > 24h ago and haven't received a reminder
    const users = await User.find({
      createdAt: { $lt: twentyFourHoursAgo },
      inactivityReminderSent: false,
      emailNotifications: { $ne: false },
      status: "active",
    }).select("_id name email");

    console.log(`🔍 Found ${users.length} potential users for inactivity reminder.`);

    for (const user of users) {
      try {
        // Check if user has any active QR codes
        const qrCount = await QRCode.countDocuments({ owner: user._id, status: "active" });

        if (qrCount === 0) {
          await sendInactivityReminderEmail(user.email, user.name);
          console.log(`✅ Inactivity reminder sent to ${user.email}`);
        }

        // Mark as sent regardless (either we sent it or they already have a QR)
        user.inactivityReminderSent = true;
        await user.save({ validateBeforeSave: false });
      } catch (err) {
        console.error(`❌ Failed to process inactivity reminder for ${user.email}:`, err.message);
      }
    }

    console.log("⏰ Inactivity reminder job complete.");
  } catch (err) {
    console.error("Inactivity reminder job error:", err.message);
  }
}

function startInactivityReminderJob() {
  // Every day at 10:00 AM IST
  cron.schedule("0 10 * * *", sendInactivityReminders, {
    timezone: "Asia/Kolkata",
  });
  console.log("📅 Inactivity reminder cron job scheduled (Daily 10:00 AM IST)");
}

export { startInactivityReminderJob, sendInactivityReminders };
