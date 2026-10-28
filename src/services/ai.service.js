import { getCache, setCache } from "../utils/cache.js";
import { LANGUAGE_RULES } from "../config/reviewLanguages.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";
const OPENROUTER_FALLBACK_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-exp:free",
  "openai/gpt-4o-mini",
];
const GEMINI_FALLBACK_MODELS = [
  "gemini-3.8-flash",
  "gemini-2.5-flash",
  "gemini-1.5-flash",
];

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
  const { reviews } = await generateReviews({ businessName, businessType, rating });
  const uniqueReviews = [...new Set((reviews || []).map((r) => String(r).trim()).filter(Boolean))];

  return pickRandomReviews(uniqueReviews, 3);
}

async function generateReviews(opts) {
  const { businessName } = opts;
  const openRouterKey = env("OPENROUTER_API_KEY");
  const geminiKey = env("GEMINI_API_KEY");

  if (openRouterKey) {
    try {
      return { reviews: await generateWithOpenRouter(opts, openRouterKey), source: "openrouter" };
    } catch (err) {
      console.error("OpenRouter API failed:", err.message);
      if (geminiKey) {
        try {
          return { reviews: await generateWithGemini(opts, geminiKey), source: "gemini" };
        } catch (geminiErr) {
          console.error("Gemini API failed, using fallback templates:", geminiErr.message);
        }
      }
      return { reviews: generateFallbackReviews(businessName), source: "fallback" };
    }
  }

  if (geminiKey) {
    try {
      return { reviews: await generateWithGemini(opts, geminiKey), source: "gemini" };
    } catch (err) {
      console.error("Gemini API failed, using fallback templates:", err.message);
      return { reviews: generateFallbackReviews(businessName), source: "fallback" };
    }
  }

  return { reviews: generateFallbackReviews(businessName), source: "fallback" };
}

