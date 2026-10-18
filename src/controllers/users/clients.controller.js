import mongoose from "mongoose";
import ClientAccount from "../../models/ClientAccount.js";
import QRCode from "../../models/QRCode.js";
import { hasActivePaidPlan } from "../../utils/helpers.js";
import { qrScope, invalidateQrCaches } from "../../services/team.service.js";
import PaymentClaim from "../../models/PaymentClaim.js";
import AgencyPaymentSettings from "../../models/AgencyPaymentSettings.js";
import {
  BILLING_CURRENCIES,
  advanceDueDate,
  billingBlock,
  buildBillingSummary,
  normalizeCurrency,
  publicPaymentMethods,
  serializeClaim,
  validatePaymentMethods,
} from "../../services/clientBilling.service.js";
import { generateClientPassword } from "../../services/clientAuth.service.js";
import { sendClientLoginEmail } from "../../services/email.service.js";
import { delCache } from "../../utils/cache.js";
import { notifyOwnerOfStaffAction } from "../../services/agencyNotify.service.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_QRS_PER_CLIENT = 200;

const loginUrl = () => `${process.env.FRONTEND_URL || "http://localhost:3000"}/client/login`;

const agencyActive = (req) => req.account?.plan === "agency" && hasActivePaidPlan(req.account);

/** Owners manage every client of the agency; staff only the clients they created. */
const clientScope = (req) =>
  req.isStaff ? { agency: req.account._id, createdBy: req.user._id } : { agency: req.user._id };

const requireActiveAgency = (req, res) => {
  if (agencyActive(req)) return true;
  res.status(403).json({ code: "AGENCY_REQUIRED", message: "Client logins need an active Agency plan." });
  return false;
};

/** Team members can add clients, view them and reset passwords; everything else is owner-only. */
const requireOwner = (req, res) => {
  if (!req.isStaff) return true;
  res.status(403).json({ code: "STAFF_FORBIDDEN", message: "Only your agency owner can do this." });
  return false;
};

const blockInfo = (qrCodes) => {
  const qrs = (qrCodes || []).filter((q) => q && typeof q === "object" && "agencyBilling" in q && q.status === "active");
  const b = billingBlock(qrs);
  return { blocked: b.blocked, blockedSince: b.blockedSince, blocksOn: b.blocksOn, overdueAmount: b.overdueAmount };
};

const serializeClient = (c, pendingClaims = 0) => ({
  _id: c._id,
  name: c.name,
  email: c.email,
  status: c.status,
  billingCurrency: normalizeCurrency(c.billingCurrency),
  pendingClaims,
  billingBlock: blockInfo(c.qrCodes),
  lastLoginAt: c.lastLoginAt,
  createdAt: c.createdAt,
  createdBy: c.createdBy && typeof c.createdBy === "object" && "name" in c.createdBy
    ? { _id: c.createdBy._id, name: c.createdBy.name, email: c.createdBy.email }
    : null,
  qrCodes: (c.qrCodes || [])
    .filter((q) => q && typeof q === "object" && "businessName" in q)
    .map((q) => ({ _id: q._id, businessName: q.businessName, label: q.label, placeAddress: q.placeAddress, status: q.status })),
});

const loadClient = (req, id) =>
  mongoose.isValidObjectId(id) ? ClientAccount.findOne({ _id: id, ...clientScope(req) }) : null;

const populateClient = (query) =>
  query
    .populate("qrCodes", "businessName label placeAddress status agencyBilling.price agencyBilling.nextPaymentDate")
    .populate("createdBy", "name email");

/** Validates QR ids against what the requester may assign. Returns { ids } or { error }. */
const resolveQrIds = async (req, raw) => {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Choose at least one QR code for this client." };
  const unique = [...new Set(raw.map(String))];
  if (unique.length > MAX_QRS_PER_CLIENT) return { error: `A client can have at most ${MAX_QRS_PER_CLIENT} QR codes.` };
  if (!unique.every((id) => mongoose.isValidObjectId(id))) return { error: "Some QR codes are invalid." };

  const found = await QRCode.find({ _id: { $in: unique }, ...qrScope(req), status: "active" }).select("_id").lean();
  if (found.length !== unique.length) return { error: "Some QR codes don't exist or aren't yours to share." };
  return { ids: found.map((q) => q._id) };
};

