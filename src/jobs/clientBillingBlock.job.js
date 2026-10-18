import cron from "node-cron";
import ClientAccount from "../models/ClientAccount.js";
import QRCode from "../models/QRCode.js";
import { resolveClientAgency } from "../services/clientAuth.service.js";
import { BLOCK_AFTER_DAYS, billingBlock, formatMoney } from "../services/clientBilling.service.js";
import { sendAgencyClientBlockedEmail, sendClientBlockedEmail } from "../services/email.service.js";
import { appUrl } from "../services/agencyNotify.service.js";
import { delCache } from "../utils/cache.js";

/**
 * Client overdue-payment block.
 *
 * The block itself is checked live on every client-portal request; this job only
 * sends the "blocked" emails once (to the client and the agency owner) and resets
 * the flag after the client is no longer overdue, so a later miss emails again.
 *
 * Runs hourly.
 */
async function checkClientBillingBlocks() {
  console.log("⏰ Starting client billing block check...");
  try {
    const cutoff = new Date(Date.now() - BLOCK_AFTER_DAYS * 86400000);
    const overdueQrIds = await QRCode.distinct("_id", {
      status: "active",
      "agencyBilling.price": { $gt: 0 },
      "agencyBilling.nextPaymentDate": { $ne: null, $lte: cutoff },
    });

    const clients = await ClientAccount.find({
      $or: [{ qrCodes: { $in: overdueQrIds }, billingBlockedAt: null }, { billingBlockedAt: { $ne: null } }],
    });

    let emailed = 0, cleared = 0;
    for (const client of clients) {
      try {
        const qrs = await QRCode.find({ _id: { $in: client.qrCodes }, owner: client.agency, status: "active" })
          .select("businessName agencyBilling.price agencyBilling.nextPaymentDate")
          .lean();
        const block = billingBlock(qrs);

        if (!block.blocked) {
          if (client.billingBlockedAt) {
            client.billingBlockedAt = null;
            await client.save();
            cleared++;
          }
          continue;
        }
        if (client.billingBlockedAt) continue;

        const { agency, active } = await resolveClientAgency(client);
        if (!agency || !active) continue;

        const agencyName = agency.businessName || agency.name || "Your agency";
        const amount = formatMoney(block.overdueAmount, client.billingCurrency);
        const locations = block.overdueLocations.join(", ");

        // Mark first so a crash mid-send can't email twice on the next run.
        client.billingBlockedAt = new Date();
        await client.save();
        await Promise.all(["7d", "30d", "90d"].map((r) => delCache(`client:summary:v2:${client._id}:${r}`)));

        if (client.status === "active") {
          await sendClientBlockedEmail(client.email, {
            clientName: client.name,
            agencyName,
            amount,
            locations,
            days: BLOCK_AFTER_DAYS,
            link: appUrl("/client"),
          }).catch((err) => console.error(`❌ Block email to client ${client.email} failed:`, err.message));
        }
        if (agency.email) {
          await sendAgencyClientBlockedEmail(agency.email, {
            ownerName: agency.name,
            clientName: client.name,
            amount,
            locations,
            days: BLOCK_AFTER_DAYS,
            link: appUrl(`/dashboard/clients/${client._id}`),
          }).catch((err) => console.error(`❌ Block email to agency ${agency.email} failed:`, err.message));
        }
        emailed++;
      } catch (err) {
        console.error(`❌ Billing block check failed for client ${client._id}:`, err.message);
      }
    }
    console.log(`⏰ Client billing block check complete: ${emailed} newly blocked, ${cleared} unblocked.`);
    return { emailed, cleared };
  } catch (err) {
    console.error("Client billing block job error:", err.message);
    return { emailed: 0, cleared: 0 };
  }
}

function startClientBillingBlockJob() {
  cron.schedule("15 * * * *", checkClientBillingBlocks, { timezone: "Asia/Kolkata" });
  console.log("📅 Client billing block cron job scheduled (hourly)");
}

export { startClientBillingBlockJob, checkClientBillingBlocks };
