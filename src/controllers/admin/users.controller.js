import mongoose from "mongoose";
import User from "../../models/User.js";
import QRCode from "../../models/QRCode.js";
import ScanLog from "../../models/ScanLog.js";
import Transaction from "../../models/Transaction.js";
import TeamInvite from "../../models/TeamInvite.js";
import ClientAccount from "../../models/ClientAccount.js";
import PaymentClaim from "../../models/PaymentClaim.js";
import AgencyPaymentSettings from "../../models/AgencyPaymentSettings.js";
import { hasActivePaidPlan, teamBaseSeats, teamMaxExtraSeats } from "../../utils/helpers.js";
import { delCache } from "../../utils/cache.js";
import { planLapsedAt as lapsedAtOf, syncPlanPause } from "../../services/planGrace.service.js";
import { billingBlock } from "../../services/clientBilling.service.js";

const PLANS = ["free", "starter", "pro", "agency"];
const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  lastLogin: { lastLoginAt: -1 },
  name: { name: 1 },
};

const USER_SAFE_FIELDS = "-password -refreshToken -emailOtp -emailOtpExpiry";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getUsdToInr = () => {
  const rate = Number(process.env.USD_TO_INR);
  return Number.isFinite(rate) && rate > 0 ? rate : 85;
};

/**
 * GET /api/admin/users
 * Query: page, limit, search, plan, status, sort (newest|oldest|lastLogin|name)
 */
