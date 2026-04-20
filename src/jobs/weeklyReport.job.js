import cron from "node-cron";
import User from "../models/User.js";
import QRCode from "../models/QRCode.js";
import ScanLog from "../models/ScanLog.js";
import { sendWeeklyReportEmail } from "../services/email.service.js";

async function sendWeeklyReports() {
  console.log("📊 Starting weekly report job...");

  try {
    // Get all Pro + Agency users
    const users = await User.find({
      plan: { $in: ["pro", "agency"] },
      planExpiresAt: { $gt: new Date() },
      weeklyReportEnabled: { $ne: false },
      status: "active",
    }).select("_id name email");

    const thisWeekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    for (const user of users) {
      try {
        const qrCodes = await QRCode.find({ owner: user._id, status: "active" }).select("_id businessName");
        const qrIds = qrCodes.map((q) => q._id);

        if (qrIds.length === 0) continue;

        const [thisWeekScans, lastWeekScans, topQrData] = await Promise.all([
          ScanLog.countDocuments({ qrCode: { $in: qrIds }, scannedAt: { $gte: thisWeekStart } }),
          ScanLog.countDocuments({
            qrCode: { $in: qrIds },
            scannedAt: { $gte: lastWeekStart, $lt: thisWeekStart },
          }),
          ScanLog.aggregate([
            { $match: { qrCode: { $in: qrIds }, scannedAt: { $gte: thisWeekStart } } },
            { $group: { _id: "$qrCode", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 1 },
          ]),
        ]);

        const changePercent =
          lastWeekScans === 0
            ? 100
            : Math.round(((thisWeekScans - lastWeekScans) / lastWeekScans) * 100);

        let topQr = null;
        if (topQrData.length > 0) {
          const qr = qrCodes.find((q) => q._id.toString() === topQrData[0]._id.toString());
          if (qr) topQr = { businessName: qr.businessName, count: topQrData[0].count };
        }

        await sendWeeklyReportEmail(user.email, {
          userName: user.name,
          totalScans: thisWeekScans,
          topQr,
          changePercent,
        });

        console.log(`✅ Weekly report sent to ${user.email}`);
      } catch (err) {
        console.error(`❌ Failed to send report to ${user.email}:`, err.message);
      }
    }

    console.log("📊 Weekly report job complete.");
  } catch (err) {
    console.error("Weekly report job error:", err.message);
  }
}

function startWeeklyReportJob() {
  // Every Monday at 9:00 AM
  cron.schedule("0 9 * * 1", sendWeeklyReports, {
    timezone: "Asia/Kolkata",
  });
  console.log("📅 Weekly report cron job scheduled (Mon 9:00 AM IST)");
}

export { startWeeklyReportJob, sendWeeklyReports };
