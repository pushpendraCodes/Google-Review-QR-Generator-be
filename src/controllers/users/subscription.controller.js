import crypto from "crypto";
import Razorpay from "razorpay";
import Transaction from "../../models/Transaction.js";
import User from "../../models/User.js";
import {
    getPlanExpiry,
    hasActivePaidPlan,
    PLAN_PRICES,
    PLAN_PRICES_USD,
    getPaymentRegion,
    resolveCheckoutCurrency,
    teamMaxExtraSeats,
    SEAT_PRICE_MONTHLY,
    seatRenewalAmount,
    proratedSeatAmount,
} from "../../utils/helpers.js";
import { getPublicPricing } from "../../services/pricing.service.js";
import { extraSeatsOf } from "../../services/team.service.js";
import { syncPlanPause } from "../../services/planGrace.service.js";
import { getCache, setCache, delCache } from "../../utils/cache.js";
import {
    createLemonCheckout,
    getLemonOrder,
    findLemonOrdersByEmail,
    getLemonVariantId,
    getLemonSeatVariantId,
    getPlanFromVariantId,
    isLemonSqueezyConfigured,
} from "../../services/lemonSqueezy.service.js";

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const VALID_PLANS = ["starter", "pro", "agency"];
const VALID_CYCLES = ["monthly", "annual"];

const invalidateSubscriptionCaches = async (userId) => {
    const id = userId.toString();
    await delCache(`sub:active:${id}`);
    await delCache(`sub:history:${id}`);
    await delCache(`user:profile:${id}`);
};

/** Adds purchased seats to the owner (capped). Call once per completed seats transaction. */
const applySeatPurchase = async (tx) => {
    const user = await User.findById(tx.user).select("extraSeats");
    if (!user) return;
    const next = Math.min(teamMaxExtraSeats(), extraSeatsOf(user) + Math.max(0, tx.seats || 0));
    await User.updateOne({ _id: tx.user }, { extraSeats: next });
    await invalidateSubscriptionCaches(tx.user);
};

const activateUserPlan = async (tx) => {
    if (tx.kind === "seats") return applySeatPurchase(tx);

    const update = {
        plan: tx.plan,
        planExpiresAt: getPlanExpiry(tx.billingCycle),
        planExpiryWarningSent: false,
        planExpiredNotifSent: false,
        planLapsedAt: null,
        qrPauseNotifSent: false,
    };
    // Agency renewals carry the seats that were paid for; other plans have no team.
    if (tx.plan !== "agency") update.extraSeats = 0;
    else if (typeof tx.seats === "number") update.extraSeats = Math.min(teamMaxExtraSeats(), tx.seats);

    await User.findByIdAndUpdate(tx.user, update);
    await invalidateSubscriptionCaches(tx.user);
    await syncPlanPause(tx.user).catch((err) => console.error("Resume paused QRs failed:", err.message));
};

/** Extra seats to bill on an Agency purchase/renewal. */
const seatsForPlanPurchase = (user, plan) => (plan === "agency" ? extraSeatsOf(user) : 0);

const assertValidPlanRequest = (plan, billingCycle) => {
    if (!VALID_PLANS.includes(plan)) return "Invalid plan.";
    if (!VALID_CYCLES.includes(billingCycle)) return "Invalid billing cycle.";
    return null;
};

const assertNoDuplicateActivePlan = (user, plan) => {
    if (
        user.plan === plan &&
        user.planExpiresAt &&
        new Date(user.planExpiresAt) > new Date()
    ) {
        return "You already have an active subscription for this plan.";
    }
    return null;
};

/**
 * Mark Lemon order paid and activate the user plan.
 * Used by both the webhook and the client-side verify-on-return path
 * (webhooks cannot reach localhost in development).
 */
