const CASUAL = "the way people actually type reviews (simple everyday words, not formal)";
const KEEP_NAMES = "Keep business, service and staff names exactly as given.";

const written = (name, script, avoid = "") =>
  `Write in ${name}${script ? ` using ${script}` : ""}, ${CASUAL}. ${KEEP_NAMES}${avoid ? ` ${avoid}` : ""}`;

/** AI prompt rule per review language; key order is the order shown to owners and customers. */
export const LANGUAGE_RULES = {
  en: "Write in simple, natural English.",
  hi: written("Hindi", "Devanagari script"),
  hinglish: "Write in Hinglish: Hindi words typed in English (Roman) letters mixed with common English words, like Indian customers type on Google.",
  mr: written("Marathi", "Devanagari script", "Do not write in Hindi."),
  bn: written("Bengali", "Bengali script"),
  ta: written("Tamil", "Tamil script"),
  te: written("Telugu", "Telugu script"),
  gu: written("Gujarati", "Gujarati script", "Do not write in Hindi."),
  kn: written("Kannada", "Kannada script"),
  ml: written("Malayalam", "Malayalam script"),
  pa: written("Punjabi", "Gurmukhi script", "Do not write in Hindi."),
  ur: written("Urdu", "Urdu (Nastaliq/Arabic) script", "Do not write in Hindi."),
  zh: written("Mandarin Chinese", "Simplified Chinese characters"),
  es: written("Spanish"),
  fr: written("French"),
  ar: written("Modern Standard Arabic", "Arabic script"),
  pt: written("Portuguese"),
  ru: written("Russian", "Cyrillic script"),
  de: written("German"),
  ja: written("Japanese", "natural Japanese script (kanji, hiragana, katakana)"),
  id: written("Indonesian"),
};

export const REVIEW_LANGUAGES = Object.keys(LANGUAGE_RULES);

/** Offered when an owner hasn't chosen languages yet. */
export const DEFAULT_LANGUAGES = ["en", "hi", "hinglish", "mr"];
