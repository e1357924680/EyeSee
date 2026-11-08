// EyeSee API: Cloudflare Worker (free tier). Auth = Supabase, billing = Stripe, state = Workers KV.
// Routes: POST /ext-token  POST /checkout  GET /license  POST /stripe-webhook
const DAY = 86400000, TRIAL_MS = 2 * DAY, EXT_TOKEN_MS = 30 * DAY, REFRESH_WINDOW = 7 * DAY;
const enc = new TextEncoder(), dec = new TextDecoder();

// ---------- small crypto helpers (HS256 JWT + Stripe signature) ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uJson = (o) => b64u(enc.encode(JSON.stringify(o)));
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function signJwt(payload, secret) {
  const h = b64uJson({ alg: 'HS256', typ: 'JWT' }), p = b64uJson(payload);
  return h + '.' + p + '.' + b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(h + '.' + p)));
}
async function verifyJwt(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64u(s), enc.encode(h + '.' + p)))) return null;
    const payload = JSON.parse(dec.decode(fromB64u(p)));
    return payload.exp * 1000 > Date.now() ? payload : null;
  } catch { return null; }
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verifyStripe(raw, header, secret) {
  const parts = header.split(',').map((x) => x.trim().split('='));
  const t = parts.find((x) => x[0] === 't')?.[1];
  const sigs = parts.filter((x) => x[0] === 'v1').map((x) => x[1]);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(t + '.' + raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => safeEqual(hex, s));
}

// ---------- HTTP helpers ----------
function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const ok = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin'
  };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '')?.[1] || null;

async function supabaseUser(req, env) {
  const tok = bearer(req);
  if (!tok) return null;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok } });
  return r.ok ? await r.json() : null;
}

// ---------- license logic ----------
async function licenseFor(uid, env) {
  const sub = await env.KV.get('sub:' + uid, 'json');
  const now = Date.now();
  if (sub && (sub.status === 'active' || sub.status === 'trialing' || (sub.status === 'past_due' && sub.periodEnd * 1000 > now))) {
    return { ok: true, plan: 'paid' };
  }
  const start = Number(await env.KV.get('trial:' + uid)) || 0;
  if (!start) return { ok: false, plan: 'none' };
  const msLeft = start + TRIAL_MS - now;
  return { ok: msLeft > 0, plan: 'trial', msLeft: Math.max(0, msLeft) };
}
const issueToken = (uid, env) => signJwt({ sub: uid, exp: Math.floor((Date.now() + EXT_TOKEN_MS) / 1000) }, env.JWT_SECRET);

// ---------- handlers ----------
async function extToken(req, env, h) {
  const user = await supabaseUser(req, env);
  if (!user) return json({ error: 'unauthorized' }, 401, h);
  if (!(user.email_confirmed_at || user.confirmed_at)) return json({ error: 'email_not_confirmed' }, 403, h);
  if (!(await env.KV.get('trial:' + user.id))) await env.KV.put('trial:' + user.id, String(Date.now())); // trial starts once per account
  return json({ token: await issueToken(user.id, env), license: await licenseFor(user.id, env) }, 200, h);
}

async function checkout(req, env, h) {
  const user = await supabaseUser(req, env);
  if (!user) return json({ error: 'unauthorized' }, 401, h);
  if ((await licenseFor(user.id, env)).plan === 'paid') return json({ error: 'already_subscribed' }, 409, h);
  const site = env.SITE_URL;
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: user.id,
    customer_email: user.email,
    'subscription_data[metadata][user_id]': user.id,
    success_url: site + '/?paid=1',
    cancel_url: site + '/'
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const s = await r.json();
  return r.ok && s.url ? json({ url: s.url }, 200, h) : json({ error: 'stripe_error' }, 502, h);
}

async function license(req, env, h) {
  const claims = bearer(req) && (await verifyJwt(bearer(req), env.JWT_SECRET));
  if (!claims) return json({ error: 'unauthorized' }, 401, h);
  const lic = await licenseFor(claims.sub, env);
  const nearExpiry = claims.exp * 1000 - Date.now() < REFRESH_WINDOW;
  return json({ ...lic, ...(nearExpiry ? { token: await issueToken(claims.sub, env) } : {}) }, 200, h);
}

async function webhook(req, env) {
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('bad signature', { status: 400 });
  }
  const ev = JSON.parse(raw), o = ev.data.object;
  let uid = null, rec = null;
  if (ev.type === 'checkout.session.completed' && o.client_reference_id) {
    uid = o.client_reference_id;
    rec = { status: 'active', customer: o.customer, periodEnd: 0 };
  } else if (ev.type.startsWith('customer.subscription.') && o.metadata?.user_id) {
    uid = o.metadata.user_id;
    rec = {
      status: ev.type.endsWith('.deleted') ? 'canceled' : o.status,
      customer: o.customer,
      periodEnd: o.current_period_end ?? o.items?.data?.[0]?.current_period_end ?? 0 // field moved in newer Stripe API versions
    };
  }
  if (uid) {
    const prev = await env.KV.get('sub:' + uid, 'json');
    if (!prev || (prev.at || 0) <= ev.created) await env.KV.put('sub:' + uid, JSON.stringify({ ...rec, at: ev.created })); // ignore stale events
  }
  return new Response('ok');
}

export default {
  async fetch(req, env) {
    const h = cors(req, env), path = new URL(req.url).pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      if (path === '/stripe-webhook' && req.method === 'POST') return await webhook(req, env);
      if (path === '/ext-token' && req.method === 'POST') return await extToken(req, env, h);
      if (path === '/checkout' && req.method === 'POST') return await checkout(req, env, h);
      if (path === '/license' && req.method === 'GET') return await license(req, env, h);
      return json({ error: 'not_found' }, 404, h);
    } catch (e) {
      return json({ error: 'server_error' }, 500, h);
    }
  }
};
