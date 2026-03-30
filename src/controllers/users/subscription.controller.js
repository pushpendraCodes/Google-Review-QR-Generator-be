import crypto from "crypto";
import Razorpay from "razorpay";
import Transaction from "../../models/Transaction.js";
import User from "../../models/User.js";
import { getPlanExpiry, PLAN_PRICES } from "../../utils/helpers.js";
import { getCache, setCache, delCache } from "../../utils/cache.js";

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── Create Razorpay order ────────────────────────────────────────────────────
// POST /api/subscription/create-order
export const createOrder = async (req, res) => {
    try {
        const { plan, billingCycle = "monthly" } = req.body;

        if (!["starter", "pro", "agency"].includes(plan)) {
            return res.status(400).json({ message: "Invalid plan." });
        }
        if (!["monthly", "annual"].includes(billingCycle)) {
            return res.status(400).json({ message: "Invalid billing cycle." });
        }

        const userId = req.user._id;
        const user = await User.findById(userId);

        // Guard: already on same or higher plan and not expired
        if (
            user.plan === plan &&
            user.planExpiresAt &&
            new Date(user.planExpiresAt) > new Date()
        ) {
            return res.status(400).json({ message: "You already have an active subscription for this plan." });
        }

        // ── Idempotency: check pending orders ──────────────────────────────────────
        const pendingTx = await Transaction.findOne({ user: userId, status: "pending" });

        if (pendingTx) {
            const ageMs = Date.now() - new Date(pendingTx.createdAt).getTime();
            const FIFTEEN_MIN = 15 * 60 * 1000;

            if (ageMs < FIFTEEN_MIN) {
                // Return existing order to re-open Razorpay modal
                return res.json({
                    razorpayOrderId: pendingTx.razorpayOrderId,
                    amount: pendingTx.amount,
                    currency: "INR",
                    keyId: process.env.RAZORPAY_KEY_ID,
                    resumed: true,
                });
            } else {
                // Expired pending order → mark failed and release lock
                pendingTx.status = "failed";
                pendingTx.failureReason = "Order expired (15 min timeout)";
                await pendingTx.save();
            }
        }

        // ── Compute amount ─────────────────────────────────────────────────────────
        const originalAmount = PLAN_PRICES[plan][billingCycle]; // paise
        const amount = originalAmount; // Apply coupon logic here if needed

        // ── Create Razorpay order ──────────────────────────────────────────────────
        const receipt = `rcpt_${userId.toString().slice(-6)}_${Date.now()}`;
        const rpOrder = await razorpay.orders.create({
            amount,
            currency: "INR",
            receipt,
        });

        // ── Save transaction ───────────────────────────────────────────────────────
        const idempotencyKey = `${userId}_${plan}_${billingCycle}_${rpOrder.id}`;
        await Transaction.create({
            user: userId,
            plan,
            amount,
            originalAmount,
            billingCycle,
            razorpayOrderId: rpOrder.id,
            idempotencyKey,
            status: "pending",
        });

        res.json({
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

// ─── Verify payment ───────────────────────────────────────────────────────────
// POST /api/subscription/verify-payment
export const verifyPayment = async (req, res) => {
    try {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

        // ── HMAC-SHA256 signature check ────────────────────────────────────────────
        const generated = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpayOrderId}|${razorpayPaymentId}`)
            .digest("hex");

        if (generated !== razorpaySignature) {
            return res.status(400).json({ message: "Payment signature verification failed." });
        }

        // ── Atomic update: pending → completed ────────────────────────────────────
        const tx = await Transaction.findOneAndUpdate(
            { razorpayOrderId, status: "pending" },
            {
                status: "completed",
                transactionId: razorpayPaymentId,
                razorpaySignature,
                purchaseDate: new Date(),
            },
            { new: true }
        );

        if (!tx) {
            // Payment may have been verified already via webhook — return success
            return res.json({ message: "Payment already verified.", success: true });
        }

        // ── Activate plan on user ──────────────────────────────────────────────────
        await User.findByIdAndUpdate(tx.user, {
            plan: tx.plan,
            planExpiresAt: getPlanExpiry(tx.billingCycle),
        });

        // Invalidate subscription & profile caches
        const userId = tx.user.toString();
        await delCache(`sub:active:${userId}`);
        await delCache(`sub:history:${userId}`);
        await delCache(`user:profile:${userId}`);

        res.json({ message: "Payment verified. Plan activated!", success: true, transaction: tx });
    } catch (err) {
        console.error("Verify payment error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Razorpay webhook ─────────────────────────────────────────────────────────
// POST /api/subscription/webhook  (body is raw Buffer due to app.js setup)
export const webhook = async (req, res) => {
    try {
        const webhookSignature = req.headers["x-razorpay-signature"];
        const rawBody = req.body; // raw Buffer

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
                { razorpayOrderId: payment.order_id, status: "pending" },
                {
                    status: "completed",
                    transactionId: payment.id,
                    purchaseDate: new Date(),
                    webhookVerified: true,
                },
                { new: true }
            );

            if (tx) {
                await User.findByIdAndUpdate(tx.user, {
                    plan: tx.plan,
                    planExpiresAt: getPlanExpiry(tx.billingCycle),
                });
                // Invalidate caches
                const userId = tx.user.toString();
                await delCache(`sub:active:${userId}`);
                await delCache(`sub:history:${userId}`);
                await delCache(`user:profile:${userId}`);
            }
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
                    const userId = tx.user.toString();
                    await delCache(`sub:active:${userId}`);
                    await delCache(`sub:history:${userId}`);
                    await delCache(`user:profile:${userId}`);
                }
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Webhook error:", err);
        res.status(500).json({ message: err.message });
    }
};

// ─── Mark payment failed (frontend fallback) ──────────────────────────────────
export const paymentFailed = async (req, res) => {
    try {
        const { razorpayOrderId } = req.body;
        await Transaction.findOneAndUpdate(
            { razorpayOrderId, user: req.user._id, status: "pending" },
            { status: "failed", failureReason: "User reported failure" }
        );
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

        // Cache for 5 minutes
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
            .select("-razorpaySignature -idempotencyKey");

        const result = { transactions };

        // Cache for 2 minutes
        await setCache(cacheKey, result, 120);

        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};