const clearPortalCache = async (clientId) => {
  await Promise.all(["7d", "30d", "90d"].map((r) => delCache(`client:summary:v2:${clientId}:${r}`)));
};

const emailCredentials = async (req, client, password) => {
  try {
    await sendClientLoginEmail(client.email, {
      clientName: client.name,
      agencyName: req.account.businessName || req.account.name || "Your agency",
      email: client.email,
      password,
      loginLink: loginUrl(),
    });
    return true;
  } catch (err) {
    console.error("Client login email failed:", err.message);
    return false;
  }
};

// ─── GET /api/clients ─────────────────────────────────────────────────────────
export const listClients = async (req, res) => {
  try {
    const clients = await populateClient(ClientAccount.find(clientScope(req)).sort({ createdAt: -1 })).lean();
    const pending = await PaymentClaim.aggregate([
      { $match: { client: { $in: clients.map((c) => c._id) }, status: "pending" } },
      { $group: { _id: "$client", count: { $sum: 1 } } },
    ]);
    const pendingBy = new Map(pending.map((p) => [String(p._id), p.count]));
    return res.json({
      clients: clients.map((c) => serializeClient(c, pendingBy.get(String(c._id)) || 0)),
      canManage: agencyActive(req),
      canEdit: agencyActive(req) && !req.isStaff,
      loginUrl: loginUrl(),
    });
  } catch (err) {
    console.error("listClients error:", err);
    return res.status(500).json({ message: "Failed to load clients." });
  }
};

// ─── POST /api/clients  { name, email, qrCodeIds, sendEmail } ─────────────────
export const createClient = async (req, res) => {
  try {
    if (!requireActiveAgency(req, res)) return;

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!name) return res.status(400).json({ message: "Enter the client's name." });
    if (name.length > 120) return res.status(400).json({ message: "Name is too long." });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: "Enter a valid email address." });

    const { ids, error } = await resolveQrIds(req, req.body.qrCodeIds);
    if (error) return res.status(400).json({ message: error });

    if (await ClientAccount.exists({ email })) {
      return res.status(409).json({ message: "This email already has a client login. Use a different email." });
    }

    const password = generateClientPassword();
    let client;
    try {
      client = await ClientAccount.create({
        agency: req.account._id,
        createdBy: req.user._id,
        name,
        email,
        password,
        qrCodes: ids,
      });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ message: "This email already has a client login. Use a different email." });
      }
      throw err;
    }

    const emailed = req.body.sendEmail ? await emailCredentials(req, client, password) : false;
    const saved = await populateClient(ClientAccount.findById(client._id)).lean();

    notifyOwnerOfStaffAction(req, {
      title: "Your team added a client",
      summary: "added a new client login.",
      details: [
        ["Client", name],
        ["Email", email],
        ["QR codes", (saved.qrCodes || []).map((q) => q.businessName).join(", ")],
      ],
      path: `/dashboard/clients/${client._id}`,
      linkText: "View client",
    });

    return res.status(201).json({
      message: emailed ? `Client login created and emailed to ${email}.` : "Client login created.",
      client: serializeClient(saved),
      password,
      emailed,
      loginUrl: loginUrl(),
    });
  } catch (err) {
    console.error("createClient error:", err);
    return res.status(500).json({ message: "Failed to create client login." });
  }
};

// ─── PATCH /api/clients/:id  { name?, qrCodeIds?, status? } ───────────────────
export const updateClient = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });

    const { name, qrCodeIds, status, billingCurrency } = req.body;

    if (billingCurrency !== undefined) {
      if (!BILLING_CURRENCIES.includes(billingCurrency)) return res.status(400).json({ message: "Unsupported currency." });
      client.billingCurrency = billingCurrency;
    }

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed || trimmed.length > 120) return res.status(400).json({ message: "Enter a valid name." });
      client.name = trimmed;
    }

    if (qrCodeIds !== undefined) {
      if (!requireActiveAgency(req, res)) return;
      const { ids, error } = await resolveQrIds(req, qrCodeIds);
      if (error) return res.status(400).json({ message: error });
      client.qrCodes = ids;
    }

    if (status !== undefined) {
      if (!["active", "disabled"].includes(status)) return res.status(400).json({ message: "Invalid status." });
      if (status === "active" && client.status !== "active" && !requireActiveAgency(req, res)) return;
      if (status !== client.status) {
        client.status = status;
        if (status === "disabled") client.tokenVersion = (client.tokenVersion || 0) + 1;
      }
    }

    await client.save();
    await clearPortalCache(client._id);
    const saved = await populateClient(ClientAccount.findById(client._id)).lean();
    return res.json({ message: "Client updated.", client: serializeClient(saved) });
  } catch (err) {
    console.error("updateClient error:", err);
    return res.status(500).json({ message: "Failed to update client." });
  }
};

