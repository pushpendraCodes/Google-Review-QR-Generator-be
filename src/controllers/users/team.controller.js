import crypto from "crypto";
import mongoose from "mongoose";
import User from "../../models/User.js";
import QRCode from "../../models/QRCode.js";
import TeamInvite from "../../models/TeamInvite.js";
import { sendTeamInviteEmail } from "../../services/email.service.js";
import {
  seatLimitFor,
  extraSeatsOf,
  isTeamOwnerActive,
  clearUserCaches,
  serializeUser,
} from "../../services/team.service.js";
import {
  hasActivePaidPlan,
  teamBaseSeats,
  teamMaxSeats,
  teamMaxExtraSeats,
  SEAT_PRICE_MONTHLY,
} from "../../utils/helpers.js";

const INVITE_TTL_DAYS = 7;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("hex");
const inviteLink = (token) => `${process.env.FRONTEND_URL}/team/accept?token=${token}`;
const expiryDate = () => new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

const pendingFilter = (ownerId) => ({ owner: ownerId, status: "pending", expiresAt: { $gt: new Date() } });

const seatsUsed = async (ownerId) => {
  const [members, invites] = await Promise.all([
    User.countDocuments({ teamOwner: ownerId }),
    TeamInvite.countDocuments(pendingFilter(ownerId)),
  ]);
  return { members, invites, used: members + invites };
};

const requireAgencyOwner = (req, res) => {
  if (req.isStaff) {
    res.status(403).json({ code: "STAFF_FORBIDDEN", message: "Only the agency owner can manage the team." });
    return false;
  }
  if (!isTeamOwnerActive(req.user)) {
    res.status(403).json({ message: "Team members are available on an active Agency plan.", upgrade: true, requiredPlan: "agency" });
    return false;
  }
  return true;
};

const sendInvite = (owner, email, token) =>
  sendTeamInviteEmail(email, {
    ownerName: owner.name,
    businessName: owner.businessName,
    inviteLink: inviteLink(token),
    expiresInDays: INVITE_TTL_DAYS,
  });

// ─── GET /api/team ────────────────────────────────────────────────────────────
// Owner: members (with QR stats), pending invites, seat usage.
// Staff: who their agency owner is.
export const getTeam = async (req, res) => {
  try {
    if (req.isStaff) {
      const me = await serializeUser(req.user);
      return res.json({ role: "staff", team: me.team });
    }

    const ownerId = req.user._id;
    const [members, invites, qrStats] = await Promise.all([
      User.find({ teamOwner: ownerId })
        .select("name email picture teamJoinedAt lastLoginAt status")
        .sort({ teamJoinedAt: 1 })
        .lean(),
      TeamInvite.find(pendingFilter(ownerId)).select("email expiresAt lastSentAt createdAt").sort({ createdAt: -1 }).lean(),
      QRCode.aggregate([
        { $match: { owner: ownerId, status: "active" } },
        { $group: { _id: "$createdBy", qrCount: { $sum: 1 }, totalScans: { $sum: "$scanCount" } } },
      ]),
    ]);

    const statsBy = new Map(qrStats.map((s) => [String(s._id), s]));
    const ownerStats = qrStats
      .filter((s) => s._id === null || String(s._id) === String(ownerId))
      .reduce((acc, s) => ({ qrCount: acc.qrCount + s.qrCount, totalScans: acc.totalScans + s.totalScans }), { qrCount: 0, totalScans: 0 });

    return res.json({
      role: "owner",
      canManage: isTeamOwnerActive(req.user),
      seatLimit: seatLimitFor(req.user),
      seatsUsed: members.length + invites.length,
      seats: {
        included: teamBaseSeats(),
        extra: extraSeatsOf(req.user),
        max: teamMaxSeats(),
        maxExtra: teamMaxExtraSeats(),
        pricePerMonth: { ...SEAT_PRICE_MONTHLY },
        planExpiresAt: req.user.planExpiresAt,
      },
      owner: {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        picture: req.user.picture,
        ...ownerStats,
      },
      members: members.map((m) => ({
        ...m,
        qrCount: statsBy.get(String(m._id))?.qrCount || 0,
        totalScans: statsBy.get(String(m._id))?.totalScans || 0,
      })),
      invites,
    });
  } catch (err) {
    console.error("getTeam error:", err);
    return res.status(500).json({ message: "Failed to load team." });
  }
};

