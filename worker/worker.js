/**
 * Superwhite Credits — Cloudflare Worker (Gumroad edition)
 * ========================================================
 * Entitlement backend for superwhite.app, backed by Gumroad license keys.
 *
 * Endpoints:
 *   POST /redeem   { key: string }
 *                  → { ok, type: "pack"|"pro", credits }
 *                  Verifies the key against Gumroad (pack first, then pro).
 *                  Pack keys mint 10 credits once (idempotent). Pro keys are
 *                  accepted while the subscription is active.
 *   GET  /balance?key=...
 *                  → { ok, type, credits }  (pro reports 100000, never decremented)
 *   POST /spend    { key: string }
 *                  → { ok, credits }  or 402 when a pack is empty
 *
 * Bindings required:
 *   KV namespace: CREDITS
 *
 * KV layout:
 *   gr:<license-key> → { type: "pack"|"pro", credits?: number, checked: ISO }
 *
 * Pro keys are re-verified against Gumroad at most once per PRO_RECHECK_MS so
 * cancellations take effect within a day without a Gumroad call per request.
 */

const GUMROAD_VERIFY = "https://api.gumroad.com/v2/licenses/verify";
const PRODUCT_PACK = "BgO08xsE7P0XhbGRpUm3Gg==";
const PRODUCT_PRO = "5ve1Khe8KhNCUd6nQ2wZnA==";
const PACK_CREDITS = 10;
const PRO_BALANCE = 100000;
const PRO_RECHECK_MS = 24 * 60 * 60 * 1000;

const ALLOWED_ORIGINS = [
  "https://superwhite.app",
  "https://www.superwhite.app",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/redeem" && request.method === "POST") {
        return await handleRedeem(request, env, cors);
      }
      if (url.pathname === "/balance" && request.method === "GET") {
        return await handleBalance(url, env, cors);
      }
      if (url.pathname === "/spend" && request.method === "POST") {
        return await handleSpend(request, env, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500, cors);
    }
  },
};

/* ---------------- handlers ---------------- */

async function handleRedeem(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const key = cleanKey(body.key);
  if (!key) return json({ error: "Missing key" }, 400, cors);

  // Already redeemed → return current state (idempotent)
  const existing = await getRec(env, key);
  if (existing) {
    if (existing.type === "pro") {
      const rec = await freshenPro(env, key, existing);
      if (!rec) return json({ error: "Subscription inactive" }, 402, cors);
      return json({ ok: true, type: "pro", credits: PRO_BALANCE }, 200, cors);
    }
    return json({ ok: true, type: "pack", credits: existing.credits }, 200, cors);
  }

  // Try pack, then pro
  const pack = await gumroadVerify(PRODUCT_PACK, key, false);
  if (pack && pack.success) {
    const p = pack.purchase || {};
    if (p.refunded || p.chargebacked || p.disputed) {
      return json({ error: "Purchase refunded" }, 402, cors);
    }
    const rec = { type: "pack", credits: PACK_CREDITS, checked: new Date().toISOString() };
    await putRec(env, key, rec);
    return json({ ok: true, type: "pack", credits: rec.credits }, 200, cors);
  }

  const pro = await gumroadVerify(PRODUCT_PRO, key, false);
  if (pro && pro.success) {
    if (!subActive(pro.purchase || {})) {
      return json({ error: "Subscription inactive" }, 402, cors);
    }
    const rec = { type: "pro", checked: new Date().toISOString() };
    await putRec(env, key, rec);
    return json({ ok: true, type: "pro", credits: PRO_BALANCE }, 200, cors);
  }

  return json({ error: "Key not recognized" }, 404, cors);
}

async function handleBalance(url, env, cors) {
  const key = cleanKey(url.searchParams.get("key"));
  if (!key) return json({ error: "Missing key" }, 400, cors);

  const rec = await getRec(env, key);
  if (!rec) return json({ error: "Unknown key" }, 404, cors);

  if (rec.type === "pro") {
    const fresh = await freshenPro(env, key, rec);
    if (!fresh) return json({ error: "Subscription inactive" }, 402, cors);
    return json({ ok: true, type: "pro", credits: PRO_BALANCE }, 200, cors);
  }
  return json({ ok: true, type: "pack", credits: rec.credits || 0 }, 200, cors);
}

async function handleSpend(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const key = cleanKey(body.key);
  if (!key) return json({ error: "Missing key" }, 400, cors);

  const rec = await getRec(env, key);
  if (!rec) return json({ error: "Unknown key" }, 404, cors);

  if (rec.type === "pro") {
    const fresh = await freshenPro(env, key, rec);
    if (!fresh) return json({ error: "Subscription inactive" }, 402, cors);
    return json({ ok: true, credits: PRO_BALANCE }, 200, cors);
  }

  if ((rec.credits || 0) < 1) return json({ ok: false, credits: 0 }, 402, cors);
  rec.credits -= 1;
  await putRec(env, key, rec);
  return json({ ok: true, credits: rec.credits }, 200, cors);
}

/* ---------------- helpers ---------------- */

function subActive(p) {
  return !p.subscription_ended_at && !p.subscription_cancelled_at && !p.subscription_failed_at
    && !p.refunded && !p.chargebacked && !p.disputed;
}

async function freshenPro(env, key, rec) {
  const age = Date.now() - Date.parse(rec.checked || 0);
  if (age < PRO_RECHECK_MS) return rec;
  const res = await gumroadVerify(PRODUCT_PRO, key, false);
  if (!res || !res.success || !subActive(res.purchase || {})) {
    await env.CREDITS.delete(`gr:${key}`);
    return null;
  }
  rec.checked = new Date().toISOString();
  await putRec(env, key, rec);
  return rec;
}

async function gumroadVerify(productId, key, increment) {
  try {
    const r = await fetch(GUMROAD_VERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: productId,
        license_key: key,
        increment_uses_count: increment ? "true" : "false",
      }),
    });
    return await r.json();
  } catch (e) {
    return null;
  }
}

function cleanKey(k) {
  if (typeof k !== "string") return "";
  k = k.trim().toUpperCase();
  return /^[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/.test(k) ? k : "";
}

async function getRec(env, key) {
  const raw = await env.CREDITS.get(`gr:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function putRec(env, key, rec) {
  await env.CREDITS.put(`gr:${key}`, JSON.stringify(rec));
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
