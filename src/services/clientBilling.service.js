// Billing an agency records for its clients lives on each QR (QRCode.agencyBilling).
// Shared by the agency client-details page and the client portal so both show the same numbers.

const DAY_MS = 86400000;
const DUE_SOON_DAYS = 7;
/** A client's dashboard is blocked once any paid plan is this many days past its due date. */
export const BLOCK_AFTER_DAYS = 15;

export const BILLING_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AUD", "CAD", "AED", "SGD"];
export const normalizeCurrency = (c) => (BILLING_CURRENCIES.includes(c) ? c : "INR");

export const formatMoney = (n, currency = "INR") => {
  const code = normalizeCurrency(currency);
  return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", { style: "currency", currency: code, maximumFractionDigits: 2 }).format(Number(n) || 0);
};

// ─── Agency payment methods ───────────────────────────────────────────────────
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const PAYPAL_RE = /^[a-zA-Z0-9]{1,20}$/;

/** Accepts "name", "paypal.me/name" or the full URL. */
const paypalHandle = (raw) =>
  String(raw || "").trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?paypal\.me\//i, "").replace(/\/.*$/, "");

export const PAYMENT_METHOD_FIELDS = ["upiId", "upiName", "paymentLink", "paymentLinkLabel", "paypalMe", "bankDetails", "instructions"];

/** Returns { value } with cleaned fields, or { error }. */
export const validatePaymentMethods = (body = {}) => {
  const v = {};
  for (const f of PAYMENT_METHOD_FIELDS) v[f] = String(body[f] ?? "").trim();

  if (v.upiId && !UPI_RE.test(v.upiId)) return { error: "Enter a valid UPI ID, like yourname@okhdfcbank." };
  if (v.upiName.length > 60) return { error: "UPI payee name is too long." };

  if (v.paymentLink) {
    let url;
    try { url = new URL(v.paymentLink); } catch { return { error: "Enter a full payment link starting with https://" }; }
    if (url.protocol !== "https:") return { error: "The payment link must start with https://" };
    if (v.paymentLink.length > 500) return { error: "The payment link is too long." };
  }
  if (v.paymentLinkLabel.length > 40) return { error: "Button label is too long (max 40 characters)." };

  if (v.paypalMe) {
    v.paypalMe = paypalHandle(v.paypalMe);
    if (!PAYPAL_RE.test(v.paypalMe)) return { error: "Enter your PayPal.me username, like paypal.me/youragency." };
  }
  if (v.bankDetails.length > 1000) return { error: "Bank details are too long (max 1000 characters)." };
  if (v.instructions.length > 500) return { error: "Instructions are too long (max 500 characters)." };
  return { value: v };
};

export const publicPaymentMethods = (s) => {
  const methods = {
    upiId: s?.upiId || "",
    upiName: s?.upiName || "",
    paymentLink: s?.paymentLink || "",
    paymentLinkLabel: s?.paymentLinkLabel || "",
    paypalMe: s?.paypalMe || "",
    bankDetails: s?.bankDetails || "",
    instructions: s?.instructions || "",
  };
  return { ...methods, hasAny: Boolean(methods.upiId || methods.paymentLink || methods.paypalMe || methods.bankDetails) };
};

export const CLAIM_METHODS = ["upi", "link", "paypal", "bank", "other"];

export const serializeClaim = (c, businessName) => ({
  id: c._id,
  qrId: c.qrCode,
  businessName: businessName || "",
  amount: c.amount,
  currency: c.currency,
  method: c.method,
  reference: c.reference,
  note: c.note,
  paidAt: c.paidAt,
  status: c.status,
  rejectReason: c.rejectReason,
  createdAt: c.createdAt,
  reviewedAt: c.reviewedAt,
});

export const billingStatus = (billing, now = Date.now()) => {
  const hasPlan = billing.planType !== "none" || billing.price > 0;
  if (!billing.nextPaymentDate) return { status: hasPlan ? "no_date" : "none", daysUntilDue: null };
  const daysUntilDue = Math.ceil((new Date(billing.nextPaymentDate).getTime() - now) / DAY_MS);
  if (daysUntilDue < 0) return { status: "overdue", daysUntilDue };
  if (daysUntilDue <= DUE_SOON_DAYS) return { status: "due_soon", daysUntilDue };
  return { status: "upcoming", daysUntilDue };
};