// ─── POST /api/team/invites  { email } ───────────────────────────────────────
export const inviteMember = async (req, res) => {
  try {
    if (!requireAgencyOwner(req, res)) return;

    const email = String(req.body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: "Enter a valid email address." });
    if (email === req.user.email) return res.status(400).json({ message: "You can't invite yourself." });

    const existingUser = await User.findOne({ email }).select("teamOwner").lean();
    if (existingUser && String(existingUser.teamOwner) === String(req.user._id)) {
      return res.status(409).json({ message: "This person is already in your team." });
    }
    if (existingUser?.teamOwner) {
      return res.status(409).json({ message: "This person already belongs to another agency team." });
    }

    const duplicate = await TeamInvite.findOne({ ...pendingFilter(req.user._id), email }).lean();
    if (duplicate) {
      return res.status(409).json({ message: "An invite is already pending for this email. Use “Resend” instead." });
    }

    const { used } = await seatsUsed(req.user._id);
    const limit = seatLimitFor(req.user);
    if (used >= limit) {
      return res.status(403).json({
        code: "SEATS_FULL",
        message: `All ${limit} team seats are in use. Add more seats, remove a member or cancel an invite first.`,
      });
    }

    const token = newToken();
    const invite = await TeamInvite.create({
      owner: req.user._id,
      email,
      tokenHash: hashToken(token),
      expiresAt: expiryDate(),
    });

    try {
      await sendInvite(req.user, email, token);
    } catch (mailErr) {
      console.error("Team invite email failed:", mailErr.message);
      await invite.deleteOne();
      return res.status(502).json({ message: "Couldn't send the invite email. Please try again." });
    }

    return res.status(201).json({
      message: `Invite sent to ${email}`,
      invite: { _id: invite._id, email, expiresAt: invite.expiresAt, lastSentAt: invite.lastSentAt, createdAt: invite.createdAt },
    });
  } catch (err) {
    console.error("inviteMember error:", err);
    return res.status(500).json({ message: "Failed to send invite." });
  }
};

