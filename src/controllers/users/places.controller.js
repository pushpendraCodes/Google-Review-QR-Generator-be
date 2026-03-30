import { searchBusinesses as searchBusinessesSvc, getPlaceDetails as getPlaceDetailsSvc } from "../../services/places.service.js";
import { getCache, setCache } from "../../utils/cache.js";

// ─── Search businesses ────────────────────────────────────────────────────────
// GET /api/places/search?q=Pizza Palace Indore
export const searchBusinesses = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ message: "Search query must be at least 2 characters." });
    }

    const query = q.trim().toLowerCase();
    const cacheKey = `places:search:${query}`;

    // Check cache — saves Google API calls
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const results = await searchBusinessesSvc(query);
    const result = { results };

    // Cache for 10 minutes — place search results are mostly stable
    await setCache(cacheKey, result, 600);

    res.json(result);
  } catch (err) {
    console.error("Places search error:", err.message);
    res.status(500).json({ message: "Failed to search businesses. Please try again." });
  }
};

// ─── Get place details ────────────────────────────────────────────────────────
// GET /api/places/details/:placeId
export const getPlaceDetails = async (req, res) => {
  try {
    const { placeId } = req.params;
    if (!placeId) return res.status(400).json({ message: "placeId is required." });

    const cacheKey = `places:details:${placeId}`;

    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const details = await getPlaceDetailsSvc(placeId);
    const result = { place: details };

    // Cache for 30 minutes — place details rarely change
    await setCache(cacheKey, result, 1800);

    res.json(result);
  } catch (err) {
    console.error("Place details error:", err.message);
    res.status(500).json({ message: "Failed to fetch place details." });
  }
};
