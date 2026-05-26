import crypto from "crypto";
import Razorpay from "razorpay";
import Transaction from "../../models/Transaction.js";
import User from "../../models/User.js";
import {
    getPlanExpiry,
    PLAN_PRICES,
    PLAN_PRICES_USD,
    getPaymentRegion,
    resolveCheckoutCurrency,
} from "../../utils/helpers.js";
import { getCache, setCache, delCache } from "../../utils/cache.js";
import {
    createLemonCheckout,
    getLemonVariantId,
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

const activateUserPlan = async (tx) => {
    await User.findByIdAndUpdate(tx.user, {
        plan: tx.plan,
        planExpiresAt: getPlanExpiry(tx.billingCycle),
        planExpiryWarningSent: false,
        planExpiredNotifSent: false,
    });
    await invalidateSubscriptionCaches(tx.user);
};

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

        const pendingTx = await Transaction.findOne({
            user: userId,
            status: "pending",
            paymentProvider: "razorpay",
        });

        if (pendingTx) {
            const ageMs = Date.now() - new Date(pendingTx.createdAt).getTime();
            const FIFTEEN_MIN = 15 * 60 * 1000;

            if (ageMs < FIFTEEN_MIN) {
                return res.json({
                    provider: "razorpay",
                    razorpayOrderId: pendingTx.razorpayOrderId,
                    amount: pendingTx.amount,
                    currency: "INR",
                    keyId: process.env.RAZORPAY_KEY_ID,
                    resumed: true,
                });
            }

            pendingTx.status = "failed";
            pendingTx.failureReason = "Order expired (15 min timeout)";
            await pendingTx.save();
        }

        const originalAmount = PLAN_PRICES[plan][billingCycle];
        const amount = originalAmount;

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
            keyId: process.env.RAZORPAY_KEY_ID,
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
        });

        if (pendingTx) {
            const ageMs = Date.now() - new Date(pendingTx.createdAt).getTime();
            const FIFTEEN_MIN = 15 * 60 * 1000;

            if (ageMs < FIFTEEN_MIN && pendingTx.lemonSqueezyCheckoutId) {
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

        const originalAmount = PLAN_PRICES_USD[plan][billingCycle];
        const { checkoutId, checkoutUrl } = await createLemonCheckout({
            variantId,
            userEmail: user.email,
            userId,
            plan,
            billingCycle,
        });

        const idempotencyKey = `ls_${userId}_${plan}_${billingCycle}_${checkoutId}`;
        await Transaction.create({
            user: userId,
            plan,
            amount: originalAmount,
            originalAmount,
            billingCycle,
            paymentProvider: "lemon_squeezy",
            currency: "USD",
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

// ─── Razorpay webhook ─────────────────────────────────────────────────────────
export const webhook = async (req, res) => {
    try {
        const webhookSignature = req.headers["x-razorpay-signature"];
        const rawBody = req.body;

        const generated = crypto
            .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
            .update(rawBody)
            .digest("hex");

        if (generated !== webhookSignature) {
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
                if (tx) {
                    await User.findByIdAndUpdate(tx.user, { plan: "free", planExpiresAt: null });
                    await invalidateSubscriptionCaches(tx.user);
                }
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Webhook error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Lemon Squeezy webhook ────────────────────────────────────────────────────
export const lemonWebhook = async (req, res) => {
    try {
        const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
        if (!secret) {
            return res.status(500).json({ message: "Webhook secret not configured." });
        }

        const rawBody = req.body;
        const signatureHeader = req.headers["x-signature"] || "";

        const hmac = Buffer.from(
            crypto.createHmac("sha256", secret).update(rawBody).digest("hex"),
            "hex"
        );
        const signature = Buffer.from(signatureHeader, "hex");

        if (
            signature.length === 0 ||
            hmac.length !== signature.length ||
            !crypto.timingSafeEqual(hmac, signature)
        ) {
            return res.status(400).json({ message: "Invalid webhook signature." });
        }

        const payload = JSON.parse(rawBody.toString());
        const eventName = payload.meta?.event_name;
        const custom = payload.meta?.custom_data || {};
        const orderId = payload.data?.id;
        const orderStatus = payload.data?.attributes?.status;

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

            const userId = custom.user_id;
            const plan = custom.plan;
            const billingCycle = custom.billing_cycle || "monthly";

            if (!userId || !VALID_PLANS.includes(plan)) {
                return res.json({ received: true, skipped: "missing custom data" });
            }

            const tx = await Transaction.findOneAndUpdate(
                {
                    user: userId,
                    plan,
                    billingCycle,
                    paymentProvider: "lemon_squeezy",
                    status: { $in: ["pending", "failed"] },
                },
                {
                    status: "completed",
                    transactionId: String(orderId),
                    purchaseDate: new Date(),
                    webhookVerified: true,
                },
                { new: true, sort: { createdAt: -1 } }
            );

            if (tx) {
                await activateUserPlan(tx);
            } else {
                const alreadyDone = await Transaction.findOne({
                    transactionId: String(orderId),
                    status: "completed",
                });
                if (!alreadyDone) {
                    const amount = PLAN_PRICES_USD[plan]?.[billingCycle] ?? 0;
                    const created = await Transaction.create({
                        user: userId,
                        plan,
                        amount,
                        originalAmount: amount,
                        billingCycle,
                        paymentProvider: "lemon_squeezy",
                        currency: "USD",
                        lemonSqueezyCheckoutId: `order_${orderId}`,
                        transactionId: String(orderId),
                        status: "completed",
                        purchaseDate: new Date(),
                        webhookVerified: true,
                    });
                    await activateUserPlan(created);
                }
            }
        }

        if (eventName === "order_refunded") {
            const orderIdStr = String(payload.data?.id);
            const tx = await Transaction.findOneAndUpdate(
                { transactionId: orderIdStr, paymentProvider: "lemon_squeezy" },
                { status: "refunded" },
                { new: true }
            );
            if (tx) {
                await User.findByIdAndUpdate(tx.user, { plan: "free", planExpiresAt: null });
                await invalidateSubscriptionCaches(tx.user);
            }
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
        const userId = req.user._id.toString();
        const cacheKey = `sub:active:${userId}`;

        const cached = await getCache(cacheKey);
        if (cached) return res.json(cached);

        const user = await User.findById(req.user._id).select("plan planExpiresAt");
        const isActive =
            user.plan !== "free" &&
            user.planExpiresAt &&
            new Date(user.planExpiresAt) > new Date();

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
