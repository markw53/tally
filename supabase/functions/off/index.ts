// ===========================================================================
// off — Open Food Facts search and barcode lookup, the offproxy job as a
// serverless function.
//
// The reason this has to exist at all: Open Food Facts asks every client to
// identify itself with a custom User-Agent, and browsers are forbidden from
// setting that header. So their search endpoints turn away anonymous traffic
// and send no CORS headers to a web page. Here we're not a browser, so we can
// identify ourselves properly, and while we're at it we cache and re-rank.
//
//   GET  /off?q=hovis+wholemeal&limit=20   -> { foods: [...] }
//   GET  /off?code=5000169005460           -> { food: {...} }
//
// Requires a signed-in caller (verify_jwt stays on for this function), so it
// isn't a free Open Food Facts proxy for the whole internet.
// ===========================================================================

import { toFood, rankFoods, type Food } from "./food.ts";

const UA = Deno.env.get("OFF_USER_AGENT") ?? "";
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SEARCH_URL = "https://search.openfoodfacts.org/search";
const PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";

const FIELDS = "code,product_name,product_name_en,generic_name,brands,quantity," +
  "product_quantity,serving_size,serving_quantity,countries_tags,nutriments";

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;      // a day; results barely move
const PRODUCT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a month; a tin of beans is a tin of beans

/* ------------------------------------------------------------------ CORS ---
   An explicit allow-list rather than "*", because a wildcard plus a bearer
   token means any page in the world can spend your project's quota. */
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const ok = ORIGINS.length === 0 || ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req), ...extra },
  });
}

function fail(req: Request, status: number, code: string, message: string) {
  return json(req, status, { error: { code, message } });
}

/* ----------------------------------------------------------------- cache ---
   Shared, in Postgres, so two people scanning the same tin costs one upstream
   request — and so a cold function instance still gets a hit. */
async function cacheGet(k: string, ttlMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/off_cache?k=eq.${encodeURIComponent(k)}&select=payload,fetched_at`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    if (Date.now() - new Date(rows[0].fetched_at).getTime() > ttlMs) return null;
    return rows[0].payload;
  } catch (e) {
    console.warn("cache read failed, going upstream:", e);
    return null;   // a broken cache must never break a lookup
  }
}

async function cachePut(k: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/off_cache`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ k, payload, fetched_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn("cache write failed:", e);
  }
}

/* ------------------------------------------------------------ rate limit ---
   Open Food Facts publishes 10 searches and 100 product reads a minute per IP.
   This bucket is per warm instance, so it is a courtesy brake rather than a
   guarantee — the cache above is what actually keeps the volume down. */
let tokens = 8;
let refilled = Date.now();
function allow(perMinute: number): boolean {
  const now = Date.now();
  tokens = Math.min(perMinute, tokens + ((now - refilled) / 60000) * perMinute);
  refilled = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

async function upstream(url: string): Promise<Response> {
  return await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
}

/* ----------------------------------------------------------------- routes --*/

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "GET") return fail(req, 405, "METHOD", "GET only");

  // Refusing to start without a contact address is deliberate: an anonymous
  // scraper is exactly what Open Food Facts is trying to keep out, and being
  // one would get this project blocked rather than rate-limited.
  if (!UA.trim()) {
    return fail(req, 500, "NO_USER_AGENT",
      "OFF_USER_AGENT is not set on this function — see supabase/README.md");
  }

  const url = new URL(req.url);
  const code = (url.searchParams.get("code") ?? "").trim();
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);

  try {
    if (code) return await handleProduct(req, code);
    if (q) return await handleSearch(req, q, url.searchParams.get("limit"));
    return fail(req, 400, "MISSING_QUERY", "pass ?q= to search or ?code= for a barcode");
  } catch (e) {
    console.error("unhandled:", e);
    return fail(req, 502, "UPSTREAM_UNREACHABLE", "could not reach Open Food Facts");
  }
});

async function handleSearch(req: Request, q: string, limitRaw: string | null) {
  const n = parseInt(limitRaw ?? "", 10);
  const limit = Number.isFinite(n) && n > 0 && n <= 50 ? n : 20;
  const key = "s:" + q.toLowerCase();

  const hit = await cacheGet(key, SEARCH_TTL_MS);
  if (hit) {
    return json(req, 200, { foods: (hit as Food[]).slice(0, limit) }, { "X-Cache": "hit" });
  }

  if (!allow(8)) {
    return json(req, 503, { error: { code: "RATE_LIMITED", message: "search budget spent, try again in a few seconds" } },
      { "Retry-After": "6" });
  }

  const res = await upstream(`${SEARCH_URL}?${new URLSearchParams({ q, page_size: "50", fields: FIELDS })}`);
  if (!res.ok) return fail(req, 502, "UPSTREAM_ERROR", `Open Food Facts returned ${res.status}`);

  const body = await res.json();
  const hits: Record<string, any>[] = body.hits ?? body.products ?? [];

  const foods: Food[] = [];
  const countries: string[][] = [];
  for (const p of hits) {
    const f = toFood(p);
    if (f) { foods.push(f); countries.push(p.countries_tags ?? []); }
  }

  const ranked = rankFoods(foods, countries, q);
  await cachePut(key, ranked);
  return json(req, 200, { foods: ranked.slice(0, limit) }, { "X-Cache": "miss" });
}

async function handleProduct(req: Request, code: string) {
  if (!/^\d{1,14}$/.test(code)) return fail(req, 400, "BAD_BARCODE", "expected a numeric barcode");

  const key = "p:" + code;
  const hit = await cacheGet(key, PRODUCT_TTL_MS);
  if (hit) return json(req, 200, { food: hit }, { "X-Cache": "hit" });

  if (!allow(60)) {
    return json(req, 503, { error: { code: "RATE_LIMITED", message: "product budget spent, try again in a few seconds" } },
      { "Retry-After": "4" });
  }

  const res = await upstream(`${PRODUCT_URL}/${encodeURIComponent(code)}.json?fields=${encodeURIComponent(FIELDS)}`);
  if (!res.ok) return fail(req, 502, "UPSTREAM_ERROR", `Open Food Facts returned ${res.status}`);

  const body = await res.json();
  if (body.status !== 1 || !body.product) {
    return fail(req, 404, "NOT_FOUND", "no such product in Open Food Facts");
  }

  const food = toFood(body.product);
  if (!food) {
    return fail(req, 422, "NO_NUTRITION", "the product exists but has no nutrition data");
  }

  await cachePut(key, food);
  return json(req, 200, { food }, { "X-Cache": "miss" });
}
