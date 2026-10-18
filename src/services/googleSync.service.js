import { getPlaceDetails } from "./places.service.js";

/** QRs whose Google data is older than this are refreshed when analytics are viewed. */
export const GOOGLE_STALE_MS = 30 * 60 * 1000;

/** Pull rating, review count and latest reviews for one QR from Google Places and save them. */
export async function refreshQrFromGoogle(qr) {
  const details = await getPlaceDetails(qr.placeId);
  qr.placeRating = details.rating || 0;
  qr.totalReviews = details.totalReviews || 0;
  qr.latestReviews = details.reviews || [];
  qr.googleSyncedAt = new Date();
  await qr.save();
  return details;
}

export function isGoogleDataStale(qr, maxAgeMs = GOOGLE_STALE_MS) {
  if (!qr.googleSyncedAt) return true;
  return Date.now() - new Date(qr.googleSyncedAt).getTime() > maxAgeMs;
}

/**
 * Refresh QRs from Google. Failures are logged and skipped so one bad
 * place ID doesn't block the rest.
 */
export async function refreshQrsFromGoogle(qrs, { force = false } = {}) {
  const targets = force ? qrs : qrs.filter((qr) => isGoogleDataStale(qr));
  return Promise.all(
    targets.map(async (qr) => {
      try {
        await refreshQrFromGoogle(qr);
        return { id: qr._id, status: "ok" };
      } catch (err) {
        console.error(`Google sync failed for QR ${qr._id}:`, err.message);
        return { id: qr._id, status: "failed", error: err.message };
      }
    })
  );
}
