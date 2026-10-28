import { canUseFeature } from "../utils/helpers.js";
import { DEFAULT_LANGUAGES, REVIEW_LANGUAGES } from "../config/reviewLanguages.js";

export const PROFILE_LIMITS = {
  services: 30,
  highlights: 15,
  staff: 20,
  pickServices: 3,
  pickLiked: 4,
};

export const REVIEW_TONES = ["friendly", "professional", "enthusiastic"];
export { REVIEW_LANGUAGES };

export const DEFAULT_LIKED = [
  "Friendly staff",
  "Quick service",
  "Great quality",
  "Good value",
  "Clean place",
  "Professional",
];

const clean = (value, max) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const uniqueList = (items, max, len) => {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = clean(item, len);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
};

/** Normalises owner input (or an AI draft) into a storable profile. */
export function sanitizeProfile(input = {}) {
  const seen = new Set();
  const services = [];
  for (const svc of Array.isArray(input.services) ? input.services : []) {
    const name = clean(typeof svc === "string" ? svc : svc?.name, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    services.push({ name, detail: clean(svc?.detail, 140) });
    if (services.length >= PROFILE_LIMITS.services) break;
  }

  return {
    category: clean(input.category, 60),
    description: clean(input.description, 500),
    services,
    highlights: uniqueList(input.highlights, PROFILE_LIMITS.highlights, 40),
    staff: uniqueList(input.staff, PROFILE_LIMITS.staff, 30),
    tone: REVIEW_TONES.includes(input.tone) ? input.tone : "friendly",
    languages: profileLanguages(input),
  };
}

/** Languages the owner allows, in canonical order; the defaults when unset or empty. */
export function profileLanguages(profile) {
  const picked = Array.isArray(profile?.languages) ? profile.languages : [];
  const out = REVIEW_LANGUAGES.filter((l) => picked.includes(l));
  return out.length ? out : [...DEFAULT_LANGUAGES];
}

export const hasProfile = (profile) =>
  Boolean(profile?.services?.length || profile?.highlights?.length);

export const profileEnabled = (owner, profile) =>
  canUseFeature(owner?.plan, "aiProfile") && hasProfile(profile);

/** Chips shown to the customer on the review page. */
export function buildQuestions(profile) {
  return {
    services: (profile.services || []).map((s) => s.name),
    liked: uniqueList([...(profile.highlights || []), ...DEFAULT_LIKED], 10, 40),
    staff: profile.staff || [],
    languages: profileLanguages(profile),
  };
}

/**
 * Keeps only answers that match the owner's own lists, so nothing the customer
 * types ever reaches the AI prompt.
 */
export function validateAnswers(profile, answers = {}) {
  const questions = buildQuestions(profile);
  const pick = (values, allowed, max) => {
    const map = new Map(allowed.map((a) => [a.toLowerCase(), a]));
    return uniqueList(values, max, 60)
      .map((v) => map.get(v.toLowerCase()))
      .filter(Boolean);
  };

  const serviceNames = pick(answers.services, questions.services, PROFILE_LIMITS.pickServices);
  const staffName = pick([answers.staff], questions.staff, 1)[0] || "";

  return {
    services: (profile.services || []).filter((s) => serviceNames.includes(s.name)),
    liked: pick(answers.liked, questions.liked, PROFILE_LIMITS.pickLiked),
    staff: staffName,
    language: questions.languages.includes(answers.language) ? answers.language : questions.languages[0],
  };
}

export const hasAnswers = (a) => Boolean(a.services.length || a.liked.length || a.staff);