// ─── POST /api/team/invites/:id/resend ───────────────────────────────────────
export const resendInvite = async (req, res) => {
  try {
    if (!requireAgencyOwner(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Invite not found." });

    const invite = await TeamInvite.findOne({ _id: req.params.id, owner: req.user._id, status: "pending" });
    if (!invite) return res.status(404).json({ message: "Invite not found." });

    if (invite.lastSentAt && Date.now() - invite.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      return res.status(429).json({ message: "Please wait a minute before resending." });
    }

    // A fresh token invalidates the old link and restarts the expiry window.
    const token = newToken();
    invite.tokenHash = hashToken(token);
    invite.expiresAt = expiryDate();
    invite.lastSentAt = new Date();
    await invite.save();

    await sendInvite(req.user, invite.email, token);
    return res.json({ message: `Invite resent to ${invite.email}` });
  } catch (err) {
    console.error("resendInvite error:", err);
    return res.status(500).json({ message: "Failed to resend invite." });
  }
};

// ─── DELETE /api/team/invites/:id ────────────────────────────────────────────
export const revokeInvite = async (req, res) => {
  try {
    if (req.isStaff) return res.status(403).json({ message: "Only the agency owner can manage the team." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Invite not found." });

    const invite = await TeamInvite.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id, status: "pending" },
      { status: "revoked" }
    );
    if (!invite) return res.status(404).json({ message: "Invite not found." });
    return res.json({ message: "Invite cancelled." });
  } catch (err) {
    console.error("revokeInvite error:", err);
    return res.status(500).json({ message: "Failed to cancel invite." });
  }
};

// ─── DELETE /api/team/members/:id ────────────────────────────────────────────
// The member loses access; QRs they created stay in the owner's account.
export const removeMember = async (req, res) => {
  try {
    if (req.isStaff) return res.status(403).json({ message: "Only the agency owner can manage the team." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Member not found." });

    const member = await User.findOneAndUpdate(
      { _id: req.params.id, teamOwner: req.user._id },
      { teamOwner: null, teamJoinedAt: null }
    );
    if (!member) return res.status(404).json({ message: "Member not found." });

    await Promise.all([clearUserCaches(String(member._id)), clearUserCaches(String(req.user._id))]);
    return res.json({ message: `${member.name || member.email} was removed from the team. Their QR codes stay in your account.` });
  } catch (err) {
    console.error("removeMember error:", err);
    return res.status(500).json({ message: "Failed to remove member." });
  }
};

// ─── GET /api/team/invite/:token (public) ────────────────────────────────────
export const getInviteInfo = async (req, res) => {
  try {
    const invite = await TeamInvite.findOne({ tokenHash: hashToken(String(req.params.token || "")) })
      .populate("owner", "name businessName picture plan planExpiresAt status")
      .lean();

    if (!invite || invite.status === "revoked") {
      return res.status(404).json({ status: "invalid", message: "This invite link is invalid or was cancelled." });
    }
    if (invite.status === "accepted") {
      return res.json({ status: "accepted", email: invite.email, ownerName: invite.owner?.name });
    }
    if (invite.expiresAt < new Date()) {
      return res.json({ status: "expired", email: invite.email, ownerName: invite.owner?.name });
    }
    if (!isTeamOwnerActive(invite.owner)) {
      return res.json({ status: "unavailable", email: invite.email, ownerName: invite.owner?.name });
    }

    return res.json({
      status: "pending",
      email: invite.email,
      ownerName: invite.owner.name,
      businessName: invite.owner.businessName,
      ownerPicture: invite.owner.picture,
      expiresAt: invite.expiresAt,
    });
  } catch (err) {
    console.error("getInviteInfo error:", err);
    return res.status(500).json({ message: "Failed to load invite." });
  }
};

// ─── POST /api/team/accept  { token } ────────────────────────────────────────
export const acceptInvite = async (req, res) => {
  try {
    const invite = await TeamInvite.findOne({ tokenHash: hashToken(String(req.body.token || "")) });
    if (!invite || invite.status === "revoked") {
      return res.status(404).json({ message: "This invite link is invalid or was cancelled." });
    }

    const user = req.user;

    if (invite.status === "accepted") {
      if (String(invite.acceptedBy) === String(user._id)) {
        return res.json({ message: "You're already in this team.", user: await serializeUser(user) });
      }
      return res.status(409).json({ message: "This invite has already been used." });
    }
    if (invite.expiresAt < new Date()) {
      return res.status(410).json({ message: "This invite has expired. Ask the agency owner to resend it." });
    }
    if (invite.email !== user.email) {
      return res.status(403).json({
        code: "EMAIL_MISMATCH",
        message: `This invite was sent to ${invite.email}. Sign in with that email to accept it.`,
      });
    }
    if (String(invite.owner) === String(user._id)) {
      return res.status(400).json({ message: "You can't join your own team." });
    }
    if (user.teamOwner) {
      return res.status(409).json({ message: "You're already part of an agency team. Leave it first to join another." });
    }

    const [owner, hasOwnTeam, hasOwnQrs, memberCount] = await Promise.all([
      User.findById(invite.owner).select("name plan planExpiresAt status extraSeats").lean(),
      User.exists({ teamOwner: user._id }),
      QRCode.exists({ owner: user._id, status: "active" }),
      User.countDocuments({ teamOwner: invite.owner }),
    ]);

    if (!isTeamOwnerActive(owner)) {
      return res.status(403).json({ message: "This agency's plan isn't active right now, so the invite can't be accepted." });
    }
    if (hasOwnTeam) {
      return res.status(409).json({ message: "Your account has its own team members, so it can't join another team." });
    }
    if (hasActivePaidPlan(user)) {
      return res.status(409).json({
        message: "Your account has its own paid plan. Use a different email for the agency team, or wait until your plan ends.",
      });
    }
    if (hasOwnQrs) {
      return res.status(409).json({
        message: "Your account already has its own QR codes. Use a different email for the agency team, or delete those QR codes first.",
      });
    }
    if (memberCount >= seatLimitFor(owner)) {
      return res.status(403).json({ message: "This team has no free seats. Ask the agency owner to free one up." });
    }

    // Atomic guard against accepting two invites at once.
    const joined = await User.findOneAndUpdate(
      { _id: user._id, teamOwner: null },
      { teamOwner: invite.owner, teamJoinedAt: new Date(), firstLogin: false },
      { new: true }
    );
    if (!joined) return res.status(409).json({ message: "You're already part of an agency team." });

    invite.status = "accepted";
    invite.acceptedBy = user._id;
    invite.acceptedAt = new Date();
    await invite.save();

    await Promise.all([clearUserCaches(String(user._id)), clearUserCaches(String(invite.owner))]);

    return res.json({ message: `You've joined ${owner.name}'s team.`, user: await serializeUser(joined) });
  } catch (err) {
    console.error("acceptInvite error:", err);
    return res.status(500).json({ message: "Failed to accept invite." });
  }
};

// ─── POST /api/team/leave ────────────────────────────────────────────────────
export const leaveTeam = async (req, res) => {
  try {
    if (!req.user.teamOwner) return res.status(400).json({ message: "You're not part of a team." });

    const ownerId = String(req.user.teamOwner);
    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { teamOwner: null, teamJoinedAt: null },
      { new: true }
    );

    await Promise.all([clearUserCaches(String(req.user._id)), clearUserCaches(ownerId)]);
    return res.json({ message: "You left the team.", user: await serializeUser(updated) });
  } catch (err) {
    console.error("leaveTeam error:", err);
    return res.status(500).json({ message: "Failed to leave team." });
  }
};

// ─── PATCH /api/team/seats  { extraSeats } ───────────────────────────────────
// Lowers the number of extra seats (e.g. before renewing so the renewal costs less).
// Adding seats goes through the paid checkout instead. No refunds for removed seats.
export const reduceSeats = async (req, res) => {
  try {
    if (req.isStaff) return res.status(403).json({ message: "Only the agency owner can manage seats." });

    const target = Number(req.body.extraSeats);
    const current = extraSeatsOf(req.user);
    if (!Number.isInteger(target) || target < 0) {
      return res.status(400).json({ message: "extraSeats must be a whole number of 0 or more." });
    }
    if (target > current) {
      return res.status(400).json({ message: "To add seats, use “Add seats” and complete the payment." });
    }

    const { used } = await seatsUsed(req.user._id);
    const minExtra = Math.max(0, used - teamBaseSeats());
    if (target < minExtra) {
      return res.status(409).json({
        message: `${used} seats are in use. Remove members or cancel invites before going below ${minExtra} extra seat${minExtra === 1 ? "" : "s"}.`,
      });
    }

    await User.updateOne({ _id: req.user._id }, { extraSeats: target });
    await clearUserCaches(String(req.user._id));
    return res.json({
      message: target === current ? "No change." : `Extra seats set to ${target}.`,
      extraSeats: target,
      seatLimit: teamBaseSeats() + target,
    });
  } catch (err) {
    console.error("reduceSeats error:", err);
    return res.status(500).json({ message: "Failed to update seats." });
  }
};