const completeLemonOrder = async ({
    userId,
    plan,
    billingCycle,
    orderId,
    checkoutId,
    seats,
    webhookVerified = false,
}) => {
    const orderIdStr = String(orderId);

    const alreadyDone = await Transaction.findOne({
        transactionId: orderIdStr,
        status: "completed",
    });
    if (alreadyDone) {
        // Idempotent: ensure user plan is active even if a prior step only marked the tx.
        // Seat purchases add seats, so they must never be applied twice.
        if (alreadyDone.kind !== "seats") await activateUserPlan(alreadyDone);
        return { tx: alreadyDone, activated: true, alreadyCompleted: true };
    }

    const pendingFilter = {
        user: userId,
        plan,
        billingCycle,
        kind: { $ne: "seats" },
        paymentProvider: "lemon_squeezy",
        status: { $in: ["pending", "failed"] },
    };
    if (checkoutId) {
        pendingFilter.lemonSqueezyCheckoutId = String(checkoutId);
    }

    let tx = await Transaction.findOne(pendingFilter).sort({ createdAt: -1 });

    if (tx) {
        tx.status = "completed";
        tx.transactionId = orderIdStr;
        tx.purchaseDate = new Date();
        tx.webhookVerified = webhookVerified;
        await tx.save();
        await activateUserPlan(tx);
        return { tx, activated: true, alreadyCompleted: false };
    }

    const fallbackSeats = plan === "agency" && Number.isInteger(seats) ? seats : undefined;
    const amount = (PLAN_PRICES_USD[plan]?.[billingCycle] ?? 0) + seatRenewalAmount(fallbackSeats, billingCycle, "USD");
    tx = await Transaction.create({
        user: userId,
        plan,
        seats: fallbackSeats,
        amount,
        originalAmount: amount,
        billingCycle,
        paymentProvider: "lemon_squeezy",
        currency: "USD",
        razorpayOrderId: `lemon_${orderIdStr}`,
        lemonSqueezyCheckoutId: checkoutId
            ? String(checkoutId)
            : `order_${orderIdStr}`,
        transactionId: orderIdStr,
        status: "completed",
        purchaseDate: new Date(),
        webhookVerified,
    });
    await activateUserPlan(tx);
    return { tx, activated: true, alreadyCompleted: false };
};

const isDuplicateKeyError = (err) => err?.code === 11000;

/**
 * Mark a Lemon seat order paid and add the seats exactly once.
 * The unique transactionId makes concurrent webhook + redirect calls safe.
 */
const completeLemonSeatOrder = async ({ userId, orderId, checkoutId, seats, webhookVerified = false }) => {
    const orderIdStr = String(orderId);

    const alreadyDone = await Transaction.findOne({ transactionId: orderIdStr, status: "completed" });
    if (alreadyDone) return { tx: alreadyDone, alreadyCompleted: true };

    const pendingFilter = {
        user: userId,
        kind: "seats",
        paymentProvider: "lemon_squeezy",
        status: { $in: ["pending", "failed"] },
    };
    if (checkoutId) pendingFilter.lemonSqueezyCheckoutId = String(checkoutId);
    else if (Number.isInteger(seats)) pendingFilter.seats = seats;

    try {
        let tx = await Transaction.findOneAndUpdate(
            pendingFilter,
            { status: "completed", transactionId: orderIdStr, purchaseDate: new Date(), webhookVerified },
            { new: true, sort: { createdAt: -1 } }
        );

        if (!tx) {
            if (!Number.isInteger(seats) || seats < 1) return { tx: null, alreadyCompleted: false };
            const user = await User.findById(userId).select("planExpiresAt");
            const { amount } = proratedSeatAmount(seats, user?.planExpiresAt, "USD");
            tx = await Transaction.create({
                user: userId,
                plan: "agency",
                kind: "seats",
                seats,
                amount,
                originalAmount: amount,
                billingCycle: "monthly",
                paymentProvider: "lemon_squeezy",
                currency: "USD",
                razorpayOrderId: `lemon_${orderIdStr}`,
                lemonSqueezyCheckoutId: `order_${orderIdStr}`,
                transactionId: orderIdStr,
                status: "completed",
                purchaseDate: new Date(),
                webhookVerified,
            });
        }

        await applySeatPurchase(tx);
        return { tx, alreadyCompleted: false };
    } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const tx = await Transaction.findOne({ transactionId: orderIdStr });
        return { tx, alreadyCompleted: true };
    }
};

/** Validates a seat purchase for an owner. Returns { error, status } or the quote. */
const buildSeatQuote = (user, rawSeats, currency) => {
    if (user.plan !== "agency" || !hasActivePaidPlan(user)) {
        return { status: 403, error: "Extra seats need an active Agency plan." };
    }
    const current = extraSeatsOf(user);
    const maxExtra = teamMaxExtraSeats();
    const available = maxExtra - current;
    if (available <= 0) {
        return { status: 400, error: `You already have the maximum of ${maxExtra} extra seats.` };
    }
    const seats = Number(rawSeats);
    if (!Number.isInteger(seats) || seats < 1 || seats > available) {
        return { status: 400, error: `Choose between 1 and ${available} seat${available === 1 ? "" : "s"}.` };
    }
    const { amount, days } = proratedSeatAmount(seats, user.planExpiresAt, currency);
    return {
        seats,
        currency,
        amount,
        days,
        perSeatMonthly: SEAT_PRICE_MONTHLY[currency],
        currentExtraSeats: current,
        planExpiresAt: user.planExpiresAt,
    };
};