/** Moves a due date forward by one billing period. */
export const advanceDueDate = (from, planType) => {
  const d = new Date(from);
  if (planType === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
};

/**
 * Overdue-payment block for a client, from its QRs' agencyBilling.
 * Unblocks by itself once the overdue dates are moved forward (payment recorded / confirmed).
 */
export const billingBlock = (qrCodes, now = Date.now()) => {
  const overdue = qrCodes
    .map((q) => ({
      businessName: q.businessName,
      price: Number(q.agencyBilling?.price) || 0,
      due: q.agencyBilling?.nextPaymentDate ? new Date(q.agencyBilling.nextPaymentDate).getTime() : null,
    }))
    .filter((p) => p.due !== null && p.price > 0 && p.due < now);

  const blockAt = (p) => p.due + BLOCK_AFTER_DAYS * DAY_MS;
  const blocking = overdue.filter((p) => blockAt(p) <= now);
  const earliest = (list) => list.reduce((min, p) => Math.min(min, blockAt(p)), Infinity);

  return {
    blockAfterDays: BLOCK_AFTER_DAYS,
    blocked: blocking.length > 0,
    blockedSince: blocking.length ? new Date(earliest(blocking)) : null,
    blocksOn: !blocking.length && overdue.length ? new Date(earliest(overdue)) : null,
    overdueAmount: overdue.reduce((s, p) => s + p.price, 0),
    overdueLocations: overdue.map((p) => p.businessName),
  };
};

/** @param qrCodes lean QR docs with businessName, placeAddress, agencyBilling */
export const buildBillingSummary = (qrCodes, currency = "INR") => {
  const now = Date.now();

  const plans = qrCodes.map((q) => {
    const billing = {
      planType: q.agencyBilling?.planType || "none",
      price: Number(q.agencyBilling?.price) || 0,
      nextPaymentDate: q.agencyBilling?.nextPaymentDate || null,
    };
    const history = q.agencyBilling?.history || [];
    const lastPayment = history.reduce((latest, p) => (!latest || new Date(p.date) > new Date(latest.date) ? p : latest), null);
    return {
      id: q._id,
      businessName: q.businessName,
      placeAddress: q.placeAddress,
      ...billing,
      ...billingStatus(billing, now),
      totalPaid: history.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
      paymentsCount: history.length,
      lastPaymentAt: lastPayment?.date || null,
    };
  });

  const payments = qrCodes
    .flatMap((q) =>
      (q.agencyBilling?.history || []).map((p) => ({
        id: p._id,
        qrId: q._id,
        businessName: q.businessName,
        amount: Number(p.amount) || 0,
        date: p.date,
        notes: p.notes || "",
      }))
    )
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const due = plans.filter((p) => p.status === "overdue" || p.status === "due_soon");
  const overdue = plans.filter((p) => p.status === "overdue");
  const nextDue = plans
    .filter((p) => p.nextPaymentDate)
    .sort((a, b) => new Date(a.nextPaymentDate) - new Date(b.nextPaymentDate))[0];
  const yearStart = new Date(new Date().getFullYear(), 0, 1);

  return {
    currency: normalizeCurrency(currency),
    totals: {
      totalPaid: payments.reduce((s, p) => s + p.amount, 0),
      paidThisYear: payments.filter((p) => new Date(p.date) >= yearStart).reduce((s, p) => s + p.amount, 0),
      paymentsCount: payments.length,
      amountDue: due.reduce((s, p) => s + p.price, 0),
      overdueAmount: overdue.reduce((s, p) => s + p.price, 0),
      overdueCount: overdue.length,
      nextDue: nextDue
        ? { date: nextDue.nextPaymentDate, amount: nextDue.price, businessName: nextDue.businessName, status: nextDue.status }
        : null,
      lastPayment: payments[0] || null,
    },
    block: billingBlock(qrCodes, now),
    plans,
    payments,
  };
};