// ─── POST /api/clients/:id/reset-password  { sendEmail } ─────────────────────
export const resetClientPassword = async (req, res) => {
  try {
    if (!requireActiveAgency(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });

    const password = generateClientPassword();
    client.password = password;
    client.tokenVersion = (client.tokenVersion || 0) + 1;
    await client.save();

    const emailed = req.body?.sendEmail ? await emailCredentials(req, client, password) : false;
    return res.json({
      message: emailed ? `New password emailed to ${client.email}.` : "New password generated.",
      password,
      emailed,
      loginUrl: loginUrl(),
    });
  } catch (err) {
    console.error("resetClientPassword error:", err);
    return res.status(500).json({ message: "Failed to reset password." });
  }
};

// ─── DELETE /api/clients/:id ──────────────────────────────────────────────────
export const deleteClient = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });
    await client.deleteOne();
    await PaymentClaim.deleteMany({ client: client._id });
    await clearPortalCache(client._id);
    return res.json({ message: `${client.name}'s login was deleted.` });
  } catch (err) {
    console.error("deleteClient error:", err);
    return res.status(500).json({ message: "Failed to delete client." });
  }
};

// ─── Billing (stored per QR in QRCode.agencyBilling) ─────────────────────────
const MAX_AMOUNT = 100000000;
const PLAN_TYPES = ["monthly", "yearly", "none"];

const clientQrDocs = (req, client) =>
  QRCode.find({ _id: { $in: client.qrCodes }, ...qrScope(req), status: "active" })
    .select("businessName placeAddress agencyBilling createdBy")
    .lean();

const billingFor = async (req, client) => buildBillingSummary(await clientQrDocs(req, client), client.billingCurrency);

const claimsFor = async (clientId, qrDocs) => {
  const names = new Map(qrDocs.map((q) => [String(q._id), q.businessName]));
  const claims = await PaymentClaim.find({ client: clientId }).sort({ status: 1, createdAt: -1 }).limit(50).lean();
  return claims
    .sort((a, b) => (a.status === "pending") === (b.status === "pending") ? b.createdAt - a.createdAt : a.status === "pending" ? -1 : 1)
    .map((c) => serializeClaim(c, names.get(String(c.qrCode))));
};

/** A QR the client can see and the requester may bill. */
const loadClientQr = async (req, client, qrId) => {
  if (!mongoose.isValidObjectId(qrId) || !client.qrCodes.some((id) => String(id) === String(qrId))) return null;
  return QRCode.findOne({ _id: qrId, ...qrScope(req), status: "active" });
};

const parseDate = (value) => {
  if (value === null || value === "") return { date: null };
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? { error: true } : { date: d };
};

// ─── GET /api/clients/:id ─────────────────────────────────────────────────────
export const getClient = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Client not found." });
    const client = await populateClient(ClientAccount.findOne({ _id: req.params.id, ...clientScope(req) })).lean();
    if (!client) return res.status(404).json({ message: "Client not found." });

    const qrIds = (client.qrCodes || []).map((q) => q?._id || q);
    const qrDocs = await clientQrDocs(req, { qrCodes: qrIds });
    const claims = await claimsFor(client._id, qrDocs);
    return res.json({
      client: serializeClient(client, claims.filter((c) => c.status === "pending").length),
      billing: buildBillingSummary(qrDocs, client.billingCurrency),
      claims,
      canManage: agencyActive(req),
      canEdit: agencyActive(req) && !req.isStaff,
      loginUrl: loginUrl(),
    });
  } catch (err) {
    console.error("getClient error:", err);
    return res.status(500).json({ message: "Failed to load client." });
  }
};

