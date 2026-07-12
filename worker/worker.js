/**
 * Superwhite Credits — Cloudflare Worker
 * =======================================
 * Pay-as-you-go credit backend for superwhite.app.
 *
 * Endpoints:
 *   POST /checkout  { pack: "starter"|"creator", key?: string }
 *                   → { url }  (Stripe Checkout URL; key passed through for top-ups)
 *   POST /claim     { session_id: string }
 *                   → { key, credits }  (verifies payment with Stripe, issues/tops up key; idempotent)
 *   GET  /balance?key=SW-xxxx
 *                   → { credits }
 *   POST /spend     { key: string }
 *                   → { ok: true, credits }  or 402 if empty
 *
 * Bindings required:
 *   KV namespace:  CREDITS
 *   Secret:        STRIPE_SECRET_KEY
 *   Vars:          PRICE_STARTER, PRICE_CREATOR
 *
 * KV layout:
 *   key:<SW-key>        → { credits: number, created: ISO, email?: string }
 *   session:<sess_id>   → SW-key that already claimed this session (idempotency guard)
 */

const PACKS = {
  starter: { credits: 10, priceVar: "PRICE_STARTER" },
  creator: { credits: 40, priceVar: "PRICE_CREATOR" },
};

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
      if (url.pathname === "/checkout" && request.method === "POST") {
        return await handleCheckout(request, env, cors);
      }
      if (url.pathname === "/claim" && request.method === "POST") {
        return await handleClaim(request, env, cors);
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

async function handleCheckout(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const pack = PACKS[body.pack];
  if (!pack) return json({ error: "Unknown pack" }, 400, cors);

  const priceId = env[pack.priceVar];
  if (!priceId) return json({ error: "Pack not configured" }, 500, cors);

  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: "https://superwhite.app/?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://superwhite.app/?checkout=cancelled",
    "metadata[pack]": body.pack,
    allow_promotion_codes: "true",
  });

  // Existing key → top-up instead of a new key
  if (typeof body.key === "string" && /^SW-[a-f0-9-]{8,}$/i.test(body.key)) {
    params.set("client_reference_id", body.key);
  }

  const session = await stripe(env, "POST", "/v1/checkout/sessions", params);
  if (!session.url) return json({ error: "Stripe error", detail: session.error && session.error.message }, 502, cors);

  return json({ url: session.url }, 200, cors);
}

async function handleClaim(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const sessionId = body.session_id;
  if (!sessionId || !/^cs_/.test(sessionId)) {
    return json({ error: "Missing session_id" }, 400, cors);
  }

  // Idempotency: a session can only ever be claimed once
  const already = await env.CREDITS.get(`session:${sessionId}`);
  if (already) {
    const rec = await getRecord(env, already);
    return json({ key: already, credits: rec?.credits ?? 0 }, 200, cors);
  }

  const session = await stripe(env, "GET", `/v1/checkout/sessions/${sessionId}`);
  if (session.payment_status !== "paid") {
    return json({ error: "Payment not completed" }, 402, cors);
  }

  const pack = PACKS[session.metadata?.pack];
  if (!pack) return json({ error: "Unknown pack on session" }, 400, cors);

  // Top-up existing key if provided at checkout, otherwise mint a new one
  let key = session.client_reference_id;
  let record = key ? await getRecord(env, key) : null;
  if (!key || !record) {
    key = "SW-" + crypto.randomUUID();
    record = { credits: 0, created: new Date().toISOString() };
  }

  record.credits += pack.credits;
  if (session.customer_details?.email) record.email = session.customer_details.email;

  await env.CREDITS.put(`key:${key}`, JSON.stringify(record));
  await env.CREDITS.put(`session:${sessionId}`, key);

  return json({ key, credits: record.credits }, 200, cors);
}

async function handleBalance(url, env, cors) {
  const key = url.searchParams.get("key") || "";
  const record = await getRecord(env, key);
  if (!record) return json({ error: "Unknown key" }, 404, cors);
  return json({ credits: record.credits }, 200, cors);
}

async function handleSpend(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const record = await getRecord(env, body.key || "");
  if (!record) return json({ error: "Unknown key" }, 404, cors);
  if (record.credits < 1) return json({ error: "No credits left", credits: 0 }, 402, cors);

  record.credits -= 1;
  await env.CREDITS.put(`key:${body.key}`, JSON.stringify(record));
  return json({ ok: true, credits: record.credits }, 200, cors);
}

/* ---------------- helpers ---------------- */

async function getRecord(env, key) {
  if (!/^SW-[a-f0-9-]{8,}$/i.test(key)) return null;
  const raw = await env.CREDITS.get(`key:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function stripe(env, method, path, params) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? params : undefined,
  });
  return res.json();
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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