function buildPrompt({ businessName, businessType }) {
  return `You are helping a happy customer write a Google review for "${businessName}"${businessType ? ` (a ${businessType})` : ""}.

Generate exactly 6 different short, natural-sounding 5-star Google reviews. Each should be 1-3 sentences, written in a casual and genuine customer tone. Vary the style:
1. One enthusiastic and brief
2. One mentioning specific aspects (service, quality, atmosphere)
3. One warm and recommendation-focused
4. One simple and friendly
5. One detail-focused
6. One highly concise

IMPORTANT: Return ONLY a valid JSON array of 6 strings. No markdown, no explanation, no code blocks. Example format:
["Review 1 text", "Review 2 text", "Review 3 text", "Review 4 text", "Review 5 text", "Review 6 text"]`;
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

  return parsed
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function generateWithOpenRouter({ businessName, businessType, rating }, apiKey) {
  const prompt = buildPrompt({ businessName, businessType, rating });
  const text = await generateTextWithOpenRouter(prompt, apiKey, {
    temperature: 0.9,
    maxTokens: 400,
  });
  return parseReviewArray(text, "OpenRouter");
}

async function generateWithGemini({ businessName, businessType, rating }, apiKey) {
  const prompt = buildPrompt({ businessName, businessType, rating });
  const text = await generateTextWithGemini(prompt, apiKey, {
    temperature: 0.9,
    maxTokens: 300,
  });
  return parseReviewArray(text, "Gemini");
}

function generateFallbackReviews(businessName) {
  return [
    `Had a wonderful experience at ${businessName}! The service was excellent and I'll definitely be coming back. Highly recommended! ⭐`,
    `${businessName} exceeded my expectations. The quality was top-notch and the staff was incredibly friendly and professional. 5 stars!`,
    `I love ${businessName}! Great atmosphere, excellent service, and amazing value for money. Would definitely recommend to friends and family.`,
  ];
}

function isFallbackReviewSet(businessName, reviews) {
  if (!Array.isArray(reviews) || reviews.length < 3) return false;
  const fallback = generateFallbackReviews(businessName);
  return fallback.every((text, idx) => String(reviews[idx] || "").trim() === text.trim());
}

function pickRandomReviews(reviews, count) {
  const list = Array.isArray(reviews) ? [...new Set(reviews.map((r) => String(r).trim()).filter(Boolean))] : [];
  if (!list.length) return [];

  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.slice(0, Math.min(count, list.length));
}

const TONE_RULES = {
  friendly: "warm and casual",
  professional: "polite and to the point",
  enthusiastic: "excited and upbeat, but still believable",
};

const promptList = (items) => items.map((s) => `- ${s}`).join("\n");

function buildPersonalisedPrompt({ businessName, profile, answers, recent }) {
  const category = profile.category ? ` (${profile.category})` : "";
  const facts = [];
  if (profile.description) facts.push(`About the business: ${profile.description}`);

  const services = answers.services.length ? answers.services : [];
  if (services.length) {
    facts.push(
      `Services the customer used:\n${promptList(
        services.map((s) => (s.detail ? `${s.name} (${s.detail})` : s.name))
      )}`
    );
  }
  if (answers.liked.length) facts.push(`What the customer liked:\n${promptList(answers.liked)}`);
  if (answers.staff) facts.push(`Staff member who helped them: ${answers.staff}`);
  if (!services.length && !answers.liked.length && profile.highlights?.length) {
    facts.push(`Things this business is known for (mention at most one):\n${promptList(profile.highlights.slice(0, 5))}`);
  }

  const avoid = recent.length
    ? `\nOther customers recently got these reviews. Do NOT reuse their openings, phrases or structure:\n${promptList(
        recent.map((r) => `"${r.slice(0, 110)}"`)
      )}\n`
    : "";

  return `You are helping a real, happy customer write their own Google review for "${businessName}"${category}.

${facts.join("\n\n")}
${avoid}
Write exactly 3 different 5-star reviews from this customer's point of view (first person):
1. Short: one sentence.
2. Medium: two or three sentences.
3. Detailed: three or four sentences.

Rules:
- Only use the facts above. Never invent prices, timings, dishes, results, names or events that are not listed.
- Mention the services and liked points naturally; do not list them all in every review.
- If a staff member is given, mention them by name in at most two of the reviews.
- Tone: ${TONE_RULES[profile.tone] || TONE_RULES.friendly}. Sound like a real person, not an advert.
- Do not start every review the same way, and do not start with the business name.
- No hashtags, no emojis, no quotation marks around the text.
- ${LANGUAGE_RULES[answers.language] || LANGUAGE_RULES.en}

Return ONLY a valid JSON array of 3 strings, nothing else.`;
}

/**
 * 3 reviews (short, medium, detailed) built from the owner's profile and the
 * customer's validated answers. Falls back to generic suggestions on AI failure.
 */
async function generatePersonalisedReviews({ businessName, businessType = "", profile, answers, recent = [] }) {
  const prompt = buildPersonalisedPrompt({ businessName, profile, answers, recent });
  try {
    const text = await generateTextWithAi(prompt, answers.language === "en" ? 700 : 1400, 0.95);
    const reviews = parseReviewArray(text, "AI").slice(0, 3);
    if (reviews.length === 3) return reviews;
  } catch (err) {
    console.error("Personalised review generation failed:", err.message);
  }
  return generateReviewSuggestions({ businessName, businessType });
}

/** AI-drafted profile from Google data, for the owner to edit before saving. */
async function draftReviewProfile({ businessName, address = "", website = "", reviews = [] }) {
  const reviewText = reviews
    .map((r) => String(r || "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((r) => `- ${r.slice(0, 300)}`)
    .join("\n");

  const prompt = `You are setting up a business profile used to help customers write Google reviews.

Business: "${businessName}"
${address ? `Address: ${address}\n` : ""}${website ? `Website: ${website}\n` : ""}${reviewText ? `Recent Google reviews:\n${reviewText}\n` : ""}
Based only on this information and what a business of this kind normally offers, return a JSON object:
{
  "category": "short business category, e.g. Dental clinic",
  "description": "one or two plain sentences about the business, no claims you cannot see above",
  "services": [{ "name": "service name (max 5 words)", "detail": "optional short detail" }],
  "highlights": ["short things customers praise, max 4 words each"]
}
Give 4-8 services and 4-6 highlights. Do not include staff names. Return ONLY the JSON object.`;

  const text = await generateTextWithAi(prompt, 700, 0.4);
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse AI profile draft");
  return JSON.parse(match[0]);
}

function buildOwnerReplyPrompt({
  businessName,
  reviewerName,
  starRating,
  reviewText,
}) {
  return `You are the owner of "${businessName}" responding to a Google review.

Reviewer: ${reviewerName || "Customer"}
Rating: ${starRating} out of 5 stars
Review: "${reviewText || "(No written comment)"}"

Write ONE professional, warm owner reply (2-4 sentences). Thank the customer, address specific points when mentioned, and stay authentic. For low ratings, apologize sincerely and invite them to contact you offline to resolve the issue. Do not use placeholders like [Business Name]. Do not include markdown or quotes around the reply. Return ONLY the reply text.`;
}

async function generateTextWithAi(prompt, maxTokens = 280, temperature = 0.7) {
  const openRouterKey = env("OPENROUTER_API_KEY");
  const geminiKey = env("GEMINI_API_KEY");

  if (openRouterKey) {
    try {
      return await generateTextWithOpenRouter(prompt, openRouterKey, {
        temperature,
        maxTokens,
      });
    } catch (err) {
      console.error("OpenRouter request failed:", err.message);
      if (!geminiKey) throw err;
    }
  }

  if (geminiKey) {
    return generateTextWithGemini(prompt, geminiKey, {
      temperature,
      maxTokens,
    });
  }

  throw new Error("AI is not configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
}

function openRouterModelsToTry() {
  const custom = env("OPENROUTER_MODEL");
  const all = custom
    ? [custom, ...OPENROUTER_FALLBACK_MODELS]
    : OPENROUTER_FALLBACK_MODELS;
  return [...new Set(all.filter(Boolean))];
}

async function generateTextWithOpenRouter(prompt, apiKey, { temperature, maxTokens }) {
  const siteUrl = env("FRONTEND_URL") || "https://www.getreviewqr.com";
  const models = openRouterModelsToTry();
  let lastError = null;

  for (const model of models) {
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
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      lastError = `OpenRouter (${model}) ${response.status}: ${errorBody}`;
      // 404 model-not-found: try next candidate
      if (response.status === 404) continue;
      throw new Error(lastError);
    }

    const data = await response.json();
    const text = String(data.choices?.[0]?.message?.content || "").trim();
    if (text) return text;
    lastError = `OpenRouter (${model}) returned empty content`;
  }

  throw new Error(lastError || "OpenRouter failed for all configured models.");
}

function geminiModelsToTry() {
  const custom = env("GEMINI_MODEL");
  const all = custom ? [custom, ...GEMINI_FALLBACK_MODELS] : GEMINI_FALLBACK_MODELS;
  return [...new Set(all.filter(Boolean))];
}

async function generateTextWithGemini(prompt, apiKey, { temperature, maxTokens }) {
  const models = geminiModelsToTry();
  let lastError = null;

  for (const model of models) {
    const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      lastError = `Gemini (${model}) ${response.status}: ${errorBody}`;
      // 404 model-not-found: try next model
      if (response.status === 404) continue;
      throw new Error(lastError);
    }

    const data = await response.json();
    const text = String(data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (text) return text;
    lastError = `Gemini (${model}) returned empty content`;
  }

  throw new Error(lastError || "Gemini failed for all configured models.");
}

async function generateOwnerReplySuggestion({
  businessName,
  reviewerName,
  starRating,
  reviewText,
}) {
  const cacheKey = `ai:owner-reply:${businessName}:${starRating}:${String(reviewText).slice(0, 40)}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const prompt = buildOwnerReplyPrompt({
    businessName,
    reviewerName,
    starRating,
    reviewText,
  });

  let reply = await generateTextWithAi(prompt);
  reply = reply.replace(/^["']|["']$/g, "").trim();

  if (!reply) {
    reply =
      starRating >= 4
        ? `Thank you so much, ${reviewerName || "there"}, for your kind review! We're thrilled you had a great experience at ${businessName} and hope to see you again soon.`
        : `Thank you for your feedback, ${reviewerName || "there"}. We're sorry your experience at ${businessName} wasn't what you expected. Please contact us directly so we can make this right.`;
  }

  await setCache(cacheKey, reply, 1800);
  return reply;
}

export {
  generateReviewSuggestions,
  generateOwnerReplySuggestion,
  generatePersonalisedReviews,
  draftReviewProfile,
};