// ─── PATCH /api/clients/:id/billing/:qrId  { planType?, price?, nextPaymentDate? } ──
export const updateClientBilling = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    if (!requireActiveAgency(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });
    const qr = await loadClientQr(req, client, req.params.qrId);
    if (!qr) return res.status(404).json({ message: "This QR code isn't shared with this client." });

    const { planType, price, nextPaymentDate } = req.body;
    if (planType !== undefined) {
      if (!PLAN_TYPES.includes(planType)) return res.status(400).json({ message: "Invalid plan type." });
      qr.agencyBilling.planType = planType;
    }
    if (price !== undefined) {
      const n = Number(price);
      if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return res.status(400).json({ message: "Enter a valid amount." });
      qr.agencyBilling.price = Math.round(n * 100) / 100;
    }
    if (nextPaymentDate !== undefined) {
      const { date, error } = parseDate(nextPaymentDate);
      if (error) return res.status(400).json({ message: "Enter a valid due date." });
      qr.agencyBilling.nextPaymentDate = date;
    }

    await qr.save();
    await invalidateQrCaches(req, { qrId: qr._id, createdBy: qr.createdBy });
    return res.json({ message: "Billing updated.", billing: await billingFor(req, client) });
  } catch (err) {
    console.error("updateClientBilling error:", err);
    return res.status(500).json({ message: "Failed to update billing." });
  }
};

// ─── POST /api/clients/:id/payments  { qrId, amount, date?, notes?, advanceDueDate? } ──
export const recordClientPayment = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    if (!requireActiveAgency(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });
    const qr = await loadClientQr(req, client, req.body.qrId);
    if (!qr) return res.status(404).json({ message: "Pick a QR code shared with this client." });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      return res.status(400).json({ message: "Enter a valid amount." });
    }
    const { date, error } = parseDate(req.body.date ?? new Date().toISOString());
    if (error || !date) return res.status(400).json({ message: "Enter a valid payment date." });
    if (date.getTime() > Date.now() + 86400000) return res.status(400).json({ message: "Payment date can't be in the future." });
    const notes = String(req.body.notes || "").trim().slice(0, 200);

    qr.agencyBilling.history.push({ amount: Math.round(amount * 100) / 100, date, notes });

    let advanced = false;
    if (req.body.advanceDueDate && qr.agencyBilling.planType !== "none") {
      qr.agencyBilling.nextPaymentDate = advanceDueDate(qr.agencyBilling.nextPaymentDate || date, qr.agencyBilling.planType);
      advanced = true;
    }

    await qr.save();
    await invalidateQrCaches(req, { qrId: qr._id, createdBy: qr.createdBy });
    return res.status(201).json({
      message: advanced ? "Payment recorded and next due date moved forward." : "Payment recorded.",
      billing: await billingFor(req, client),
    });
  } catch (err) {
    console.error("recordClientPayment error:", err);
    return res.status(500).json({ message: "Failed to record payment." });
  }
};

// ─── DELETE /api/clients/:id/payments/:qrId/:paymentId ───────────────────────
export const deleteClientPayment = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    if (!requireActiveAgency(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });
    const qr = await loadClientQr(req, client, req.params.qrId);
    if (!qr) return res.status(404).json({ message: "QR code not found." });

    const payment = mongoose.isValidObjectId(req.params.paymentId) ? qr.agencyBilling.history.id(req.params.paymentId) : null;
    if (!payment) return res.status(404).json({ message: "Payment not found." });
    payment.deleteOne();

    await qr.save();
    await invalidateQrCaches(req, { qrId: qr._id, createdBy: qr.createdBy });
    return res.json({ message: "Payment deleted.", billing: await billingFor(req, client) });
  } catch (err) {
    console.error("deleteClientPayment error:", err);
    return res.status(500).json({ message: "Failed to delete payment." });
  }
};

// ─── Payment methods (how clients pay the agency) ────────────────────────────
// GET /api/clients/payment-methods
export const getPaymentMethods = async (req, res) => {
  try {
    const settings = await AgencyPaymentSettings.findOne({ agency: req.account._id }).lean();
    return res.json({ methods: publicPaymentMethods(settings), canEdit: !req.isStaff && agencyActive(req) });
  } catch (err) {
    console.error("getPaymentMethods error:", err);
    return res.status(500).json({ message: "Failed to load payment methods." });
  }
};

