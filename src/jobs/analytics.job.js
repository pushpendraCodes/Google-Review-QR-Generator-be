import cron from "node-cron";
import QRCode from "../models/QRCode.js";
import ScanLog from "../models/ScanLog.js";
import DailyMetric from "../models/DailyMetric.js";
import { refreshQrFromGoogle } from "../services/googleSync.service.js";

async function snapshotAnalytics() {
  console.log("📈 Starting daily analytics snapshot...");

  try {
    const activeQRs = await QRCode.find({ status: "active" });
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    for (const qr of activeQRs) {
      try {
        // 1. Fetch latest details from Google and save them on the QR
        const details = await refreshQrFromGoogle(qr);

        // 2. Aggregate scans for the previous day
        const scanCount = await ScanLog.countDocuments({
          qrCode: qr._id,
          scannedAt: { $gte: yesterday, $lt: today }
        });

        // 3. Aggregate city/device breakdown for the previous day
        const stats = await ScanLog.aggregate([
          { $match: { qrCode: qr._id, scannedAt: { $gte: yesterday, $lt: today } } },
          {
            $facet: {
              cities: [
                { $group: { _id: "$city", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
              ],
              devices: [
                {
                  $group: {
                    _id: {
                      $cond: [
                        { $regexMatch: { input: "$userAgent", regex: /mobile/i } }, "mobile",
                        { $cond: [{ $regexMatch: { input: "$userAgent", regex: /tablet/i } }, "tablet", "desktop"] }
                      ]
                    },
                    count: { $sum: 1 }
                  }
                }
              ]
            }
          }
        ]);

        const cityData = stats[0].cities.map(c => ({ name: c._id || "Unknown", count: c.count }));
        const deviceData = { mobile: 0, desktop: 0, tablet: 0 };
        stats[0].devices.forEach(d => {
          if (d._id) deviceData[d._id] = d.count;
        });

        // 4. Update DailyMetric (Upsert for the current day)
        await DailyMetric.findOneAndUpdate(
          { qrCode: qr._id, date: today },
          {
            $set: {
              scans: scanCount,
              totalReviewsGrowth: details.totalReviews,
              avgRatingGrowth: details.rating,
              cities: cityData,
              devices: deviceData
            }
          },
          { upsert: true }
        );

        console.log(`✅ Snapshot complete for: ${qr.businessName}`);
      } catch (err) {
        console.error(`❌ Failed snapshot for QR ${qr._id}:`, err.message);
      }
    }

    console.log("📈 Daily analytics snapshot complete.");
  } catch (err) {
    console.error("Critical error in analytics job:", err.message);
  }
}

function startAnalyticsJob() {
  // Runs daily at midnight (00:00)
  cron.schedule("0 0 * * *", snapshotAnalytics, {
    timezone: "Asia/Kolkata",
  });
  console.log("📅 Analytics snapshot scheduled for 00:00 IST daily");
}

export { startAnalyticsJob, snapshotAnalytics };
