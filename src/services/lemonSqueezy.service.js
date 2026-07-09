import axios from "axios";

const LS_API = "https://api.lemonsqueezy.com/v1";

const lsHeaders = () => ({
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
    Authorization: `Bearer ${process.env.LEMON_SQUEEZY_API_KEY}`,
});

/** Map plan + billing cycle → Lemon Squeezy variant ID (set in dashboard, one per price). */
export const getLemonVariantId = (plan, billingCycle) => {
    const envKey = `LEMON_SQUEEZY_VARIANT_${plan.toUpperCase()}_${billingCycle.toUpperCase()}`;
    return process.env[envKey] || "";
};

/** Reverse-map a Lemon variant ID back to plan + billing cycle. */
export const getPlanFromVariantId = (variantId) => {
    const id = String(variantId);
    for (const plan of ["starter", "pro", "agency"]) {
        for (const billingCycle of ["monthly", "annual"]) {
            if (getLemonVariantId(plan, billingCycle) === id) {
                return { plan, billingCycle };
            }
        }
    }
    return null;
};

export const isLemonSqueezyConfigured = () =>
    Boolean(
        process.env.LEMON_SQUEEZY_API_KEY &&
        process.env.LEMON_SQUEEZY_STORE_ID &&
        getLemonVariantId("starter", "monthly")
    );

/**
 * Creates a hosted Lemon Squeezy checkout. Prices are fixed on each variant in the LS dashboard (USD).
 * custom fields are returned on the webhook as meta.custom_data.
 * [order_id] is replaced by Lemon on redirect so we can verify without waiting for webhooks.
 */
export const createLemonCheckout = async ({
    variantId,
    userEmail,
    userId,
    plan,
    billingCycle,
}) => {
    const storeId = process.env.LEMON_SQUEEZY_STORE_ID;
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    const { data } = await axios.post(
        `${LS_API}/checkouts`,
        {
            data: {
                type: "checkouts",
                attributes: {
                    checkout_options: {
                        embed: false,
                        media: false,
                        logo: true,
                    },
                    checkout_data: {
                        email: userEmail,
                        custom: {
                            user_id: String(userId),
                            plan,
                            billing_cycle: billingCycle,
                        },
                    },
                    product_options: {
                        redirect_url: `${frontendUrl}/pricing?payment=success&order_id=[order_id]`,
                        enabled_variants: [Number(variantId)],
                    },
                },
                relationships: {
                    store: {
                        data: { type: "stores", id: String(storeId) },
                    },
                    variant: {
                        data: { type: "variants", id: String(variantId) },
                    },
                },
            },
        },
        { headers: lsHeaders() }
    );

    const attrs = data?.data?.attributes ?? {};
    return {
        checkoutId: data?.data?.id,
        checkoutUrl: attrs.url,
    };
};

/** Fetch a Lemon Squeezy order by ID (used to verify payment on redirect). */
export const getLemonOrder = async (orderId) => {
    const { data } = await axios.get(`${LS_API}/orders/${orderId}`, {
        headers: lsHeaders(),
    });
    return data?.data ?? null;
};

/** Find recent Lemon orders for an email (fallback when redirect has no order_id). */
export const findLemonOrdersByEmail = async (email) => {
    const { data } = await axios.get(`${LS_API}/orders`, {
        headers: lsHeaders(),
        params: {
            "filter[user_email]": email,
            "page[size]": 5,
        },
    });
    return data?.data ?? [];
};
