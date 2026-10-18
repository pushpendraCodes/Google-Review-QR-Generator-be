/**
 * Google Places Service
 *
 * Used for:
 *   1. searchBusinesses(query)     → autocomplete-style text search
 *   2. getPlaceDetails(placeId)    → get business name, address, place_id
 *
 * This replaces the old "paste Maps URL → extract place_id" flow.
 * Users now search by name/address and select from a list.
 */

import axios from "axios";

const PLACES_NEW_BASE = "https://places.googleapis.com/v1";

function placesHeaders(fieldMask) {
  return {
    "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
    "X-Goog-FieldMask": fieldMask,
    "Content-Type": "application/json",
  };
}

/**
 * Search for businesses by text query.
 * Returns a list of candidates for the user to pick from.
 *
 * @param {string} query - e.g. "Pizza Palace Indore"
 * @returns {Array<{ placeId, name, address, rating }>}
 */
async function searchBusinesses(query) {
  if (!query || query.trim().length < 2) return [];

  try {
    const { data } = await axios.post(
      `${PLACES_NEW_BASE}/places:searchText`,
      {
        textQuery: query,
        languageCode: "en",
        maxResultCount: 8,
      },
      {
        headers: placesHeaders(
          "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount"
        ),
      }
    );

    return (data.places || []).slice(0, 8).map((p) => ({
      placeId: p.id,
      name: p.displayName?.text || "",
      address: p.formattedAddress || "",
      rating: p.rating || null,
      totalReviews: p.userRatingCount || 0,
    }));
  } catch (err) {
    const detail =
      err.response?.data?.error?.message ||
      err.response?.data?.message ||
      err.message;
    throw new Error(`Places API (New) search error: ${detail}`);
  }
}

/**
 * Get full details for a specific place_id.
 * Used to confirm selection before QR generation.
 *
 * @param {string} placeId
 * @returns {{ placeId, name, address, website, phone, rating }}
 */
async function getPlaceDetails(placeId) {
  try {
    const { data } = await axios.get(`${PLACES_NEW_BASE}/places/${placeId}`, {
      params: { languageCode: "en" },
      headers: placesHeaders(
        "id,displayName,formattedAddress,websiteUri,nationalPhoneNumber,rating,userRatingCount,reviews"
      ),
    });

    return {
      placeId: data.id,
      name: data.displayName?.text || "",
      address: data.formattedAddress || "",
      website: data.websiteUri || "",
      phone: data.nationalPhoneNumber || "",
      rating: data.rating || null,
      totalReviews: data.userRatingCount || 0,
      reviews: (data.reviews || []).map((rev) => ({
        authorName: rev.authorAttribution?.displayName || "Google User",
        rating: rev.rating || 0,
        text: rev.text?.text || "",
        time: rev.publishTime ? Math.floor(new Date(rev.publishTime).getTime() / 1000) : 0,
      })),
    };
  } catch (err) {
    const detail =
      err.response?.data?.error?.message ||
      err.response?.data?.message ||
      err.message;
    throw new Error(`Places API (New) details error: ${detail}`);
  }
}


/**
 * Build the direct Google review URL from a place_id.
 * This is what gets encoded in the QR code.
 */
function buildReviewUrl(placeId) {
  return `https://search.google.com/local/writereview?placeid=${placeId}`;
}

export { searchBusinesses, getPlaceDetails, buildReviewUrl };
