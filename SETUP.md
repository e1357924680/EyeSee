# EyeSee v0.6.0: setup and launch guide

Everything here runs on free tiers (Supabase, Cloudflare Workers/KV/Pages). Stripe charges per transaction only.
The code is complete, but it needs YOUR accounts and keys; nothing below can be done on your behalf.

## What is in the package
eyesee/       Chrome extension (MV3)      eyesee-site/  website (single index.html)
eyesee-api/   Cloudflare Worker (auth check, Stripe Checkout, webhook, licence) + test.mjs

## 1. Supabase (login)
1. Create a project at supabase.com. Authentication > Providers: keep Email enabled and
   "Confirm email" ON (the API refuses to start a trial for unconfirmed emails; this limits fake accounts).
2. Authentication > URL Configuration: add your site URL (and http://localhost:8080 for testing) to redirect URLs.
3. Copy Project URL and the anon public key (Settings > API).

## 2. Stripe (payments)
1. Create a Product "EyeSee" with a recurring Price of $5/month; copy the price id (price_...).
2. Developers > Webhooks: add endpoint https://YOUR-WORKER-URL/stripe-webhook with events
   checkout.session.completed, customer.subscription.created, customer.subscription.updated,
   customer.subscription.deleted. Copy the signing secret (whsec_...).
3. Test with test-mode keys first (card 4242 4242 4242 4242). PayPal can be enabled as a payment method in Stripe's
   dashboard where available for your account; verify it there.

## 3. Cloudflare Worker
cd eyesee-api
npm i -g wrangler && wrangler login
wrangler kv namespace create KV            # paste the id into wrangler.toml
edit wrangler.toml [vars] (Supabase URL/anon key, SITE_URL, ALLOWED_ORIGINS, STRIPE_PRICE_ID)
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put JWT_SECRET             # e.g. output of: openssl rand -hex 32
wrangler deploy                            # note the *.workers.dev URL
Optional: `node test.mjs` runs the mocked end-to-end test (11 checks).

## 4. Website on your own domain
0. Then fill CONFIG in eyesee-site/index.html (SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE).
1. Buy the domain yourself (e.g. at Cloudflare Registrar or any registrar; this is the one unavoidable cost, roughly
   ten dollars a year for a .com, check the current price). Only the account owner can pay for and own it.
2. Cloudflare Pages (free): create a project from the eyesee-site folder (drag-and-drop upload works), then
   Custom domains > add your domain. If the domain is on Cloudflare, DNS and HTTPS are set up automatically.
3. Use that domain as SITE_URL / ALLOWED_ORIGINS (Worker), SITE_ORIGINS / SITE_URL (extension config.js) and in
   Supabase redirect URLs.

## 5. Extension
1. eyesee/config.js: set SITE_URL, SITE_ORIGINS (your real origin; keep localhost:8080 only for testing), API_BASE.
2. ./setup.sh inside eyesee/ (internet needed once): downloads Tesseract.js and eng, jpn, jpn_vert, kor, chi_sim, chi_tra.
3. chrome://extensions > Developer mode > Load unpacked > eyesee/ (Chrome 138+).
4. Popup > "تجهيز حزم اللغة" once per target language.

## In-app browser (new in v0.6.0)
Popup > "فتح متصفح EyeSee" (or paste a link in the website bar) opens browser.html: address bar, back/forward/reload,
source and target language, and the page loads INSIDE it; EyeSee translates it in place. It is an extension page,
not part of the website: a normal website cannot embed other sites or read their images.
How it works: a per-tab rule removes X-Frame-Options / CSP headers only for sub-frames of that viewer tab, and the
content script runs in the framed page. No proxy and no server cost.
Limits to test: sites that need login (third-party cookies), JavaScript frame-busting, image hosts that reject
requests without a Referer, SPA navigation (address bar syncs once per second), and the Chrome Web Store review
(header modification must be explained in the listing). A truly standalone app (like Aloha) is a separate native
WebView project (Android/iOS), not a website.

## 6. End-to-end test (do this in order)
1. Open the site, sign up, confirm the email, log in: header shows "trial: 48h left".
2. Extension popup shows the same trial; Alt+T on an image page translates.
3. Paste a page URL in the site bar: opens in a new tab and translates.
4. Click Subscribe: pay with the Stripe test card: back on the site "Processing", then "Subscribed" (webhook).
5. Stripe dashboard: cancel the test subscription: within minutes the extension denies access (licence re-check <= 6h; popup forces a check).
6. Log out on the site: extension asks to log in.
7. Languages: test kor / zh / zh-Hant profiles; manga pages with ja-manga.

## 7. Before charging real money
- Privacy policy and terms pages (the Chrome Web Store requires a privacy policy for extensions that handle account data).
- Chrome Web Store developer account (one-time fee) and review; then set EXTENSION_URL in the site.
- Switch Stripe to live keys; check taxes/VAT and current fees for your country.
- Stripe Customer Portal link so users can cancel themselves (not built yet).

## Known limits
- OCR accuracy on stylised manga (and kor/zh models) is modest; plan an ONNX/WebGPU detector+recognizer.
- Only <img> elements; CSS backgrounds/canvas need a screenshot-capture mode.
- Translator API pair availability (ja/ko/zh/he -> target) varies by Chrome version; pivot via English is implemented.
- Trial is per account (server side); determined users can create more confirmed accounts.
- Already in place since earlier versions: overlay re-positioning on resize (ResizeObserver) and lazy-loaded images
  (IntersectionObserver + MutationObserver in "auto" mode).
