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

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

/**
 * Search for businesses by text query.
 * Returns a list of candidates for the user to pick from.
 *
 * @param {string} query - e.g. "Pizza Palace Indore"
 * @returns {Array<{ placeId, name, address, rating }>}
 */
async function searchBusinesses(query) {
  if (!query || query.trim().length < 2) return [];

  const { data } = await axios.get(`${PLACES_BASE}/textsearch/json`, {
    params: {
      query,
      key: process.env.GOOGLE_MAPS_API_KEY,
      fields: "place_id,name,formatted_address,rating",
      language: "en",
    },
  });

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Places API error: ${data.status} — ${data.error_message || ""}`);
  }

  return (data.results || []).slice(0, 8).map((p) => ({
    placeId: p.place_id,
    name: p.name,
    address: p.formatted_address,
    rating: p.rating || null,
  }));
}

/**
 * Get full details for a specific place_id.
 * Used to confirm selection before QR generation.
 *
 * @param {string} placeId
 * @returns {{ placeId, name, address, website, phone, rating }}
 */
async function getPlaceDetails(placeId) {
  const { data } = await axios.get(`${PLACES_BASE}/details/json`, {
    params: {
      place_id: placeId,
      key: process.env.GOOGLE_MAPS_API_KEY,
      fields: "place_id,name,formatted_address,website,formatted_phone_number,rating",
      language: "en",
    },
  });

  if (data.status !== "OK") {
    throw new Error(`Place details error: ${data.status} — ${data.error_message || ""}`);
  }

  const r = data.result;
  return {
    placeId: r.place_id,
    name: r.name,
    address: r.formatted_address || "",
    website: r.website || "",
    phone: r.formatted_phone_number || "",
    rating: r.rating || null,
  };
}

/**
 * Build the direct Google review URL from a place_id.
 * This is what gets encoded in the QR code.
 */
function buildReviewUrl(placeId) {
  return `https://search.google.com/local/writereview?placeid=${placeId}`;
}

export { searchBusinesses, getPlaceDetails, buildReviewUrl };
