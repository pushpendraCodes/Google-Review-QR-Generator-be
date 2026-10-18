import User from "../models/User.js";
import { hasActivePaidPlan, teamBaseSeats, teamMaxExtraSeats } from "../utils/helpers.js";
import { delCache, invalidatePattern } from "../utils/cache.js";
import { planGraceInfo } from "./planGrace.service.js";

/** Extra seats that count, clamped to the allowed range. */
export const extraSeatsOf = (owner) =>
  Math.min(teamMaxExtraSeats(), Math.max(0, Math.floor(owner?.extraSeats || 0)));

/** Staff seats for an Agency owner (owner not included): included seats + extra seats. */
export const seatLimitFor = (owner) => teamBaseSeats() + extraSeatsOf(owner);

const OWNER_FIELDS = "name email picture businessName plan planExpiresAt status";

export const isTeamOwnerActive = (owner) =>
  !!owner && owner.status !== "block" && owner.plan === "agency" && hasActivePaidPlan(owner);

/**
 * Resolves which account a user acts on.
 * Owners act on themselves. Staff act on their Agency owner's account and inherit
 * the owner's plan, but only while the owner still has an active Agency plan.
 */
export const resolveAccount = async (user) => {
  if (!user.teamOwner) {
    return { account: user, isStaff: false, teamActive: true };
  }
  const owner = await User.findById(user.teamOwner).select(OWNER_FIELDS).lean();
  return { account: owner, isStaff: true, teamActive: isTeamOwnerActive(owner) };
};

/**
 * Mongo filter for the QRs the current person may see.
 * Owner: every QR in the account. Staff: only QRs they created.
 */
export const qrScope = (req) =>
  req.isStaff
    ? { owner: req.account._id, createdBy: req.user._id }
    : { owner: req.user._id };

/**
 * Clears QR list/detail/analytics caches for everyone who can see a QR:
 * the acting person, the account owner and the QR's creator.
 */
export const invalidateQrCaches = async (req, { qrId, createdBy } = {}) => {
  const ids = new Set([String(req.user._id), String(req.account._id)]);
  if (createdBy) ids.add(String(createdBy));
  await Promise.all(
    [...ids].flatMap((uid) => [
      invalidatePattern(`qr:list:${uid}:*`),
      invalidatePattern(`analytics:*:${uid}:*`),
      qrId ? delCache(`qr:detail:${uid}:${qrId}`) : Promise.resolve(),
    ])
  );
};

export const clearUserCaches = (userId) =>
  Promise.all([
    delCache(`user:profile:${userId}`),
    delCache(`sub:active:${userId}`),
    invalidatePattern(`qr:list:${userId}:*`),
    invalidatePattern(`analytics:*:${userId}:*`),
  ]);

/**
 * User payload for the frontend. Staff get the owner's plan so plan-gated UI works,
 * plus a `team` block describing their role.
 */
export const serializeUser = async (user) => {
  const obj = typeof user.toJSON === "function" ? user.toJSON() : { ...user };
  delete obj.password;
  delete obj.refreshToken;

  if (!obj.teamOwner) {
    obj.team = { role: "owner" };
    obj.planGrace = planGraceInfo(obj);
    return obj;
  }

  const owner = await User.findById(obj.teamOwner).select(OWNER_FIELDS).lean();
  const active = isTeamOwnerActive(owner);
  obj.team = {
    role: "staff",
    active,
    joinedAt: obj.teamJoinedAt,
    owner: owner
      ? { _id: owner._id, name: owner.name, email: owner.email, picture: owner.picture, businessName: owner.businessName }
      : null,
  };
  obj.plan = active ? owner.plan : "free";
  obj.planExpiresAt = active ? owner.planExpiresAt : null;
  return obj;
};