// ─── Extra team seats ────────────────────────────────────────────────────────
// GET /api/team/seats/quote?seats=2&currency=INR
export const getSeatQuote = async (req, res) => {
    try {
        const currency = resolveCheckoutCurrency(req, req.query.currency);
        const user = await User.findById(req.user._id).select("plan planExpiresAt extraSeats");
        const quote = buildSeatQuote(user, req.query.seats, currency);
        if (quote.error) return res.status(quote.status).json({ message: quote.error });
        res.json(quote);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/team/seats/checkout  { seats, currency }
export const createSeatCheckout = async (req, res) => {
    try {
        const currency = resolveCheckoutCurrency(req, req.body?.currency);
        const userId = req.user._id;
        const user = await User.findById(userId).select("email plan planExpiresAt extraSeats");
        const quote = buildSeatQuote(user, req.body?.seats, currency);
        if (quote.error) return res.status(quote.status).json({ message: quote.error });

        const { seats, amount } = quote;
        const label = `${seats} extra team seat${seats === 1 ? "" : "s"}`;

        if (currency === "INR") {
            const rpOrder = await razorpay.orders.create({
                amount,
                currency: "INR",
                receipt: `seat_${userId.toString().slice(-6)}_${Date.now()}`,
                notes: { kind: "seats", seats: String(seats) },
            });
            await Transaction.create({
                user: userId,
                plan: "agency",
                kind: "seats",
                seats,
                amount,
                originalAmount: amount,
                billingCycle: "monthly",
                paymentProvider: "razorpay",
                currency: "INR",
                razorpayOrderId: rpOrder.id,
                idempotencyKey: `seats_${userId}_${rpOrder.id}`,
                status: "pending",
            });
            return res.json({
                provider: "razorpay",
                razorpayOrderId: rpOrder.id,
                amount,
                currency: "INR",
                keyId: (process.env.RAZORPAY_KEY_ID || "").trim(),
                seats,
                label,
            });
        }

        if (!isLemonSqueezyConfigured()) {
            return res.status(503).json({ message: "International payments are not configured yet. Please contact support." });
        }
        const variantId = getLemonSeatVariantId();
        if (!variantId) {
            return res.status(503).json({ message: "No Lemon Squeezy variant configured for extra seats." });
        }

        const { checkoutId, checkoutUrl } = await createLemonCheckout({
            variantId,
            userEmail: user.email,
            userId,
            plan: "agency",
            billingCycle: "monthly",
            customPrice: amount,
            custom: { kind: "seats", seats: String(seats) },
            productName: `Extra team seats (${seats})`,
            productDescription: `${label} until your Agency plan renews (${quote.days} day${quote.days === 1 ? "" : "s"}).`,
            redirectPath: "/dashboard/team?seats=success&order_id=[order_id]",
        });

        await Transaction.create({
            user: userId,
            plan: "agency",
            kind: "seats",
            seats,
            amount,
            originalAmount: amount,
            billingCycle: "monthly",
            paymentProvider: "lemon_squeezy",
            currency: "USD",
            razorpayOrderId: `lemon_${checkoutId}`,
            lemonSqueezyCheckoutId: String(checkoutId),
            lemonCheckoutUrl: checkoutUrl,
            idempotencyKey: `ls_seats_${userId}_${checkoutId}`,
            status: "pending",
        });

        res.json({ provider: "lemon_squeezy", checkoutId, checkoutUrl, amount, currency: "USD", seats, label });
    } catch (err) {
        console.error("Create seat checkout error:", err?.response?.data || err);
        res.status(500).json({ message: err?.response?.data?.errors?.[0]?.detail || err.message });
    }
};

/** Undo a refunded transaction: seats are removed, plans fall back to free. */
const revokeRefundedTransaction = async (tx) => {
    if (tx.kind === "seats") {
        const user = await User.findById(tx.user).select("extraSeats");
        if (user) {
            const next = Math.max(0, extraSeatsOf(user) - Math.max(0, tx.seats || 0));
            await User.updateOne({ _id: tx.user }, { extraSeats: next });
        }
    } else {
        await User.findByIdAndUpdate(tx.user, { plan: "free", planExpiresAt: null, extraSeats: 0 });
    }
    await invalidateSubscriptionCaches(tx.user);
};

// ─── Public pricing (plans + team seats, admin-editable) ─────────────────────
// GET /api/subscription/pricing
export const getPricingConfig = (req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    res.json(getPublicPricing());
};

// ─── Pricing region (India vs international) ─────────────────────────────────
// GET /api/subscription/pricing-region
export const getPricingRegion = async (req, res) => {
    try {
        const { region, currency, country } = getPaymentRegion(req);
        res.json({
            region,
            currency,
            country,
            lemonSqueezyEnabled: isLemonSqueezyConfigured(),
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ─── Create Razorpay order (India / INR) ─────────────────────────────────────
// POST /api/subscription/create-order
export const createOrder = async (req, res) => {
    try {
        const { plan, billingCycle = "monthly", currency: requestedCurrency } = req.body;
        const validationError = assertValidPlanRequest(plan, billingCycle);
        if (validationError) return res.status(400).json({ message: validationError });

        const currency = resolveCheckoutCurrency(req, requestedCurrency);
        if (currency !== "INR") {
            return res.status(400).json({
                message: "USD checkout uses Lemon Squeezy. Switch currency or use create-lemon-checkout.",
                useLemonSqueezy: true,
            });
        }

        const userId = req.user._id;
        const user = await User.findById(userId);
        const duplicateError = assertNoDuplicateActivePlan(user, plan);
        if (duplicateError) return res.status(400).json({ message: duplicateError });

        const seats = seatsForPlanPurchase(user, plan);
        const originalAmount = PLAN_PRICES[plan][billingCycle] + seatRenewalAmount(seats, billingCycle, "INR");
        const amount = originalAmount;

        const pendingTx = await Transaction.findOne({
            user: userId,
            status: "pending",
            paymentProvider: "razorpay",
            kind: { $ne: "seats" },
        });

        if (pendingTx) {
            const ageMs = Date.now() - new Date(pendingTx.createdAt).getTime();
            const FIFTEEN_MIN = 15 * 60 * 1000;
            let reusable = false;

            if (
                ageMs < FIFTEEN_MIN &&
                pendingTx.amount === amount &&
                pendingTx.plan === plan &&
                pendingTx.billingCycle === billingCycle &&
                pendingTx.razorpayOrderId
            ) {
                try {
                    const existingOrder = await razorpay.orders.fetch(pendingTx.razorpayOrderId);
                    reusable = existingOrder?.status === "created";
                } catch {
                    reusable = false;
                }
            }

            if (reusable) {
                return res.json({
                    provider: "razorpay",
                    razorpayOrderId: pendingTx.razorpayOrderId,
                    amount: pendingTx.amount,
                    currency: "INR",
                    keyId: (process.env.RAZORPAY_KEY_ID || "").trim(),
                    resumed: true,
                });
            }

            pendingTx.status = "failed";
            pendingTx.failureReason = "Order expired or replaced";
            await pendingTx.save();
        }

        const receipt = `rcpt_${userId.toString().slice(-6)}_${Date.now()}`;
        const rpOrder = await razorpay.orders.create({
            amount,
            currency: "INR",
            receipt,
        });

        const idempotencyKey = `${userId}_${plan}_${billingCycle}_${rpOrder.id}`;
        await Transaction.create({
            user: userId,
            plan,
            seats: plan === "agency" ? seats : undefined,
            amount,
            originalAmount,
            billingCycle,
            paymentProvider: "razorpay",
            currency: "INR",
            razorpayOrderId: rpOrder.id,
            idempotencyKey,
            status: "pending",
        });

        res.json({
            provider: "razorpay",
            razorpayOrderId: rpOrder.id,
            amount,
            currency: "INR",
            keyId: (process.env.RAZORPAY_KEY_ID || "").trim(),
        });
    } catch (err) {
        console.error("Create order error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Create Lemon Squeezy checkout (international / USD) ─────────────────────
// POST /api/subscription/create-lemon-checkout
export const createLemonCheckoutHandler = async (req, res) => {
    try {
        if (!isLemonSqueezyConfigured()) {
            return res.status(503).json({
                message: "International payments are not configured yet. Please contact support.",
            });
        }

        const { plan, billingCycle = "monthly", currency: requestedCurrency } = req.body;
        const validationError = assertValidPlanRequest(plan, billingCycle);
        if (validationError) return res.status(400).json({ message: validationError });

        const currency = resolveCheckoutCurrency(req, requestedCurrency);
        if (currency !== "USD") {
            return res.status(400).json({
                message: "INR checkout uses Razorpay. Switch currency or use create-order.",
                useRazorpay: true,
            });
        }

        const userId = req.user._id;
        const user = await User.findById(userId);
        const duplicateError = assertNoDuplicateActivePlan(user, plan);
        if (duplicateError) return res.status(400).json({ message: duplicateError });

        const variantId = getLemonVariantId(plan, billingCycle);
        if (!variantId) {
            return res.status(503).json({
                message: `No Lemon Squeezy variant configured for ${plan} (${billingCycle}).`,
            });
        }

        const pendingTx = await Transaction.findOne({
            user: userId,
            status: "pending",
            paymentProvider: "lemon_squeezy",
            kind: { $ne: "seats" },
        });

        if (pendingTx) {
            const ageMs = Date.now() - new Date(pendingTx.createdAt).getTime();
            const FIFTEEN_MIN = 15 * 60 * 1000;

            const expectedAmount =
                PLAN_PRICES_USD[plan][billingCycle] +
                seatRenewalAmount(seatsForPlanPurchase(user, plan), billingCycle, "USD");
            if (
                ageMs < FIFTEEN_MIN &&
                pendingTx.lemonSqueezyCheckoutId &&
                pendingTx.plan === plan &&
                pendingTx.billingCycle === billingCycle &&
                pendingTx.amount === expectedAmount
            ) {
                const checkoutUrl = pendingTx.lemonCheckoutUrl;
                if (checkoutUrl) {
                    return res.json({
                        provider: "lemon_squeezy",
                        checkoutId: pendingTx.lemonSqueezyCheckoutId,
                        checkoutUrl,
                        amount: pendingTx.amount,
                        currency: "USD",
                        resumed: true,
                    });
                }
            }

            pendingTx.status = "failed";
            pendingTx.failureReason = "Checkout expired (15 min timeout)";
            await pendingTx.save();
        }

        const seats = seatsForPlanPurchase(user, plan);
        const seatAmount = seatRenewalAmount(seats, billingCycle, "USD");
        const originalAmount = PLAN_PRICES_USD[plan][billingCycle] + seatAmount;
        const { checkoutId, checkoutUrl } = await createLemonCheckout({
            variantId,
            userEmail: user.email,
            userId,
            plan,
            billingCycle,
            // Always charge the admin-configured price, whatever the variant is set to in Lemon.
            customPrice: originalAmount,
            custom: plan === "agency" ? { seats: String(seats) } : undefined,
        });

        const idempotencyKey = `ls_${userId}_${plan}_${billingCycle}_${checkoutId}`;
        await Transaction.create({
            user: userId,
            plan,
            seats: plan === "agency" ? seats : undefined,
            amount: originalAmount,
            originalAmount,
            billingCycle,
            paymentProvider: "lemon_squeezy",
            currency: "USD",
            // Workaround: your current Mongo unique index on `razorpayOrderId`
            // treats missing as `null`, causing duplicate-key errors for non-Razorpay txns.
            // We set a unique placeholder so Lemon transactions won't collide.
            razorpayOrderId: `lemon_${checkoutId}`,
            lemonSqueezyCheckoutId: String(checkoutId),
            lemonCheckoutUrl: checkoutUrl,
            idempotencyKey,
            status: "pending",
        });

        res.json({
            provider: "lemon_squeezy",
            checkoutId,
            checkoutUrl,
            amount: originalAmount,
            currency: "USD",
        });
    } catch (err) {
        console.error("Create Lemon Squeezy checkout error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Verify Razorpay payment ─────────────────────────────────────────────────
// POST /api/subscription/verify-payment
export const verifyPayment = async (req, res) => {
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

        const generated = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpayOrderId}|${razorpayPaymentId}`)
            .digest("hex");

        if (generated !== razorpaySignature) {
            return res.status(400).json({ message: "Payment signature verification failed." });
        }

        const tx = await Transaction.findOneAndUpdate(
            { razorpayOrderId, status: { $in: ["pending", "failed"] } },
            {
                status: "completed",
                transactionId: razorpayPaymentId,
                razorpaySignature,
                purchaseDate: new Date(),
            },
            { new: true }
        );

        if (!tx) {
            const existingTx = await Transaction.findOne({ razorpayOrderId });
            if (existingTx?.status === "completed") {
                return res.json({ message: "Payment already verified.", success: true });
            }
            return res.status(400).json({
                message: "Transaction not found or already processed.",
                success: false,
            });
        }

        await activateUserPlan(tx);
        res.json({ message: "Payment verified. Plan activated!", success: true, transaction: tx });
    } catch (err) {
        console.error("Verify payment error:", err);
        res.status(500).json({ message: err.message });
    }
};

const getRawWebhookBody = (req) => {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body);
    return Buffer.from(JSON.stringify(req.body || {}));
};

const isLemonWebhookRequest = (req) => {
    const lemonSig = req.headers["x-signature"];
    const razorpaySig = req.headers["x-razorpay-signature"];
    const eventName = req.headers["x-event-name"];
    return Boolean((lemonSig && !razorpaySig) || eventName);
};

const verifyLemonSignature = (rawBody, signatureHeader, secret) => {
    const expectedHex = crypto
        .createHmac("sha256", String(secret).trim())
        .update(rawBody)
        .digest("hex");
    const received = String(signatureHeader || "").trim();
    const hmac = Buffer.from(expectedHex, "hex");
    const signature = Buffer.from(received, "hex");
    return (
        signature.length > 0 &&
        hmac.length === signature.length &&
        crypto.timingSafeEqual(hmac, signature)
    );
};

// ─── Razorpay webhook ─────────────────────────────────────────────────────────
export const webhook = async (req, res) => {
    try {
        // Lemon Squeezy is often configured to this same URL in the dashboard.
        // Route those events to the Lemon handler instead of Razorpay HMAC.
        if (isLemonWebhookRequest(req)) {
            return lemonWebhook(req, res);
        }

        const webhookSignature = req.headers["x-razorpay-signature"];
        const rawBody = getRawWebhookBody(req);

        const generated = crypto
            .createHmac("sha256", (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim())
            .update(rawBody)
            .digest("hex");

        if (!webhookSignature || generated !== webhookSignature) {
            return res.status(400).json({ message: "Invalid webhook signature." });
        }

        const event = JSON.parse(rawBody.toString());
        const payment = event.payload?.payment?.entity;

        if (event.event === "payment.captured" && payment) {
            const tx = await Transaction.findOneAndUpdate(
                { razorpayOrderId: payment.order_id, status: { $in: ["pending", "failed"] } },
                {
                    status: "completed",
                    transactionId: payment.id,
                    purchaseDate: new Date(),
                    webhookVerified: true,
                },
                { new: true }
            );

            if (tx) await activateUserPlan(tx);
        } else if (event.event === "payment.failed" && payment) {
            await Transaction.findOneAndUpdate(
                { razorpayOrderId: payment.order_id, status: "pending" },
                {
                    status: "failed",
                    failureReason: payment.error_description || "Payment failed",
                    webhookVerified: true,
                }
            );
        } else if (event.event === "refund.created") {
            const refund = event.payload?.refund?.entity;
            if (refund) {
                const tx = await Transaction.findOneAndUpdate(
                    { transactionId: refund.payment_id },
                    { status: "refunded" },
                    { new: true }
                );
                if (tx) await revokeRefundedTransaction(tx);
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Webhook error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Verify Lemon Squeezy payment (client redirect fallback) ─────────────────
// POST /api/subscription/verify-lemon-payment
// Razorpay verifies client-side; Lemon normally uses webhooks. Localhost cannot
// receive Lemon webhooks, so after redirect we fetch the order from Lemon's API
// and activate the plan the same way.
export const verifyLemonPayment = async (req, res) => {
    try {
        let { orderId } = req.body;
        const isSeatOrder = req.body?.kind === "seats";

        if (!isLemonSqueezyConfigured()) {
            return res.status(503).json({
                message: "Lemon Squeezy is not configured.",
                success: false,
            });
        }

        const pendingTx = await Transaction.findOne({
            user: req.user._id,
            paymentProvider: "lemon_squeezy",
            kind: isSeatOrder ? "seats" : { $ne: "seats" },
            status: { $in: ["pending", "failed"] },
        }).sort({ createdAt: -1 });

        let order = null;

        if (orderId) {
            order = await getLemonOrder(orderId);
        } else {
            // Redirect sometimes omits order_id — match latest paid order for this email
            // created after our pending checkout.
            const orders = await findLemonOrdersByEmail(req.user.email);
            const pendingCreatedAt = pendingTx
                ? new Date(pendingTx.createdAt).getTime()
                : Date.now() - 60 * 60 * 1000;

            order =
                orders.find((o) => {
                    const status = String(o.attributes?.status || "").toLowerCase();
                    const created = new Date(o.attributes?.created_at || 0).getTime();
                    return status === "paid" && created >= pendingCreatedAt - 60_000;
                }) || null;

            if (order) orderId = order.id;
        }

        if (!order) {
            return res.status(404).json({
                message: "Paid Lemon Squeezy order not found yet. Please wait a moment and refresh.",
                success: false,
            });
        }

        const status = String(order.attributes?.status || "").toLowerCase();
        if (status !== "paid") {
            return res.status(400).json({
                message: `Order is not paid yet (status: ${status || "unknown"}).`,
                success: false,
            });
        }

        const userEmail = String(order.attributes?.user_email || "").toLowerCase();
        const authEmail = String(req.user.email || "").toLowerCase();
        if (userEmail && authEmail && userEmail !== authEmail) {
            return res.status(403).json({
                message: "This order does not belong to your account.",
                success: false,
            });
        }

        if (isSeatOrder) {
            const already = await Transaction.findOne({ transactionId: String(order.id), status: "completed" });
            if (!already) {
                if (!pendingTx) {
                    return res.status(404).json({ message: "No pending seat purchase found.", success: false });
                }
                // Guards against redeeming an unrelated (cheaper) paid order for seats.
                const paid = Number(order.attributes?.subtotal ?? order.attributes?.total ?? 0);
                if (paid < pendingTx.amount) {
                    return res.status(400).json({ message: "This order does not match your seat purchase.", success: false });
                }
            }
            const { tx, alreadyCompleted } = await completeLemonSeatOrder({
                userId: req.user._id,
                orderId: order.id,
                checkoutId: already ? undefined : pendingTx.lemonSqueezyCheckoutId,
                webhookVerified: false,
            });
            return res.json({
                message: alreadyCompleted ? "Seats already added." : "Payment verified. Seats added!",
                success: true,
                transaction: tx,
            });
        }

        const variantId = order.attributes?.first_order_item?.variant_id;
        const mapped = variantId ? getPlanFromVariantId(variantId) : null;

        const plan = mapped?.plan || pendingTx?.plan;
        const billingCycle = mapped?.billingCycle || pendingTx?.billingCycle || "monthly";

        if (!plan || !VALID_PLANS.includes(plan)) {
            return res.status(400).json({
                message: "Could not determine plan from Lemon order.",
                success: false,
            });
        }

        const { tx, alreadyCompleted } = await completeLemonOrder({
            userId: req.user._id,
            plan,
            billingCycle,
            orderId: order.id,
            checkoutId: pendingTx?.lemonSqueezyCheckoutId,
            webhookVerified: false,
        });

        res.json({
            message: alreadyCompleted
                ? "Payment already verified. Plan is active."
                : "Payment verified. Plan activated!",
            success: true,
            transaction: tx,
        });
    } catch (err) {
        console.error("Verify Lemon payment error:", err?.response?.data || err);
        res.status(500).json({
            message: err?.response?.data?.errors?.[0]?.detail || err.message || "Verification failed.",
            success: false,
        });
    }
};

// ─── Lemon Squeezy webhook ────────────────────────────────────────────────────
export const lemonWebhook = async (req, res) => {
    try {
        const secret = (process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "").trim();
        if (!secret) {
            return res.status(500).json({ message: "Webhook secret not configured." });
        }

        const rawBody = getRawWebhookBody(req);
        const signatureHeader = req.headers["x-signature"] || "";

        if (!verifyLemonSignature(rawBody, signatureHeader, secret)) {
            console.error("Lemon webhook signature mismatch. Check LEMON_SQUEEZY_WEBHOOK_SECRET vs dashboard.");
            return res.status(400).json({ message: "Invalid webhook signature." });
        }

        const payload = JSON.parse(rawBody.toString());
        const eventName = payload.meta?.event_name;
        const custom = payload.meta?.custom_data || {};
        const orderId = payload.data?.id;
        const attrs = payload.data?.attributes || {};
        const orderStatus = attrs.status;

        if (eventName === "order_created") {
            const normalizedStatus = String(orderStatus || "").toLowerCase();
            const isFailed = ["unpaid", "failed", "declined", "expired"].includes(normalizedStatus);
            const looksPaid =
                normalizedStatus === "" ||
                normalizedStatus === "paid" ||
                normalizedStatus === "completed" ||
                normalizedStatus.includes("paid");

            if (!looksPaid || isFailed) {
                return res.json({ received: true, skipped: `order_status:${orderStatus || "unknown"}` });
            }

            const variantId =
                attrs.first_order_item?.variant_id ||
                payload.data?.relationships?.variant?.data?.id;
            const mapped = variantId ? getPlanFromVariantId(variantId) : null;

            let userId = custom.user_id;
            const plan = custom.plan || mapped?.plan;
            const billingCycle = custom.billing_cycle || mapped?.billingCycle || "monthly";

            if (!userId && attrs.user_email) {
                const user = await User.findOne({
                    email: String(attrs.user_email).toLowerCase().trim(),
                }).select("_id");
                userId = user?._id;
            }

            if (!userId || !VALID_PLANS.includes(plan)) {
                console.error("Lemon order_created missing user/plan", {
                    orderId,
                    hasUserId: Boolean(userId),
                    plan,
                    variantId,
                });
                return res.json({ received: true, skipped: "missing custom data" });
            }

            const seats = custom.seats != null ? parseInt(custom.seats, 10) : undefined;

            if (custom.kind === "seats") {
                await completeLemonSeatOrder({ userId, orderId, seats, webhookVerified: true });
            } else {
                await completeLemonOrder({
                    userId,
                    plan,
                    billingCycle,
                    orderId,
                    seats: Number.isInteger(seats) ? seats : undefined,
                    webhookVerified: true,
                });
            }
        }

        if (eventName === "order_refunded") {
            const orderIdStr = String(payload.data?.id);
            const tx = await Transaction.findOneAndUpdate(
                { transactionId: orderIdStr, paymentProvider: "lemon_squeezy" },
                { status: "refunded" },
                { new: true }
            );
            if (tx) await revokeRefundedTransaction(tx);
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Lemon Squeezy webhook error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Mark payment failed (frontend fallback) ──────────────────────────────────
export const paymentFailed = async (req, res) => {
    try {
        const { razorpayOrderId, lemonSqueezyCheckoutId } = req.body;
        const filter = { user: req.user._id, status: "pending" };

        if (razorpayOrderId) filter.razorpayOrderId = razorpayOrderId;
        else if (lemonSqueezyCheckoutId) filter.lemonSqueezyCheckoutId = lemonSqueezyCheckoutId;
        else return res.status(400).json({ message: "Order id required." });

        await Transaction.findOneAndUpdate(filter, {
            status: "failed",
            failureReason: "User reported failure",
        });
        res.json({ message: "Marked as failed." });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ─── Active subscription ──────────────────────────────────────────────────────
export const getActiveSubscription = async (req, res) => {
    try {
        if (req.isStaff) {
            const { plan, planExpiresAt } = req.account;
            return res.json({ plan, planExpiresAt, isActive: req.teamActive, managedByTeamOwner: true });
        }

        const userId = req.user._id.toString();
        const cacheKey = `sub:active:${userId}`;

        const cached = await getCache(cacheKey);
        if (cached) return res.json(cached);

        const user = await User.findById(req.user._id).select("plan planExpiresAt");
        const isActive = hasActivePaidPlan(user);

        const result = {
            plan: user.plan,
            planExpiresAt: user.planExpiresAt,
            isActive: user.plan === "free" ? true : isActive,
        };

        await setCache(cacheKey, result, 300);
        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ─── Transaction history ──────────────────────────────────────────────────────
export const getHistory = async (req, res) => {
    try {
        const userId = req.user._id.toString();
        const cacheKey = `sub:history:${userId}`;

        const cached = await getCache(cacheKey);
        if (cached) return res.json(cached);

        const transactions = await Transaction.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .limit(20)
            .select("-razorpaySignature -idempotencyKey -lemonCheckoutUrl");

        const result = { transactions };
        await setCache(cacheKey, result, 120);
        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};
