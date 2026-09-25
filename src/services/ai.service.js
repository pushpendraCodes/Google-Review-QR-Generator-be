import { getCache, setCache } from "../utils/cache.js";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.0-flash-001";

const env = (name) => (process.env[name] || "").trim();

/**
 * Generate 3 AI-powered review suggestions for a business.
 *
 * Prefers OpenRouter (OPENROUTER_API_KEY), then Gemini (GEMINI_API_KEY),
 * then template-based reviews.
 *
 * @param {{ businessName: string, businessType?: string, rating?: number }} opts
 * @returns {Promise<string[]>} Array of 3 review text suggestions
 */
async function generateReviewSuggestions({ businessName, businessType = "", rating = 5 }) {
  const cacheKey = `ai:reviews:${businessName.toLowerCase().replace(/\s+/g, "_")}`;

  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const reviews = await generateReviews({ businessName, businessType, rating });

  await setCache(cacheKey, reviews, 3600);

  return reviews;
}

async function generateReviews(opts) {
  const { businessName } = opts;
  const openRouterKey = env("OPENROUTER_API_KEY");
  const geminiKey = env("GEMINI_API_KEY");

  if (openRouterKey) {
    try {
      return await generateWithOpenRouter(opts, openRouterKey);
    } catch (err) {
      console.error("OpenRouter API failed:", err.message);
      if (geminiKey) {
        try {
          return await generateWithGemini(opts, geminiKey);
        } catch (geminiErr) {
          console.error("Gemini API failed, using fallback templates:", geminiErr.message);
        }
      }
      return generateFallbackReviews(businessName);
    }
  }

  if (geminiKey) {
    try {
      return await generateWithGemini(opts, geminiKey);
    } catch (err) {
      console.error("Gemini API failed, using fallback templates:", err.message);
      return generateFallbackReviews(businessName);
    }
  }

  return generateFallbackReviews(businessName);
}

function buildPrompt({ businessName, businessType }) {
  return `You are helping a happy customer write a Google review for "${businessName}"${businessType ? ` (a ${businessType})` : ""}.

Generate exactly 3 different short, natural-sounding 5-star Google reviews. Each should be 1-3 sentences, written in a casual and genuine customer tone. Vary the style:
1. One enthusiastic and brief
2. One mentioning specific aspects (service, quality, atmosphere)
3. One warm and recommendation-focused

IMPORTANT: Return ONLY a valid JSON array of 3 strings. No markdown, no explanation, no code blocks. Example format:
["Review 1 text", "Review 2 text", "Review 3 text"]`;
}

function parseReviewArray(text, source) {
  const jsonMatch = String(text || "").match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Could not parse ${source} response as JSON array`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error(`${source} returned less than 3 reviews`);
  }

  return parsed.slice(0, 3).map((item) => String(item).trim());
}

async function generateWithOpenRouter({ businessName, businessType, rating }, apiKey) {
  const model = env("OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL;
  const prompt = buildPrompt({ businessName, businessType, rating });
  const siteUrl = env("FRONTEND_URL") || "https://www.getreviewqr.com";

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": siteUrl,
      "X-Title": "ReviewQR",
    },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  return parseReviewArray(text, "OpenRouter");
}

async function generateWithGemini({ businessName, businessType, rating }, apiKey) {
  const prompt = buildPrompt({ businessName, businessType, rating });

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
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
  return parseReviewArray(text, "Gemini");
}

function generateFallbackReviews(businessName) {
  return [
    `Had a wonderful experience at ${businessName}! The service was excellent and I'll definitely be coming back. Highly recommended! ⭐`,
    `${businessName} exceeded my expectations. The quality was top-notch and the staff was incredibly friendly and professional. 5 stars!`,
    `I love ${businessName}! Great atmosphere, excellent service, and amazing value for money. Would definitely recommend to friends and family.`,
  ];
}

export { generateReviewSuggestions };