export const listUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;
    const sort = SORTS[req.query.sort] || SORTS.newest;

    const filter = {};

    if (req.query.search?.trim()) {
      const re = new RegExp(escapeRegex(req.query.search.trim()), "i");
      filter.$or = [{ name: re }, { email: re }, { businessName: re }, { mobile: re }];
    }

    if (PLANS.includes(req.query.plan)) {
      filter.plan = req.query.plan;
    }

    if (["active", "block"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [users, total, statsAgg] = await Promise.all([
      User.find(filter).select(USER_SAFE_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),

      // Stats always run on ALL users, ignoring filters
      User.aggregate([
        {
          $facet: {
            totalAll: [{ $count: "count" }],
            blockedAll: [{ $match: { status: "block" } }, { $count: "count" }],
            byPlan: [{ $group: { _id: "$plan", count: { $sum: 1 } } }],
            newThisMonth: [{ $match: { createdAt: { $gte: thirtyDaysAgo } } }, { $count: "count" }],
            activeLast30: [{ $match: { lastLoginAt: { $gte: thirtyDaysAgo } } }, { $count: "count" }],
            paidActive: [
              {
                $match: {
                  plan: { $ne: "free" },
                  $or: [{ planExpiresAt: null }, { planExpiresAt: { $gt: now } }],
                },
              },
              { $count: "count" },
            ],
            // Churned = had a paid plan, now expired and not renewed
            churned: [
              { $match: { plan: "free", planExpiresAt: { $lt: now, $ne: null } } },
              { $count: "count" },
            ],
          },
        },
      ]),
    ]);

    const userIds = users.map((u) => u._id);
    const qrStats = userIds.length
      ? await QRCode.aggregate([
          { $match: { owner: { $in: userIds } } },
          { $group: { _id: "$owner", qrCount: { $sum: 1 }, totalScans: { $sum: "$scanCount" } } },
        ])
      : [];
    const qrStatsMap = Object.fromEntries(qrStats.map((s) => [s._id.toString(), s]));

    const s = statsAgg[0];
    const count = (key) => s[key][0]?.count || 0;
    const totalAll = count("totalAll");
    const churned = count("churned");

    const byPlan = { free: 0, starter: 0, pro: 0, agency: 0 };
    s.byPlan.forEach(({ _id, count: c }) => { if (_id) byPlan[_id] = c; });

    return res.json({
      users: users.map((u) => ({
        ...u,
        planActive: hasActivePaidPlan(u),
        qrCount: qrStatsMap[u._id.toString()]?.qrCount || 0,
        totalScans: qrStatsMap[u._id.toString()]?.totalScans || 0,
      })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      stats: {
        total: totalAll,
        blocked: count("blockedAll"),
        newThisMonth: count("newThisMonth"),
        activeLast30: count("activeLast30"),
        paidActive: count("paidActive"),
        churned,
        churnRate: totalAll > 0 ? ((churned / totalAll) * 100).toFixed(1) + "%" : "0%",
        byPlan,
      },
    });
  } catch (err) {
    console.error("Admin listUsers error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const countBy = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.count]));

/** Agency staff (with what each created) and pending invites. */
const loadTeam = async (ownerId) => {
  const [members, inviteDocs] = await Promise.all([
    User.find({ teamOwner: ownerId })
      .select("name email picture status lastLoginAt teamJoinedAt createdAt")
      .sort({ teamJoinedAt: 1 })
      .lean(),
    TeamInvite.find({ owner: ownerId, status: "pending" }).select("email expiresAt lastSentAt createdAt").sort({ createdAt: -1 }).lean(),
  ]);
  const now = Date.now();
  const invites = inviteDocs.map((i) => ({ ...i, expired: new Date(i.expiresAt).getTime() < now }));
  if (!members.length) return { members: [], invites };

  const ids = members.map((m) => m._id);
  const [qrCounts, clientCounts] = await Promise.all([
    QRCode.aggregate([{ $match: { owner: ownerId, createdBy: { $in: ids } } }, { $group: { _id: "$createdBy", count: { $sum: 1 } } }]),
    ClientAccount.aggregate([{ $match: { agency: ownerId, createdBy: { $in: ids } } }, { $group: { _id: "$createdBy", count: { $sum: 1 } } }]),
  ]);
  const qrMap = countBy(qrCounts);
  const clientMap = countBy(clientCounts);
  return {
    members: members.map((m) => ({ ...m, qrCount: qrMap[String(m._id)] || 0, clientCount: clientMap[String(m._id)] || 0 })),
    invites,
  };
};

/** Agency client logins with their QR count, overdue status and pending "I've paid" claims. */
const loadClients = async (agencyId) => {
  const clients = await ClientAccount.find({ agency: agencyId })
    .select("name email status lastLoginAt billingCurrency createdBy qrCodes createdAt")
    .populate("createdBy", "name email")
    .populate("qrCodes", "businessName status agencyBilling.price agencyBilling.nextPaymentDate")
    .sort({ createdAt: -1 })
    .lean();
  if (!clients.length) return [];

  const claimCounts = await PaymentClaim.aggregate([
    { $match: { agency: agencyId, status: "pending" } },
    { $group: { _id: "$client", count: { $sum: 1 } } },
  ]);
  const claimMap = countBy(claimCounts);

  return clients.map(({ qrCodes = [], createdBy, ...c }) => {
    const qrs = qrCodes.filter(Boolean);
    const block = billingBlock(qrs);
    return {
      ...c,
      createdBy: createdBy && String(createdBy._id) !== String(agencyId) ? { _id: createdBy._id, name: createdBy.name, email: createdBy.email } : null,
      qrCount: qrs.length,
      qrNames: qrs.map((q) => q.businessName),
      pendingClaims: claimMap[String(c._id)] || 0,
      billing: {
        blocked: block.blocked,
        blocksOn: block.blocksOn,
        overdueAmount: block.overdueAmount,
      },
    };
  });
};

/** For a staff account: the agency they belong to and what they've created there. */
const loadTeamOf = async (user) => {
  const [owner, qrCount, clientCount] = await Promise.all([
    User.findById(user.teamOwner).select("name email businessName plan planExpiresAt picture").lean(),
    QRCode.countDocuments({ owner: user.teamOwner, createdBy: user._id }),
    ClientAccount.countDocuments({ agency: user.teamOwner, createdBy: user._id }),
  ]);
  if (!owner) return null;
  return { owner: { ...owner, planActive: hasActivePaidPlan(owner) }, joinedAt: user.teamJoinedAt, qrCount, clientCount };
};

/**
 * GET /api/admin/users/:id
 * Profile, QR codes, payments, and 30-day scan activity for one user.
 */
export const getUser = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = await User.findById(req.params.id).select(USER_SAFE_FIELDS).lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const usdToInr = getUsdToInr();
    const now = new Date();
    const rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));

    const [qrCodes, transactions, teamMembers, team, clients, teamOf] = await Promise.all([
      QRCode.find({ owner: user._id })
        .select(
          "businessName label placeAddress placeRating totalReviews googleSyncedAt reviewUrl scanCount status isActive shortCode qrConfig.logoUrl createdAt",
        )
        .sort({ scanCount: -1 })
        .lean(),
      Transaction.find({ user: user._id })
        .select("plan kind seats amount originalAmount discountAmount couponApplied currency billingCycle paymentProvider status createdAt purchaseDate")
        .sort({ createdAt: -1 })
        .lean(),
      User.countDocuments({ teamOwner: user._id }),
      loadTeam(user._id),
      loadClients(user._id),
      user.teamOwner ? loadTeamOf(user) : null,
    ]);

    const qrIds = qrCodes.map((q) => q._id);
    const [scanSeriesAgg, topLocations, lastScan] = qrIds.length
      ? await Promise.all([
          ScanLog.aggregate([
            { $match: { qrCode: { $in: qrIds }, scannedAt: { $gte: rangeStart } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$scannedAt" } }, count: { $sum: 1 } } },
          ]),
          ScanLog.aggregate([
            { $match: { qrCode: { $in: qrIds }, city: { $nin: ["", null] } } },
            { $group: { _id: { city: "$city", country: "$country" }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ]),
          ScanLog.findOne({ qrCode: { $in: qrIds } }).sort({ scannedAt: -1 }).select("scannedAt").lean(),
        ])
      : [[], [], null];

    const scanMap = Object.fromEntries(scanSeriesAgg.map((r) => [r._id, r.count]));
    const scanSeries = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(rangeStart);
      d.setUTCDate(rangeStart.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      scanSeries.push({ date: key, value: scanMap[key] || 0 });
    }

    const toInr = (t) => (t.currency === "USD" ? Math.round(t.amount * usdToInr) : t.amount);
    const completed = transactions.filter((t) => t.status === "completed");

    return res.json({
      user: {
        ...user,
        planActive: hasActivePaidPlan(user),
        extraSeats: user.extraSeats || 0,
        teamMembers,
        seatLimit: teamBaseSeats() + (user.extraSeats || 0),
        maxExtraSeats: teamMaxExtraSeats(),
      },
      qrCodes,
      team,
      clients,
      teamOf,
      transactions: transactions.map((t) => ({ ...t, amountInr: toInr(t) })),
      scanSeries,
      topLocations: topLocations.map((l) => ({ city: l._id.city, country: l._id.country, count: l.count })),
      stats: {
        qrCount: qrCodes.length,
        activeQrCount: qrCodes.filter((q) => q.status === "active" && q.isActive !== false).length,
        totalScans: qrCodes.reduce((sum, q) => sum + (q.scanCount || 0), 0),
        scansLast30: scanSeries.reduce((sum, d) => sum + d.value, 0),
        lastScanAt: lastScan?.scannedAt || null,
        lifetimeSpendInr: completed.reduce((sum, t) => sum + toInr(t), 0),
        paymentsCount: completed.length,
      },
      usdToInr,
    });
  } catch (err) {
    console.error("Admin getUser error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PATCH /api/admin/users/:id/status
 * Body: { status: "active" | "block" }
 */
export const updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "block"].includes(status)) {
      return res.status(400).json({ message: "Status must be 'active' or 'block'" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, select: "-password -refreshToken" }
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    return res.json({ message: `User ${status === "block" ? "blocked" : "unblocked"} successfully`, user });
  } catch (err) {
    console.error("Admin updateUserStatus error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PATCH /api/admin/users/:id/plan
 * Body: { plan, planExpiresAt? }  — paid plans require a future expiry date.
 */
export const updateUserPlan = async (req, res) => {
  try {
    const { plan, planExpiresAt } = req.body;
    if (!PLANS.includes(plan)) {
      return res.status(400).json({ message: "Invalid plan" });
    }

    let expiry = null;
    if (plan !== "free") {
      expiry = planExpiresAt ? new Date(planExpiresAt) : null;
      if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
        return res.status(400).json({ message: "Paid plans need a future expiry date" });
      }
    }

    const previous = await User.findById(req.params.id).select("plan planExpiresAt planLapsedAt").lean();
    if (!previous) return res.status(404).json({ message: "User not found" });

    // Downgrading a paid account starts the same grace period as an unrenewed plan.
    const graceFields =
      plan !== "free"
        ? { planLapsedAt: null, qrPauseNotifSent: false }
        : previous.plan !== "free"
          ? { planLapsedAt: lapsedAtOf(previous) || new Date(), qrPauseNotifSent: false }
          : {};

    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        plan,
        planExpiresAt: expiry,
        planExpiryWarningSent: false,
        planExpiredNotifSent: false,
        ...graceFields,
      },
      { new: true, select: USER_SAFE_FIELDS }
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const id = user._id.toString();
    await Promise.all([
      delCache(`sub:active:${id}`),
      delCache(`sub:history:${id}`),
      delCache(`user:profile:${id}`),
    ]);
    await syncPlanPause(user._id).catch((err) => console.error("Plan pause sync failed:", err.message));

    return res.json({ message: "Plan updated", user });
  } catch (err) {
    console.error("Admin updateUserPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * PATCH /api/admin/users/:id/seats
 * Body: { extraSeats }  — Agency only, 0..teamMaxExtraSeats(), not below seats already in use.
 */
export const updateUserSeats = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "User not found" });
    }
    const extraSeats = Number(req.body.extraSeats);
    const maxExtra = teamMaxExtraSeats();
    if (!Number.isInteger(extraSeats) || extraSeats < 0 || extraSeats > maxExtra) {
      return res.status(400).json({ message: `Extra seats must be a whole number from 0 to ${maxExtra}` });
    }

    const user = await User.findById(req.params.id).select("plan teamOwner");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.teamOwner) return res.status(400).json({ message: "This user is a team member, not an account owner" });
    if (user.plan !== "agency") return res.status(400).json({ message: "Extra seats are only for Agency accounts" });

    const [members, invites] = await Promise.all([
      User.countDocuments({ teamOwner: user._id }),
      TeamInvite.countDocuments({ owner: user._id, status: "pending", expiresAt: { $gt: new Date() } }),
    ]);
    const minExtra = Math.max(0, members + invites - teamBaseSeats());
    if (extraSeats < minExtra) {
      return res.status(409).json({
        message: `${members + invites} seats are in use. The minimum is ${minExtra} extra seat${minExtra === 1 ? "" : "s"}.`,
      });
    }

    const updated = await User.findByIdAndUpdate(user._id, { extraSeats }, { new: true, select: USER_SAFE_FIELDS });
    const id = user._id.toString();
    await Promise.all([delCache(`sub:active:${id}`), delCache(`user:profile:${id}`)]);

    return res.json({ message: "Seats updated", user: updated });
  } catch (err) {
    console.error("Admin updateUserSeats error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * DELETE /api/admin/users/:id
 * Deletes user + all their QR codes
 */
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Delete related QR codes first
    await QRCode.deleteMany({ owner: user._id });
    await User.updateMany({ teamOwner: user._id }, { teamOwner: null, teamJoinedAt: null });
    await ClientAccount.deleteMany({ agency: user._id });
    await PaymentClaim.deleteMany({ agency: user._id });
    await AgencyPaymentSettings.deleteOne({ agency: user._id });
    await TeamInvite.deleteMany({ owner: user._id });
    await user.deleteOne();

    return res.json({ message: "User and all associated QR codes deleted successfully" });
  } catch (err) {
    console.error("Admin deleteUser error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
