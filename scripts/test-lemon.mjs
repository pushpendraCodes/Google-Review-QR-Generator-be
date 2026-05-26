import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const key = process.env.LEMON_SQUEEZY_API_KEY;
const storeId = process.env.LEMON_SQUEEZY_STORE_ID;
const variantId = process.env.LEMON_SQUEEZY_VARIANT_STARTER_MONTHLY;

const headers = {
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
    Authorization: `Bearer ${key}`,
};

async function test() {
    try {
        const store = await axios.get(`https://api.lemonsqueezy.com/v1/stores/${storeId}`, { headers });
        console.log("Store OK:", store.data?.data?.attributes?.name);
    } catch (e) {
        console.log("Store error:", e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 500));
    }
    try {
        const variant = await axios.get(`https://api.lemonsqueezy.com/v1/variants/${variantId}`, { headers });
        console.log("Variant OK:", variant.data?.data?.attributes?.name, "store_id:", variant.data?.data?.attributes?.product_id);
    } catch (e) {
        console.log("Variant error:", e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 500));
    }
    try {
        const checkout = await axios.post(
            "https://api.lemonsqueezy.com/v1/checkouts",
            {
                data: {
                    type: "checkouts",
                    attributes: {
                        checkout_options: { embed: false, media: false, logo: true },
                        checkout_data: {
                            email: "test@example.com",
                            custom: { user_id: "123", plan: "starter", billing_cycle: "monthly" },
                        },
                        product_options: { enabled_variants: [Number(variantId)] },
                        preview: true,
                        test_mode: true,
                    },
                    relationships: {
                        store: { data: { type: "stores", id: String(storeId) } },
                        variant: { data: { type: "variants", id: String(variantId) } },
                    },
                },
            },
            { headers }
        );
        console.log("Checkout OK:", checkout.data?.data?.attributes?.url?.slice(0, 100));
    } catch (e) {
        console.log("Checkout error:", e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 800));
    }
}
test();
