import { sendTeamActivityEmail } from "./email.service.js";

export const appUrl = (path = "") => `${process.env.FRONTEND_URL || "http://localhost:3000"}${path}`;

/**
 * Emails the Agency owner when a team member does something on the account.
 * No-op for owners. Never throws or delays the request.
 */
export const notifyOwnerOfStaffAction = (req, { title, summary, details, path, linkText }) => {
  if (!req.isStaff || !req.account?.email) return;
  sendTeamActivityEmail(req.account.email, {
    ownerName: req.account.name,
    staffName: req.user.name || req.user.email,
    staffEmail: req.user.email,
    title,
    summary,
    details,
    link: appUrl(path),
    linkText,
  }).catch((err) => console.error("Team activity email failed:", err.message));
};
