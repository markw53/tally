// ===========================================================================
// activity — active energy from Apple Health, posted by an iOS Shortcut.
//
//   POST /activity
//   Authorization: Bearer tk_...              (a device key, not a JWT)
//   { "date": "2026-09-14", "kcal": 612 }
//
// Why a device key rather than signing in: a Shortcut runs unattended at 11pm
// and has nowhere to keep a refresh token or handle an expiry. So this one
// function runs with verify_jwt off and does its own authentication against
// device_keys, where only the SHA-256 of each key is stored.
//
// It writes with the service role, which is what lets the activity table stay
// read-only to every signed-in client. That's the Model A guarantee holding at
// the database level: a phone that has never heard of active energy cannot
// wipe what your watch reported.
// ===========================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",           // Shortcuts sends no Origin
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

const fail = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail(405, "METHOD", "POST only");

  // ---- authenticate the device key -------------------------------------
  const auth = req.headers.get("Authorization") ?? "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) return fail(401, "NO_KEY", "send Authorization: Bearer <device key>");

  // Looking the key up by its hash is itself the comparison, and a SHA-256 of
  // 24 random bytes isn't something you arrive at by guessing, so there's no
  // timing side-channel worth defending here.
  const hash = await sha256Hex(key);
  const lookup = await db(`device_keys?key_hash=eq.${hash}&select=id,user_id`);
  if (!lookup.ok) {
    console.error("device_keys lookup failed:", lookup.status, await lookup.text());
    return fail(500, "LOOKUP_FAILED", "could not check that key");
  }
  const rows = await lookup.json();
  if (!Array.isArray(rows) || !rows.length) return fail(401, "BAD_KEY", "that device key isn't recognised");
  const { id: keyId, user_id: userId } = rows[0];

  // ---- read the body ----------------------------------------------------
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return fail(400, "BAD_JSON", "body should be JSON");
  }

  // Shortcuts formats numbers unpredictably depending on which block produced
  // them, so accept "612", 612 and "612.4" alike rather than failing silently
  // at 11pm when nobody is watching.
  const rawKcal = payload.kcal ?? payload.calories ?? payload.value;
  const kcal = Math.round(Number(typeof rawKcal === "string" ? rawKcal.trim() : rawKcal));
  if (!Number.isFinite(kcal) || kcal < 0 || kcal > 20000) {
    return fail(400, "BAD_KCAL", "kcal should be a number between 0 and 20000");
  }

  // The date has to come from the phone. This function runs on UTC and has no
  // idea where your day boundary is — a 23:30 post from the UK in summer would
  // otherwise land on tomorrow.
  const date = String(payload.date ?? "").trim() ||
    new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail(400, "BAD_DATE", "date should look like 2026-09-14");
  }

  // ---- write ------------------------------------------------------------
  const res = await db("activity", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: userId, date, kcal, updated_at: Date.now(),
    }),
  });
  if (!res.ok) {
    console.error("activity write failed:", res.status, await res.text());
    return fail(500, "WRITE_FAILED", "could not store that reading");
  }

  // Best-effort: a note of when the key was last used, so a forgotten Shortcut
  // is identifiable later. Never worth failing the write for.
  db(`device_keys?id=eq.${keyId}`, {
    method: "PATCH",
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch((e) => console.warn("last_used_at update failed:", e));

  return json(200, { ok: true, date, kcal });
});