// PUT /api/clients/payment-methods  { upiId, upiName, paymentLink, paymentLinkLabel, paypalMe, bankDetails, instructions }
export const updatePaymentMethods = async (req, res) => {
  try {
    if (req.isStaff) return res.status(403).json({ code: "STAFF_FORBIDDEN", message: "Only your agency owner can change payment methods." });
    if (!requireActiveAgency(req, res)) return;
    const { value, error } = validatePaymentMethods(req.body);
    if (error) return res.status(400).json({ message: error });

    const settings = await AgencyPaymentSettings.findOneAndUpdate(
      { agency: req.account._id },
      { $set: value },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return res.json({ message: "Payment methods saved.", methods: publicPaymentMethods(settings) });
  } catch (err) {
    console.error("updatePaymentMethods error:", err);
    return res.status(500).json({ message: "Failed to save payment methods." });
  }
};

// ─── Payment claims ("I've paid" from the client portal) ─────────────────────
const METHOD_LABEL = { upi: "UPI", link: "Online payment", paypal: "PayPal", bank: "Bank transfer", other: "Other" };

// POST /api/clients/:id/claims/:claimId/confirm  { amount?, advanceDueDate? }
export const confirmClaim = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    if (!requireActiveAgency(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });
    if (!mongoose.isValidObjectId(req.params.claimId)) return res.status(404).json({ message: "Payment claim not found." });

    const pendingClaim = await PaymentClaim.findOne({ _id: req.params.claimId, client: client._id, status: "pending" });
    if (!pendingClaim) return res.status(404).json({ message: "This payment was already handled." });
    const qr = await loadClientQr(req, client, pendingClaim.qrCode);
    if (!qr) return res.status(404).json({ message: "The QR code for this payment is no longer shared with this client." });

    const raw = req.body.amount !== undefined ? Number(req.body.amount) : pendingClaim.amount;
    if (!Number.isFinite(raw) || raw <= 0 || raw > MAX_AMOUNT) return res.status(400).json({ message: "Enter a valid amount." });
    const amount = Math.round(raw * 100) / 100;

    // Flip status first so a double click can't record the payment twice.
    const claim = await PaymentClaim.findOneAndUpdate(
      { _id: pendingClaim._id, status: "pending" },
      { $set: { status: "confirmed", amount, reviewedBy: req.user._id, reviewedAt: new Date() } },
      { new: true }
    );
    if (!claim) return res.status(409).json({ message: "This payment was already handled." });

    const notes = [`Paid via ${METHOD_LABEL[claim.method] || "client"}`, claim.reference && `Ref ${claim.reference}`]
      .filter(Boolean).join(" · ").slice(0, 200);
    qr.agencyBilling.history.push({ amount, date: claim.paidAt, notes });
    claim.paymentId = qr.agencyBilling.history[qr.agencyBilling.history.length - 1]._id;

    let advanced = false;
    if (req.body.advanceDueDate && qr.agencyBilling.planType !== "none") {
      qr.agencyBilling.nextPaymentDate = advanceDueDate(qr.agencyBilling.nextPaymentDate || claim.paidAt, qr.agencyBilling.planType);
      advanced = true;
    }

    try {
      await qr.save();
    } catch (err) {
      await PaymentClaim.updateOne({ _id: claim._id }, { $set: { status: "pending", reviewedBy: null, reviewedAt: null } });
      throw err;
    }
    await claim.save();
    await invalidateQrCaches(req, { qrId: qr._id, createdBy: qr.createdBy });

    return res.json({
      message: advanced ? "Payment confirmed and next due date moved forward." : "Payment confirmed and recorded.",
      billing: await billingFor(req, client),
    });
  } catch (err) {
    console.error("confirmClaim error:", err);
    return res.status(500).json({ message: "Failed to confirm payment." });
  }
};

// POST /api/clients/:id/claims/:claimId/reject  { reason? }
export const rejectClaim = async (req, res) => {
  try {
    if (!requireOwner(req, res)) return;
    if (!requireActiveAgency(req, res)) return;
    const client = await loadClient(req, req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found." });
    if (!mongoose.isValidObjectId(req.params.claimId)) return res.status(404).json({ message: "Payment claim not found." });

    const claim = await PaymentClaim.findOneAndUpdate(
      { _id: req.params.claimId, client: client._id, status: "pending" },
      {
        $set: {
          status: "rejected",
          rejectReason: String(req.body.reason || "").trim().slice(0, 200),
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
        },
      },
      { new: true }
    );
    if (!claim) return res.status(404).json({ message: "This payment was already handled." });
    return res.json({ message: "Payment marked as not received." });
  } catch (err) {
    console.error("rejectClaim error:", err);
    return res.status(500).json({ message: "Failed to update payment." });
  }
};
