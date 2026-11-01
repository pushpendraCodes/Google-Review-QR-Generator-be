export const STANDEE_TEMPLATES = ["minimal", "luxury", "bold", "festive", "classic", "midnight", "dual", "spotlight"];

export const STANDEE_DISPLAY_KEYS = ["logo", "rating", "address", "phone", "nfc"];

/** NFC is off by default: the "Tap" badge only works if the owner sticks an NFC tag on the standee. */
export const DEFAULT_STANDEE_DISPLAY = { logo: true, rating: true, address: true, phone: false, nfc: false };

export const sanitizeStandeeTemplate = (value) => (STANDEE_TEMPLATES.includes(value) ? value : "minimal");

/** Keeps known keys only; missing keys fall back to `base` (current values or defaults). */
export function sanitizeStandeeDisplay(input, base = DEFAULT_STANDEE_DISPLAY) {
  const out = {};
  for (const key of STANDEE_DISPLAY_KEYS) {
    out[key] = typeof input?.[key] === "boolean" ? input[key] : Boolean(base?.[key] ?? DEFAULT_STANDEE_DISPLAY[key]);
  }
  return out;
}

export const sanitizeStandeePhone = (value) =>
  String(value ?? "").replace(/[^\d+()\-.\s]/g, "").replace(/\s+/g, " ").trim().slice(0, 25);
