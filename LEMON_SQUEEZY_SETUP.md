# Lemon Squeezy (international) + Razorpay (India)

## How it works

| Visitor region | Gateway        | Currency | Detection                          |
|----------------|----------------|----------|------------------------------------|
| India (`IN`)   | Razorpay       | INR      | `CF-IPCountry` or `x-vercel-ip-country` |
| Rest of world  | Lemon Squeezy  | USD      | Same headers                       |

1. Frontend calls `GET /api/subscription/pricing-region` for a suggested currency, then the user can switch **₹ INR / $ USD** on the pricing page (choice is saved in `localStorage`).
2. **India:** `POST /api/subscription/create-order` → Razorpay modal → `verify-payment` + webhook.
3. **International:** `POST /api/subscription/create-lemon-checkout` → redirect to Lemon Squeezy → `order_created` webhook activates the plan.

## Lemon Squeezy dashboard setup

1. Create a [Lemon Squeezy](https://lemonsqueezy.com) store.
2. Create **6 one-time products** (or subscriptions if you prefer) with **fixed USD** prices matching `PLAN_PRICES_USD` in `be/src/utils/helpers.js`:

   | Plan    | Monthly | Annual | (INR equivalent) |
   |---------|---------|--------|------------------|
   | Starter | $2      | $2     | ₹199             |
   | Pro     | $3      | $3     | ₹299             |
   | Agency  | $10     | $10    | ₹999             |

3. Copy each **variant ID** from the dashboard.
4. Settings → API → create API key.
5. Settings → Webhooks → add endpoint:
   - URL: `https://YOUR_API_DOMAIN/api/subscription/lemon-webhook`
   - Events: `order_created`, `order_refunded`
   - Copy signing secret

## Backend environment variables

Add to `be/.env`:

```env
FRONTEND_URL=https://www.getreviewqr.com

# Lemon Squeezy
LEMON_SQUEEZY_API_KEY=
LEMON_SQUEEZY_STORE_ID=
LEMON_SQUEEZY_WEBHOOK_SECRET=

LEMON_SQUEEZY_VARIANT_STARTER_MONTHLY=
LEMON_SQUEEZY_VARIANT_STARTER_ANNUAL=
LEMON_SQUEEZY_VARIANT_PRO_MONTHLY=
LEMON_SQUEEZY_VARIANT_PRO_ANNUAL=
LEMON_SQUEEZY_VARIANT_AGENCY_MONTHLY=
LEMON_SQUEEZY_VARIANT_AGENCY_ANNUAL=
```

## Vercel / Cloudflare

For region detection to work in production, your host must send a country header:

- **Vercel:** `x-vercel-ip-country` (automatic on API routes if the request goes through Vercel; for external API you may need to pass it from the Next.js BFF or use Cloudflare in front).
- **Cloudflare:** `CF-IPCountry`

If you test locally, region defaults to **international** (USD). Use a VPN or temporarily hardcode region in dev if needed.

## Adjust USD prices

Edit `PLAN_PRICES` in `be/src/utils/helpers.js` (USD is derived as rupees ÷ 100, rounded — e.g. ₹199 → $2). Mirror INR in `fe-next/lib/pricing.ts`. **Lemon Squeezy variant prices in the dashboard must match.**
