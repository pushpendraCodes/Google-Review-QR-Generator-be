import { getCache, setCache } from "../utils/cache.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/**
 * Generate 3 AI-powered review suggestions for a business.
 *
 * Uses Google Gemini API if GEMINI_API_KEY is configured,
 * otherwise falls back to template-based reviews.
 *
 * @param {{ businessName: string, businessType?: string, rating?: number }} opts
 * @returns {Promise<string[]>} Array of 3 review text suggestions
 */
async function generateReviewSuggestions({ businessName, businessType = "", rating = 5 }) {
  const cacheKey = `ai:reviews:${businessName.toLowerCase().replace(/\s+/g, "_")}`;

  // Check cache first (1 hour TTL set on write)
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  let reviews;

  if (process.env.GEMINI_API_KEY) {
    try {
      reviews = await generateWithGemini({ businessName, businessType, rating });
    } catch (err) {
      console.error("Gemini API failed, using fallback templates:", err.message);
      reviews = generateFallbackReviews(businessName);
    }
  } else {
    reviews = generateFallbackReviews(businessName);
  }

  // Cache for 1 hour
  await setCache(cacheKey, reviews, 3600);

  return reviews;
}

/**
 * Call Google Gemini API to generate review suggestions.
 */
async function generateWithGemini({ businessName, businessType, rating }) {
  const prompt = `You are helping a happy customer write a Google review for "${businessName}"${businessType ? ` (a ${businessType})` : ""}.

Generate exactly 3 different short, natural-sounding 5-star Google reviews. Each should be 1-3 sentences, written in a casual and genuine customer tone. Vary the style:
1. One enthusiastic and brief
2. One mentioning specific aspects (service, quality, atmosphere)
3. One warm and recommendation-focused

IMPORTANT: Return ONLY a valid JSON array of 3 strings. No markdown, no explanation, no code blocks. Example format:
["Review 1 text", "Review 2 text", "Review 3 text"]`;

  const response = await fetch(`${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 300,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  // Extract JSON array from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse Gemini response as JSON array");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error("Gemini returned less than 3 reviews");
  }

  return parsed.slice(0, 3);
}

/**
 * Fallback template-based reviews when Gemini is unavailable.
 */
function generateFallbackReviews(businessName) {
  return [
    `Had a wonderful experience at ${businessName}! The service was excellent and I'll definitely be coming back. Highly recommended! ⭐`,
    `${businessName} exceeded my expectations. The quality was top-notch and the staff was incredibly friendly and professional. 5 stars!`,
    `I love ${businessName}! Great atmosphere, excellent service, and amazing value for money. Would definitely recommend to friends and family.`,
  ];
}

export { generateReviewSuggestions };
