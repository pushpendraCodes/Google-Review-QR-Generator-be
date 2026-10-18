import "dotenv/config";
import app from "./src/app.js";
import connectDB from "./src/config/db.js";
import { startWeeklyReportJob } from "./src/jobs/weeklyReport.job.js";
import { startAnalyticsJob } from "./src/jobs/analytics.job.js";
import { startInactivityReminderJob } from "./src/jobs/inactivityReminder.job.js";
import { startPlanExpiryJob } from "./src/jobs/planExpiry.job.js";
import { startClientBillingBlockJob } from "./src/jobs/clientBillingBlock.job.js";
import { startPricingSync } from "./src/services/pricing.service.js";

const PORT = process.env.PORT || 5000;

connectDB().then(startPricingSync).then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`);
    startWeeklyReportJob();
    startAnalyticsJob();
    startInactivityReminderJob();
    startPlanExpiryJob();
    startClientBillingBlockJob();
  });
});
