/**
 * Superwhite Credits — Cloudflare Worker (Gumroad edition)
 * ========================================================
 * Entitlement backend for superwhite.app, backed by Gumroad license keys.
 *
 * Endpoints:
 *   POST /redeem   { key: string, clerkUserId?: string }
 *                  → { ok, type: "creator"|"pro" }
 *                  Verifies the key against Gumroad (creator first, then pro).
 *                  Creator keys unlock 1400px forever. Pro keys are accepted
 *                  while the subscription is active. If clerkUserId is given
 *                  and a matching checkout attempt exists, it is marked converted
 *                  so the reminder sweep skips it.
 *   GET  /balance?key=...
 *                  → { ok, type, credits }  (pro reports 100000 for batch compatibility)
 *   POST /spend    { key: string }
 *                  → { ok, credits }  pro only; anything else is 402
 *   POST /checkout-attempt   { clerkUserId: string, email: string, tier: string }
 *                  → { ok: true }
 *                  Logged when a signed-in user clicks through to Gumroad checkout.
 *                  Picked up by the scheduled reminder sweep below.
 *
 * Bindings required:
 *   KV namespace: CREDITS
 *   Secret: RESEND_API_KEY (for the reminder sweep; see sendReminderEmail)
 *
 * KV layout:
 *   gr:<license-key>     → { type: "creator"|"pro", checked: ISO }
 *   attempt:<clerkUserId> → { email, tier, ts: ISO, reminded: bool, converted: bool }
 *
 * Pro keys are re-verified against Gumroad at most once per PRO_RECHECK_MS so
 * cancellations take effect within a day without a Gumroad call per request.
 *
 * Cron trigger (see wrangler.toml) runs the reminder sweep: any checkout
 * attempt older than REMINDER_DELAY_MS, not yet reminded and not converted,
 * gets a single nudge email via Resend.
 */

const GUMROAD_VERIFY = "https://api.gumroad.com/v2/licenses/verify";
const PRODUCT_CREATOR = "BgO08xsE7P0XhbGRpUm3Gg==";
const PRODUCT_PRO = "5ve1Khe8KhNCUd6nQ2wZnA==";
const PRO_BALANCE = 100000;
const PRO_RECHECK_MS = 24 * 60 * 60 * 1000;
const REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
const RESEND_API = "https://api.resend.com/emails";
const REMINDER_FROM = "Nimrod at Superwhite <nimrod@superwhite.app>";
const REMINDER_SUBJECT = "Still want Pro?";
const REMINDER_TEXT = `Hey,

You started upgrading to Superwhite Pro but didn't finish. No pressure, just checking in.

Pro gets you:
- Full resolution exports, up to 3840px
- Batch processing
- Brand presets

\u20ac9/month, cancel anytime.

Finish upgrading: https://nimrodian06.gumroad.com/l/xvdzcy

Nimrod
Superwhite`;

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
      if (url.pathname === "/checkout-attempt" && request.method === "POST") {
        return await handleCheckoutAttempt(request, env, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderSweep(env));
  },
};

/* ---------------- handlers ---------------- */

async function handleRedeem(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const key = cleanKey(body.key);
  if (!key) return json({ error: "Missing key" }, 400, cors);
  const clerkUserId = typeof body.clerkUserId === "string" ? body.clerkUserId : null;

  // Already redeemed → return current state (idempotent)
  const existing = await getRec(env, key);
  if (existing) {
    if (existing.type === "pro") {
      const rec = await freshenPro(env, key, existing);
      if (!rec) return json({ error: "Subscription inactive" }, 402, cors);
      await markAttemptConverted(env, clerkUserId);
      return json({ ok: true, type: "pro", credits: PRO_BALANCE }, 200, cors);
    }
    await markAttemptConverted(env, clerkUserId);
    return json({ ok: true, type: "creator" }, 200, cors);
  }

  // Try creator, then pro
  const creator = await gumroadVerify(PRODUCT_CREATOR, key, false);
  if (creator && creator.success) {
    const p = creator.purchase || {};
    if (p.refunded || p.chargebacked || p.disputed) {
      return json({ error: "Purchase refunded" }, 402, cors);
    }
    const rec = { type: "creator", checked: new Date().toISOString() };
    await putRec(env, key, rec);
    await markAttemptConverted(env, clerkUserId);
    return json({ ok: true, type: "creator" }, 200, cors);
  }

  const pro = await gumroadVerify(PRODUCT_PRO, key, false);
  if (pro && pro.success) {
    if (!subActive(pro.purchase || {})) {
      return json({ error: "Subscription inactive" }, 402, cors);
    }
    const rec = { type: "pro", checked: new Date().toISOString() };
    await putRec(env, key, rec);
    await markAttemptConverted(env, clerkUserId);
    return json({ ok: true, type: "pro", credits: PRO_BALANCE }, 200, cors);
  }

  return json({ error: "Key not recognized" }, 404, cors);
}

async function handleCheckoutAttempt(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const clerkUserId = typeof body.clerkUserId === "string" ? body.clerkUserId : "";
  const email = typeof body.email === "string" ? body.email : "";
  const tier = typeof body.tier === "string" ? body.tier : "unknown";
  if (!clerkUserId || !email) return json({ error: "Missing clerkUserId or email" }, 400, cors);

  // Don't overwrite an already-converted or already-reminded record with a re-click.
  const existing = await getAttempt(env, clerkUserId);
  if (existing && (existing.converted || existing.reminded)) {
    return json({ ok: true }, 200, cors);
  }

  await putAttempt(env, clerkUserId, {
    email, tier, ts: new Date().toISOString(), reminded: false, converted: false,
  });
  return json({ ok: true }, 200, cors);
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
  return json({ ok: true, type: "creator" }, 200, cors);
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

  return json({ ok: false, credits: 0 }, 402, cors);
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

async function getAttempt(env, clerkUserId) {
  if (!clerkUserId) return null;
  const raw = await env.CREDITS.get(`attempt:${clerkUserId}`);
  return raw ? JSON.parse(raw) : null;
}

async function putAttempt(env, clerkUserId, rec) {
  await env.CREDITS.put(`attempt:${clerkUserId}`, JSON.stringify(rec));
}

async function markAttemptConverted(env, clerkUserId) {
  if (!clerkUserId) return;
  const rec = await getAttempt(env, clerkUserId);
  if (!rec || rec.converted) return;
  rec.converted = true;
  await putAttempt(env, clerkUserId, rec);
}

/* ---------------- reminder sweep (cron) ---------------- */

async function runReminderSweep(env) {
  const now = Date.now();
  let cursor;
  do {
    const page = await env.CREDITS.list({ prefix: "attempt:", cursor });
    for (const { name } of page.keys) {
      const raw = await env.CREDITS.get(name);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      if (rec.converted || rec.reminded) continue;
      if (now - Date.parse(rec.ts) < REMINDER_DELAY_MS) continue;

      const sent = await sendReminderEmail(env, rec.email);
      if (sent) {
        rec.reminded = true;
        await env.CREDITS.put(name, JSON.stringify(rec));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function sendReminderEmail(env, to) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY not configured, skipping reminder to", to);
    return false;
  }
  try {
    const r = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: REMINDER_FROM,
        to: [to],
        subject: REMINDER_SUBJECT,
        text: REMINDER_TEXT,
      }),
    });
    return r.ok;
  } catch (e) {
    console.error("Reminder email failed", e);
    return false;
  }
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
