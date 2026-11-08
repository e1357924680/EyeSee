import worker from './index.js';
import { createHmac } from 'node:crypto';
const store = new Map();
const KV = { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => void store.set(k, v) };
const env = { KV, SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SITE_URL: 'https://site.test', ALLOWED_ORIGINS: 'https://site.test',
  STRIPE_PRICE_ID: 'price_1', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec', JWT_SECRET: 'x'.repeat(40) };
let confirmed = true;
globalThis.fetch = async (url, init) => {
  if (url.startsWith('https://sb.test/auth/v1/user')) return init.headers.Authorization === 'Bearer good'
    ? new Response(JSON.stringify({ id: 'u1', email: 'a@b.c', email_confirmed_at: confirmed ? 'now' : null })) : new Response('{}', { status: 401 });
  if (url.startsWith('https://api.stripe.com')) return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/s' }));
  throw new Error('unexpected fetch ' + url);
};
const call = (path, method = 'GET', headers = {}, body) => worker.fetch(new Request('https://api.test' + path, { method, headers, body }), env);
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('pass', m); };

let r = await call('/ext-token', 'POST', { Authorization: 'Bearer bad' }); ok(r.status === 401, 'rejects bad supabase token');
confirmed = false; r = await call('/ext-token', 'POST', { Authorization: 'Bearer good' }); ok(r.status === 403, 'rejects unconfirmed email');
confirmed = true; r = await call('/ext-token', 'POST', { Authorization: 'Bearer good' });
let j = await r.json(); ok(r.status === 200 && j.license.plan === 'trial' && j.license.ok, 'trial starts on first token');
const ext = j.token;
r = await call('/license', 'GET', { Authorization: 'Bearer ' + ext }); j = await r.json(); ok(j.ok && j.plan === 'trial', 'license ok during trial');
r = await call('/license', 'GET', { Authorization: 'Bearer tampered' + ext }); ok(r.status === 401, 'rejects tampered ext token');
store.set('trial:u1', String(Date.now() - 3 * 86400000)); r = await call('/license', 'GET', { Authorization: 'Bearer ' + ext }); j = await r.json(); ok(!j.ok, 'trial expires after 2 days');
r = await call('/checkout', 'POST', { Authorization: 'Bearer good' }); j = await r.json(); ok(j.url?.startsWith('https://checkout'), 'checkout returns stripe url');
const evt = { id: 'e1', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: { client_reference_id: 'u1', customer: 'cus_1' } } };
const raw = JSON.stringify(evt), t = Math.floor(Date.now() / 1000);
const sig = createHmac('sha256', 'whsec').update(`${t}.${raw}`).digest('hex');
r = await call('/stripe-webhook', 'POST', { 'Stripe-Signature': `t=${t},v1=deadbeef` }, raw); ok(r.status === 400, 'webhook rejects bad signature');
r = await call('/stripe-webhook', 'POST', { 'Stripe-Signature': `t=${t},v1=${sig}` }, raw); ok(r.status === 200, 'webhook accepts valid signature');
r = await call('/license', 'GET', { Authorization: 'Bearer ' + ext }); j = await r.json(); ok(j.ok && j.plan === 'paid', 'paid after webhook');
const del = { id: 'e2', type: 'customer.subscription.deleted', created: evt.created + 10, data: { object: { metadata: { user_id: 'u1' }, customer: 'cus_1', status: 'canceled', current_period_end: 1 } } };
const raw2 = JSON.stringify(del), sig2 = createHmac('sha256', 'whsec').update(`${t}.${raw2}`).digest('hex');
await call('/stripe-webhook', 'POST', { 'Stripe-Signature': `t=${t},v1=${sig2}` }, raw2);
r = await call('/license', 'GET', { Authorization: 'Bearer ' + ext }); j = await r.json(); ok(!j.ok, 'access ends after cancellation');
console.log('ALL PASSED');
