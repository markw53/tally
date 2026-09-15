/* ============================================================
   Tally — a food & calorie diary
   No accounts, no server, no tracking. Everything lives in this
   browser's local storage. Barcode data from Open Food Facts,
   reference foods from USDA FoodData Central.
   ============================================================ */

const VERSION = "1.5.0";
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];
const OFF_FIELDS = "code,product_name,product_name_en,generic_name,brands,quantity,product_quantity,serving_size,serving_quantity,nutriments,nutrition_data_per,image_front_small_url";
const USDA_DEMO = "DEMO_KEY";

/* ---------------- tiny helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const r0 = n => Math.round(n || 0);
const r1 = n => Math.round((n || 0) * 10) / 10;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function addDays(dstr, n) {
  const [y, m, d] = dstr.split("-").map(Number);
  const x = new Date(y, m - 1, d + n);
  return ymd(x);
}
function prettyDate(dstr) {
  const today = ymd(new Date());
  if (dstr === today) return "Today";
  if (dstr === addDays(today, -1)) return "Yesterday";
  if (dstr === addDays(today, 1)) return "Tomorrow";
  const [y, m, d] = dstr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/* ---------------- profiles ----------------
   One install can hold more than one person's diary — a shared iPad, say.
   Each profile's data lives under its own key, so switching can never mix
   two people's entries together. Device-level settings (which server, which
   USDA key) are per profile too, but the sync token is what identifies you. */
const PROFILES_KEY = "tally.profiles";
const LEGACY_KEY = "tally.v1";

let P = loadProfiles();

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.list) && p.list.length) return p;
    }
  } catch (e) { console.warn("Could not read profiles:", e); }

  /* First run, or an upgrade from the single-diary version. Carry the old
     data across rather than stranding it, and leave the old key in place as
     a safety net rather than deleting something irreplaceable. */
  const p = { list: [{ id: "me", label: "Me", token: "" }], active: "me" };
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(dataKeyFor("me"))) {
      localStorage.setItem(dataKeyFor("me"), legacy);
    }
    localStorage.setItem(PROFILES_KEY, JSON.stringify(p));
  } catch (e) { console.warn("Could not migrate old data:", e); }
  return p;
}

function saveProfiles() {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(P)); }
  catch (e) { console.error(e); }
}
function dataKeyFor(id) { return "tally.v1." + id; }
function dataKey() { return dataKeyFor(P.active); }
function activeProfile() { return P.list.find(x => x.id === P.active) || P.list[0]; }
function profileLabel() { const a = activeProfile(); return a ? a.label : "Me"; }

/* ---------------- persistent state ---------------- */
const DEFAULTS = {
  goal: 2000,
  macroPct: { p: 25, c: 45, f: 30 },
  serverUrl: "",    // your offproxy instance; when set it replaces USDA for search
  sbUrl: "",        // your Supabase project URL; when set it takes precedence
  sbKey: "",        // the project's anon key — public by design, safe in here
  usdaKey: "",
  diary: {},        // "YYYY-MM-DD" -> { Breakfast:[entry], ... }
  custom: [],       // user-created foods (shared with the household when syncing)
  recent: [],       // recently logged foods (newest first)
  counts: {},       // foodKey -> times logged
  weights: {},      // "YYYY-MM-DD" -> kg
  activity: {},     // "YYYY-MM-DD" -> kcal of active energy, from a watch via the server
  offCache: {},     // barcode -> food
  seenIntro: false,
  /* sync bookkeeping: what changed when, so a merge can pick a winner */
  dayStamps: {},    // "YYYY-MM-DD" -> ms
  weightStamps: {}, // "YYYY-MM-DD" -> ms
  settingsStamp: 0,
  foodStamps: {},   // food id -> ms
  deletedFoods: {}, // food id -> ms (tombstones, so a delete isn't undone by a stale device)
  lastSync: 0
};

let S = load();

function load() {
  try {
    const raw = localStorage.getItem(dataKey());
    return raw ? Object.assign(structuredClone(DEFAULTS), JSON.parse(raw)) : structuredClone(DEFAULTS);
  } catch (e) {
    console.warn("Could not read saved data:", e);
    return structuredClone(DEFAULTS);
  }
}
let saveTimer = null;
function save(andSync = true) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(dataKey(), JSON.stringify(S)); }
    catch (e) { toast("Couldn't save — storage may be full"); console.error(e); }
  }, 80);
  if (andSync) scheduleSync();
}

/* Mark a day as touched now, so the merge knows this device has the newer
   version of it. Without this an older device could overwrite the day. */
function touchDay(date) { S.dayStamps[date] = Date.now(); }

/* ---------------- food model ---------------- */
/* A food:  {id,name,brand,code,source,cat,per100:{k,p,c,f,fib,sug,sal},portions:[{label,g}]} */

const GRAM_PORTION = { label: "grams", g: 1, gram: true };

function foodKey(f) { return `${f.source}:${f.code || f.name}`.toLowerCase(); }

function macrosFor(food, grams) {
  const m = grams / 100, n = food.per100 || {};
  return {
    k: (n.k || 0) * m, p: (n.p || 0) * m,
    c: (n.c || 0) * m, f: (n.f || 0) * m
  };
}

/* built-in reference foods -> food objects */
const BUILTIN = BUILTIN_FOODS.map(row => {
  const [name, cat, k, p, c, f, plabel, pg, extra] = row;
  const portions = [{ label: plabel, g: pg }];
  (extra || []).forEach(([l, g]) => portions.push({ label: l, g }));
  if (!portions.some(x => x.g === 100)) portions.push({ label: "100 g", g: 100 });
  portions.push(GRAM_PORTION);
  return { id: "b_" + name, name, cat, source: "builtin", per100: { k, p, c, f }, portions };
});

/* ---------------- Open Food Facts ---------------- */
function offToFood(p) {
  const n = p.nutriments || {};
  let k = num(n["energy-kcal_100g"]);
  if (k == null) {
    const kj = num(n["energy_100g"]);
    if (kj != null && (n.energy_unit || "kJ").toLowerCase() === "kj") k = kj / 4.184;
    else if (kj != null) k = kj;
  }
  if (k == null) return null;

  const brand = Array.isArray(p.brands) ? p.brands[0] : (p.brands || "").split(",")[0].trim();
  const name = (p.product_name || p.product_name_en || p.generic_name || "").trim() || `Barcode ${p.code}`;

  const portions = [];
  const sq = num(p.serving_quantity);
  if (sq && sq > 0 && sq < 2000) {
    const lbl = (p.serving_size || "").trim();
    portions.push({ label: lbl ? `serving — ${lbl}` : `serving (${r0(sq)} g)`, g: sq });
  }
  const pq = num(p.product_quantity);
  if (pq && pq > 0 && pq < 5000 && pq !== sq) {
    portions.push({ label: `whole pack (${r0(pq)} g)`, g: pq });
  }
  portions.push({ label: "100 g", g: 100 });
  portions.push(GRAM_PORTION);

  return {
    id: "o_" + p.code, name, brand, code: p.code, source: "off",
    img: p.image_front_small_url || "",
    per100: {
      k, p: num(n["proteins_100g"]) || 0, c: num(n["carbohydrates_100g"]) || 0,
      f: num(n["fat_100g"]) || 0, fib: num(n["fiber_100g"]),
      sug: num(n["sugars_100g"]), sal: num(n["salt_100g"])
    },
    portions
  };
}

/* Your own offproxy instance, if you're running one. Trailing slashes trimmed
   so both "https://x.dev" and "https://x.dev/" behave the same. */
function serverBase() { return (S.serverUrl || "").trim().replace(/\/+$/, ""); }

async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, "");
  if (S.offCache[code]) return S.offCache[code];

  let food;
  const via = backend();
  if (via) {
    try {
      food = via === "supabase" ? await sbProduct(code) : await proxyProduct(code);
    } catch (e) {
      /* "no such product" and "no nutrition data" are real answers — going to
         Open Food Facts directly would only get the same reply. But if the
         server is simply unreachable or busy, fall back: Open Food Facts'
         product endpoint works from the browser, and a scanner that dies in
         the supermarket because a server at home is off is useless. The same
         goes for a signed-out session or a paused Supabase project. */
      if (e.notFound || e.noNutrition) throw e;
      console.warn("Lookup service unavailable, going direct to Open Food Facts:", e.message);
      food = await directProduct(code);
    }
  } else {
    food = await directProduct(code);
  }

  S.offCache[code] = food;
  const keys = Object.keys(S.offCache);
  if (keys.length > 400) delete S.offCache[keys[0]];
  save();
  return food;
}

/* barcode straight from Open Food Facts — their product endpoint allows CORS */
async function directProduct(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);
  const j = await res.json();
  if (j.status !== 1 || !j.product) { const e = new Error("not-found"); e.notFound = true; throw e; }
  const food = offToFood(j.product);
  if (!food) { const e = new Error("no-nutrition"); e.noNutrition = true; e.raw = j.product; throw e; }
  return food;
}

/* barcode via your own server — adds a proper User-Agent and shared caching */
async function proxyProduct(code) {
  let res;
  try {
    res = await fetch(`${serverBase()}/api/product/${encodeURIComponent(code)}`);
  } catch (e) {
    const err = new Error("unreachable");
    err.server = true;
    err.kind = location.protocol === "file:" ? "file" : "network";
    throw err;
  }
  if (res.status === 404) { const e = new Error("not-found"); e.notFound = true; throw e; }
  if (res.status === 422) { const e = new Error("no-nutrition"); e.noNutrition = true; throw e; }
  if (!res.ok) {
    const e = new Error("server " + res.status);
    e.server = true; e.status = res.status;
    e.kind = res.status === 503 ? "rate" : (res.status === 502 ? "upstream" : "http");
    throw e;
  }
  const j = await res.json();
  if (!j.food) { const e = new Error("no-nutrition"); e.noNutrition = true; throw e; }
  return normaliseFood(j.food);
}

/* The server already sends our own Food shape; just make sure the portion list
   is usable, since the portion sheet assumes at least one entry plus grams. */
function normaliseFood(f) {
  const ports = Array.isArray(f.portions) ? f.portions.slice() : [];
  if (!ports.some(p => p.g === 100)) ports.push({ label: "100 g", g: 100 });
  if (!ports.some(p => p.gram)) ports.push(GRAM_PORTION);
  return Object.assign({}, f, { source: f.source || "off", portions: ports });
}

/* ============================================================
   SUPABASE BACKEND

   The alternative to running offproxy yourself: Supabase's free
   tier gives Postgres, accounts and two small serverless
   functions for nothing, with no machine of your own left on.

   There's no SDK here on purpose. Supabase's REST API is plain
   HTTP, and pulling ~120 KB of library off a CDN would cost this
   app its "works with no network" property for no gain.

   Which backend is in use is derived rather than configured: a
   project URL and key mean Supabase, otherwise an offproxy
   address means offproxy, otherwise neither.
   ============================================================ */

function sbBase() { return (S.sbUrl || "").trim().replace(/\/+$/, ""); }
function sbConfigured() { return !!(sbBase() && (S.sbKey || "").trim()); }

function backend() {
  if (sbConfigured()) return "supabase";
  if (serverBase()) return "offproxy";
  return "";
}

/* The session lives beside the profile it belongs to, so a shared iPad can
   hold Mark signed in and Claire signed in at once and switching between
   them doesn't mean signing in again. */
function sbSession() { const p = activeProfile(); return (p && p.session) || null; }
function sbSignedIn() { return !!(sbSession() && sbSession().refresh_token); }
function sbEmail() { const s = sbSession(); return s ? s.email || "" : ""; }

function sbSetSession(sess) {
  const p = activeProfile();
  if (!p) return;
  p.session = sess;
  saveProfiles();
}

function sbHeaders(token) {
  const h = { "Content-Type": "application/json", apikey: (S.sbKey || "").trim() };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

function sbAuthError(status, body) {
  const msg = (body && (body.error_description || body.msg || body.message)) || "";
  const e = new Error(msg || "auth " + status);
  e.status = status;
  if (status === 400 || status === 401) e.auth = true;
  e.detail = msg;
  return e;
}

async function sbSignIn(email, password) {
  const res = await fetch(`${sbBase()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: sbHeaders(),
    body: JSON.stringify({ email: email.trim(), password })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw sbAuthError(res.status, body);

  sbSetSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in || 3600) * 1000,
    email: (body.user && body.user.email) || email.trim(),
    user_id: body.user && body.user.id
  });
  return sbSession();
}

/* Access tokens last an hour. Refresh a minute early rather than letting a
   sync fail and having to explain why. */
let sbRefreshing = null;
async function sbToken() {
  const s = sbSession();
  if (!s) { const e = new Error("signed out"); e.auth = true; throw e; }
  if (s.access_token && Date.now() < (s.expires_at || 0) - 60000) return s.access_token;
  if (sbRefreshing) return sbRefreshing;

  sbRefreshing = (async () => {
    const res = await fetch(`${sbBase()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* A refused refresh token is gone for good — the password changed, or
         the session was revoked. Clear it so the UI asks for a sign-in
         instead of retrying forever. */
      if (res.status === 400 || res.status === 401) sbSetSession(null);
      throw sbAuthError(res.status, body);
    }
    sbSetSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token || s.refresh_token,
      expires_at: Date.now() + (body.expires_in || 3600) * 1000,
      email: (body.user && body.user.email) || s.email,
      user_id: (body.user && body.user.id) || s.user_id
    });
    return body.access_token;
  })().finally(() => { sbRefreshing = null; });

  return sbRefreshing;
}

function sbSignOut() {
  const s = sbSession();
  if (s && s.access_token) {
    /* Best effort — if it fails the local session is cleared anyway, which is
       what actually matters on this device. */
    fetch(`${sbBase()}/auth/v1/logout`, { method: "POST", headers: sbHeaders(s.access_token) })
      .catch(() => {});
  }
  sbSetSession(null);
}

/* A stored procedure call. All the merging happens in Postgres — see
   supabase/schema.sql — so this is one round trip per half of the sync. */
async function sbRpc(fn, args) {
  const token = await sbToken();
  let res;
  try {
    res = await fetch(`${sbBase()}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: sbHeaders(token), body: JSON.stringify(args || {})
    });
  } catch (e) {
    const err = new Error("unreachable");
    err.server = true;
    err.kind = location.protocol === "file:" ? "file" : "network";
    throw err;
  }
  if (res.status === 401) { const e = new Error("unauthorized"); e.auth = true; throw e; }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.message || j.hint || j.error || ""; } catch (e) { /* not JSON */ }
    const e = new Error("http " + res.status);
    e.status = res.status; e.detail = detail;
    /* A missing function means the SQL was never run — worth saying so plainly
       rather than showing a bare 404. */
    if (res.status === 404) e.noSchema = true;
    throw e;
  }
  return res.json();
}

async function sbFn(path, { signal } = {}) {
  const token = await sbToken();
  let res;
  try {
    res = await fetch(`${sbBase()}/functions/v1/${path}`, { headers: sbHeaders(token), signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    const err = new Error("unreachable");
    err.server = true;
    err.kind = location.protocol === "file:" ? "file" : "network";
    throw err;
  }
  return res;
}

async function sbSearch(q, signal) {
  const res = await sbFn(`off?${new URLSearchParams({ q, limit: "20" })}`, { signal });
  if (!res.ok) {
    let detail = "", code = "";
    try { const j = await res.json(); detail = (j.error && j.error.message) || ""; code = (j.error && j.error.code) || ""; } catch (e) { /* not JSON */ }
    const e = new Error("search " + res.status);
    e.server = true; e.status = res.status; e.detail = detail;
    e.kind = res.status === 503 ? "rate" : (res.status === 404 ? "nofunc" : (res.status === 502 ? "upstream" : "http"));
    if (code === "NO_USER_AGENT") e.kind = "noua";
    throw e;
  }
  const j = await res.json();
  return (j.foods || []).map(normaliseFood);
}

async function sbProduct(code) {
  const res = await sbFn(`off?${new URLSearchParams({ code })}`);
  if (res.status === 404) { const e = new Error("not-found"); e.notFound = true; throw e; }
  if (res.status === 422) { const e = new Error("no-nutrition"); e.noNutrition = true; throw e; }
  if (!res.ok) {
    const e = new Error("server " + res.status);
    e.server = true; e.status = res.status;
    e.kind = res.status === 503 ? "rate" : "http";
    throw e;
  }
  const j = await res.json();
  if (!j.food) { const e = new Error("no-nutrition"); e.noNutrition = true; throw e; }
  return normaliseFood(j.food);
}

/* Issued once and never recoverable — only its hash is kept. Used by the iOS
   Shortcut, which has nowhere to keep a refreshable session. */
async function sbIssueDeviceKey(label) {
  return sbRpc("issue_device_key", { p_label: label || "iPhone" });
}

/* ============================================================
   SYNC
   Diaries are per account and private — to their sync token on
   offproxy, or to their sign-in on Supabase. The food library is
   shared across the household on purpose.
   ============================================================ */

let syncTimer = null, syncing = false;
let syncStatus = { state: "idle", at: 0, msg: "" };   // idle | ok | error | off

function syncEnabled() {
  if (backend() === "supabase") return sbSignedIn();
  return !!(serverBase() && (activeProfile().token || "").trim());
}

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: "Bearer " + activeProfile().token.trim() };
}

function scheduleSync(delay = 4000) {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

/* What this device believes, with timestamps so the server can merge rather
   than overwrite. Note that serverUrl/usdaKey are deliberately NOT synced —
   they're device configuration, not diary data. */
function diaryPayload() {
  const days = {};
  for (const [date, meals] of Object.entries(S.diary)) {
    days[date] = { updatedAt: S.dayStamps[date] || 0, meals };
  }
  const weights = {};
  for (const [date, kg] of Object.entries(S.weights)) {
    weights[date] = { updatedAt: S.weightStamps[date] || 0, value: kg };
  }
  return {
    days, weights,
    settings: { updatedAt: S.settingsStamp || 0, value: { goal: S.goal, macroPct: S.macroPct } }
  };
}

function applyDiary(doc) {
  if (!doc) return;
  const diary = {}, stamps = {};
  for (const [date, d] of Object.entries(doc.days || {})) {
    if (!d || !d.meals) continue;
    diary[date] = d.meals;
    stamps[date] = d.updatedAt || 0;
  }
  S.diary = diary;
  S.dayStamps = stamps;

  const weights = {}, wstamps = {};
  for (const [date, wv] of Object.entries(doc.weights || {})) {
    if (!wv || wv.value == null) continue;
    weights[date] = wv.value;
    wstamps[date] = wv.updatedAt || 0;
  }
  S.weights = weights;
  S.weightStamps = wstamps;

  /* Read-only here: the watch feed is written by /api/activity, never by us. */
  const act = {};
  for (const [date, av] of Object.entries(doc.activity || {})) {
    if (av && av.value != null) act[date] = av.value;
  }
  S.activity = act;

  if (doc.settings && doc.settings.value && (doc.settings.updatedAt || 0) >= (S.settingsStamp || 0)) {
    const v = doc.settings.value;
    if (typeof v.goal === "number") S.goal = v.goal;
    if (v.macroPct) S.macroPct = v.macroPct;
    S.settingsStamp = doc.settings.updatedAt || 0;
  }
}

function foodsPayload() {
  const foods = {};
  S.custom.forEach(f => { foods[f.id] = { updatedAt: S.foodStamps[f.id] || 0, food: f }; });
  for (const [id, ts] of Object.entries(S.deletedFoods || {})) {
    foods[id] = { updatedAt: ts, deleted: true };
  }
  return { foods };
}

function applyFoods(map) {
  const list = [], stamps = {}, dels = {};
  for (const [id, e] of Object.entries(map || {})) {
    stamps[id] = e.updatedAt || 0;
    if (e.deleted) dels[id] = e.updatedAt || 0;
    else if (e.food) list.push(Object.assign({}, e.food, { id, source: "custom" }));
  }
  list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  S.custom = list;
  S.foodStamps = stamps;
  S.deletedFoods = dels;
}

async function syncPost(path, body) {
  const res = await fetch(serverBase() + path, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body)
  });
  if (res.status === 401) { const e = new Error("unauthorized"); e.auth = true; throw e; }
  if (res.status === 501) { const e = new Error("no-sync"); e.noSync = true; throw e; }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = (j.error && j.error.message) || ""; } catch (err) { /* not JSON */ }
    const e = new Error("http " + res.status); e.status = res.status; e.detail = detail; throw e;
  }
  return res.json();
}

async function syncNow(manual = false) {
  if (!syncEnabled()) {
    if (manual) toast("Set a server and a sync token first");
    return false;
  }
  if (syncing) return false;
  syncing = true;
  clearTimeout(syncTimer);
  if (manual) toast("Syncing…");

  try {
    if (backend() === "supabase") {
      const p = diaryPayload();
      /* Postgres does the merging; the payload shape is identical to the Go
         server's, so applyDiary/applyFoods don't care which answered. */
      const d = await sbRpc("sync_diary", {
        p_days: p.days, p_weights: p.weights, p_settings: p.settings
      });
      applyDiary(d);

      const f = await sbRpc("sync_foods", { p_foods: foodsPayload().foods });
      applyFoods(f.foods);
    } else {
      const d = await syncPost("/api/diary", diaryPayload());
      applyDiary(d.diary);

      const f = await syncPost("/api/foods", foodsPayload());
      applyFoods(f.foods);
    }

    S.lastSync = Date.now();
    syncStatus = { state: "ok", at: S.lastSync, msg: "" };
    save(false);                       // don't let saving trigger another sync
    if (curView === "today") renderToday();
    else if (curView === "foods") renderFoods();
    else if (curView === "trends") renderTrends();
    if (manual) toast("Synced");
    if (curView === "settings") renderSettings();
    return true;
  } catch (e) {
    syncStatus = { state: "error", at: Date.now(), msg: syncErrorText(e) };
    console.warn("Sync failed:", e);
    if (manual) { toast("Sync failed"); if (curView === "settings") renderSettings(); }
    return false;
  } finally {
    syncing = false;
  }
}

function syncErrorText(e) {
  if (backend() === "supabase") {
    if (e.auth) return "Signed out — sign in again under Sync to start syncing.";
    if (e.noSchema) return "That project doesn't have Tally's tables yet. Run supabase/schema.sql in the SQL Editor.";
    if (e.status) return `Supabase returned HTTP ${e.status}${e.detail ? " — " + e.detail : ""}.`;
    return "Couldn't reach Supabase. Your entries are saved on this device and will sync when it's back.";
  }
  if (e.auth) return "The server didn't recognise that sync token. Check it matches one in OFFPROXY_ACCOUNTS.";
  if (e.noSync) return "That server is running, but sync isn't switched on (no OFFPROXY_DATA / OFFPROXY_ACCOUNTS).";
  if (e.status) return `The server returned HTTP ${e.status}${e.detail ? " — " + e.detail : ""}.`;
  return "Couldn't reach the server. Your entries are saved on this device and will sync when it's back.";
}

function syncSummary() {
  if (backend() === "supabase") {
    if (!sbSignedIn()) return "Not signed in, so this device is keeping its diary to itself.";
    if (syncStatus.state === "error") return syncStatus.msg;
    if (!S.lastSync) return `Signed in as ${sbEmail()}. Not synced yet.`;
  }
  if (!backend()) return "No server set — this device keeps its diary to itself.";
  if (backend() === "offproxy" && !(activeProfile().token || "").trim()) {
    return "No sync token for this profile, so nothing is being synced.";
  }
  if (syncStatus.state === "error") return syncStatus.msg;
  if (!S.lastSync) return "Not synced yet.";
  const mins = Math.round((Date.now() - S.lastSync) / 60000);
  if (mins < 1) return "Synced just now.";
  if (mins < 60) return `Synced ${mins} minute${mins === 1 ? "" : "s"} ago.`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Synced ${hrs} hour${hrs === 1 ? "" : "s"} ago.`;
  return `Last synced ${new Date(S.lastSync).toLocaleDateString("en-GB")}.`;
}

/* ---------------- switching profile ---------------- */
async function switchProfile(id) {
  if (id === P.active) return;
  if (syncEnabled()) await syncNow();     // flush this person's work before leaving
  clearTimeout(saveTimer);
  try { localStorage.setItem(dataKey(), JSON.stringify(S)); } catch (e) { console.error(e); }

  P.active = id;
  saveProfiles();
  S = load();
  syncStatus = { state: "idle", at: 0, msg: "" };
  curDate = ymd(new Date());
  renderWhoBar();
  show("today");
  toast(`Now logging as ${profileLabel()}`);
  if (syncEnabled()) syncNow();
}

/* ---------------- text search ---------------- */

/* With ~2,900 UK reference foods built in, a network search is a bonus rather
   than the main event. Your server if you have one; USDA only if you've gone
   to the trouble of getting a key; otherwise nothing, and no key to set up. */
function remoteSearchAvailable() {
  if (backend() === "supabase") return sbSignedIn();
  return !!serverBase() || !!(S.usdaKey || "").trim();
}
async function searchRemote(q, signal) {
  if (backend() === "supabase" && sbSignedIn()) return sbSearch(q, signal);
  if (serverBase()) return proxySearch(q, signal);
  if ((S.usdaKey || "").trim()) return usdaSearch(q, signal);
  return [];
}
function searchSourceLabel() {
  return backend() ? "Open Food Facts" : "Reference foods (USDA)";
}

async function proxySearch(q, signal) {
  const url = `${serverBase()}/api/search?` + new URLSearchParams({ q, limit: "20" });
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    const err = new Error("unreachable");
    err.server = true;
    err.kind = location.protocol === "file:" ? "file" : "network";
    throw err;
  }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.code)) || ""; } catch (e) { /* not JSON */ }
    const err = new Error("server " + res.status);
    err.server = true; err.status = res.status; err.detail = detail;
    err.kind = res.status === 503 ? "rate" : (res.status === 502 ? "upstream" : "http");
    throw err;
  }
  const j = await res.json();
  return (j.foods || []).map(normaliseFood);
}

/* ---------------- USDA FoodData Central ---------------- */
const USDA_IDS = { 1008: "k", 1003: "p", 1004: "f", 1005: "c", 1079: "fib", 2000: "sug", 1093: "sal" };

/* USDA's endpoint intermittently answers with an nginx 400 that has nothing to
   do with the request — observed 3 times in 10 identical calls. Treat those as
   transient and give it one more go rather than reporting a fault. */
const USDA_TRANSIENT = new Set([400, 500, 502, 503, 504]);

async function usdaSearch(q, signal, attempt = 0) {
  const key = (S.usdaKey || "").trim() || USDA_DEMO;
  const url = "https://api.nal.usda.gov/fdc/v1/foods/search?" + new URLSearchParams({
    query: q, api_key: key, pageSize: "20",
    /* "Survey (FNDDS)" is deliberately omitted: its encoded parentheses were the
       one variant that failed on its own, and Foundation + SR Legacy already
       cover generic foods. UK foods come from CoFID anyway. */
    dataType: "Foundation,SR Legacy"
  });
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    /* fetch only rejects for network-level failures: offline, blocked by an
       extension or browser shield, or an opaque file:// origin */
    const err = new Error("unreachable");
    err.kind = location.protocol === "file:" ? "file" : "network";
    throw err;
  }

  if (!res.ok) {
    if (USDA_TRANSIENT.has(res.status) && attempt === 0) {
      await new Promise(r => setTimeout(r, 400));
      if (signal && signal.aborted) { const a = new Error("aborted"); a.name = "AbortError"; throw a; }
      return usdaSearch(q, signal, 1);
    }
    let detail = "";
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.code)) || ""; } catch (e) { /* often an nginx HTML page */ }
    const err = new Error("http " + res.status);
    err.status = res.status;
    err.detail = detail;
    err.kind = res.status === 429 ? "rate" : (res.status === 403 ? "key" : "http");
    throw err;
  }

  const j = await res.json();

  return (j.foods || []).map(f => {
    const per100 = {};
    (f.foodNutrients || []).forEach(n => {
      const slot = USDA_IDS[n.nutrientId];
      if (slot && per100[slot] == null) per100[slot] = num(n.value);
    });
    if (per100.sal == null && per100.salt == null) { /* sodium mg -> salt g */ }
    if (per100.k == null) return null;
    let desc = (f.description || "").replace(/\s+/g, " ").trim();
    desc = desc.charAt(0).toUpperCase() + desc.slice(1);
    return {
      id: "u_" + f.fdcId, name: desc, brand: f.brandOwner || "", source: "usda",
      cat: f.foodCategory || "Reference",
      per100: { k: per100.k, p: per100.p || 0, c: per100.c || 0, f: per100.f || 0, fib: per100.fib, sug: per100.sug },
      portions: [{ label: "100 g", g: 100 }, { label: "portion (150 g)", g: 150 }, GRAM_PORTION]
    };
  }).filter(Boolean);
}

/* ---------------- local search & ranking ---------------- */
function scoreMatch(name, brand, q) {
  const hay = (name + " " + (brand || "")).toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.every(t => hay.includes(t))) return 0;
  let s = 10;
  /* CoFID names read "Bread, wholemeal, average" — the bit before the first
     comma is the food itself, so a match there beats a match in the qualifiers.
     Without this, searching "bread" surfaces "Sauce, bread" above actual loaves. */
  const head = name.toLowerCase().split(",")[0];
  if (terms.some(t => head.includes(t))) s += 5;
  if (hay.startsWith(terms[0])) s += 6;
  if (hay === q.toLowerCase()) s += 10;
  s -= Math.min(4, hay.length / 40);
  return s;
}

/* A CoFID row becomes a food object only when it's actually going to be shown —
   building 2,800 objects on every keystroke would be wasteful. */
function ukFood(row, i) {
  const [name, cat, k, p, c, f, fib, sug, sal] = row;
  return {
    id: "uk_" + i, name, cat, source: "cofid",
    per100: {
      k, p, c, f,
      fib: fib == null ? null : fib,
      sug: sug == null ? null : sug,
      sal: sal == null ? null : sal
    },
    portions: [{ label: "100 g", g: 100 }, GRAM_PORTION]
  };
}

function localSearch(q) {
  if (!q) return [];
  const scored = [];

  /* Your own foods and the curated list rank slightly above CoFID, because
     they carry real portion sizes ("slice (40 g)") rather than just per-100 g. */
  [...S.custom, ...BUILTIN].forEach(f => {
    const s = scoreMatch(f.name, f.brand, q);
    if (s > 0) scored.push({ f, s: s + 3 + (S.counts[foodKey(f)] || 0) * 0.4 });
  });

  if (typeof UK_FOODS !== "undefined") {
    for (let i = 0; i < UK_FOODS.length; i++) {
      const s = scoreMatch(UK_FOODS[i][0], "", q);
      if (s > 0) scored.push({ row: UK_FOODS[i], i, s });
    }
  }

  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 40).map(x => x.f || ukFood(x.row, x.i));
}

function frequentFoods(limit = 12) {
  const seen = new Map();
  S.recent.forEach(f => { const k = foodKey(f); if (!seen.has(k)) seen.set(k, f); });
  return [...seen.values()]
    .sort((a, b) => (S.counts[foodKey(b)] || 0) - (S.counts[foodKey(a)] || 0))
    .slice(0, limit);
}

/* ---------------- diary maths ---------------- */
let curDate = ymd(new Date());

function dayData(d) {
  if (!S.diary[d]) S.diary[d] = {};
  MEALS.forEach(m => { if (!S.diary[d][m]) S.diary[d][m] = []; });
  return S.diary[d];
}
function dayTotals(d) {
  const t = { k: 0, p: 0, c: 0, f: 0 };
  const day = S.diary[d];
  if (!day) return t;
  MEALS.forEach(m => (day[m] || []).forEach(e => {
    const v = macrosFor(e, e.grams);
    t.k += v.k; t.p += v.p; t.c += v.c; t.f += v.f;
  }));
  return t;
}
function macroTargets() {
  const g = S.goal, m = S.macroPct;
  return { p: (g * m.p / 100) / 4, c: (g * m.c / 100) / 4, f: (g * m.f / 100) / 9 };
}

/* ---------------- toast ---------------- */
let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $("#toast"), b = $("#toastAction");
  $("#toastMsg").textContent = msg;
  if (actionLabel) { b.textContent = actionLabel; b.hidden = false; b.onclick = () => { hideToast(); action && action(); }; }
  else b.hidden = true;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2600);
}
function hideToast() { $("#toast").hidden = true; }

/* ============================================================
   VIEWS
   ============================================================ */
/* The whose-diary strip. Only shown when there's more than one profile on
   this device — but then it's shown on every screen, because logging your
   lunch into your wife's diary is the one mistake that must not be easy. */
function renderWhoBar() {
  const many = P.list.length > 1;
  $$(".whobar").forEach(b => {
    b.hidden = !many;
    if (!many) return;
    b.innerHTML = `<span class="dot"></span><b>${esc(profileLabel())}</b><span class="swap">switch</span>`;
    b.onclick = openProfilePicker;
  });
}

function openProfilePicker() {
  const body = P.list.map(p =>
    `<button class="res" data-profile="${esc(p.id)}">
       <div class="txt"><div class="nm">${esc(p.label)}</div>
       <div class="sub">${p.id === P.active ? "currently logging" : (p.token ? "syncs to the server" : "this device only")}</div></div>
       ${p.id === P.active ? '<span class="tagpill">active</span>' : ""}
     </button>`).join("");
  $("#addTitle").textContent = "Who's logging?";
  $("#addSheet").hidden = false;
  $(".searchrow").hidden = true;
  $("#srcChips").hidden = true;
  $("#results").innerHTML = body +
    `<div class="hint" style="text-align:left;padding-top:14px">Add or rename people in <b>More → Who uses this device</b>.</div>`;
  $("#results").onclick = e => {
    const b = e.target.closest("[data-profile]");
    if (!b) return;
    closeSheets();
    switchProfile(b.dataset.profile);
  };
}

let curView = "today";
function show(view) {
  curView = view;
  ["today", "foods", "trends", "settings"].forEach(v => { $("#view-" + v).hidden = v !== view; });
  $$(".tab").forEach(b => b.classList.toggle("is-on", b.dataset.view === view));
  if (view === "today") renderToday();
  if (view === "foods") renderFoods();
  if (view === "trends") renderTrends();
  if (view === "settings") renderSettings();
}

/* ---------------- Today ---------------- */
function renderToday() {
  $("#dayLabel").textContent = prettyDate(curDate);
  const t = dayTotals(curDate), goal = S.goal, left = goal - t.k;

  $("#kcalLeft").textContent = r0(Math.abs(left));
  $("#kcalLeftLabel").textContent = left < 0 ? "over" : "left";
  $("#sumGoal").textContent = r0(goal);
  $("#sumFood").textContent = r0(t.k);
  $("#sumLeft").textContent = r0(left);

  const C = 2 * Math.PI * 52;
  const frac = clamp(goal ? t.k / goal : 0, 0, 1);
  const fg = $("#ringFg");
  fg.style.strokeDashoffset = String(C * (1 - frac));
  fg.classList.toggle("over", t.k > goal);

  const tg = macroTargets();
  $("#macroBars").innerHTML = [
    ["Protein", t.p, tg.p, "var(--p)"],
    ["Carbs", t.c, tg.c, "var(--c)"],
    ["Fat", t.f, tg.f, "var(--f)"]
  ].map(([label, v, target, col]) => `
    <div class="macro">
      <div class="mtop"><span>${label}</span><b>${r0(v)}<span style="color:var(--ink-3);font-weight:400">/${r0(target)}g</span></b></div>
      <div class="mbar"><i style="width:${clamp(target ? v / target * 100 : 0, 0, 100)}%;background:${col}"></i></div>
    </div>`).join("");

  const day = dayData(curDate);
  $("#meals").innerHTML = MEALS.map(m => {
    const items = day[m] || [];
    const kc = items.reduce((a, e) => a + macrosFor(e, e.grams).k, 0);
    return `
      <div class="meal">
        <div class="meal-head">
          <h3>${m}</h3>
          <span class="kc">${kc ? r0(kc) + " kcal" : ""}</span>
          <button class="meal-add" data-addmeal="${m}" aria-label="Add to ${m}">+</button>
        </div>
        ${items.length ? items.map((e, i) => {
          const v = macrosFor(e, e.grams);
          const sub = [e.brand, e.portionLabel].filter(Boolean).join(" · ");
          return `<div class="entry">
              <div class="txt">
                <div class="nm">${esc(e.name)}</div>
                <div class="sub">${esc(sub)} · P${r0(v.p)} C${r0(v.c)} F${r0(v.f)}</div>
              </div>
              <div class="kc">${r0(v.k)}</div>
              <button class="del" data-del="${m}|${i}" aria-label="Remove">✕</button>
            </div>`;
        }).join("") : `<div class="empty">Nothing logged yet</div>`}
      </div>`;
  }).join("");

  /* Model A: active energy is shown, never spent. The goal already came from
     a TDEE estimate with an activity multiplier, so adding a measured burn on
     top would count the same exercise twice. See More -> Daily goal. */
  const active = S.activity ? S.activity[curDate] : null;
  const actEl = $("#activeLine");
  if (active != null && active > 0) {
    actEl.hidden = false;
    actEl.innerHTML = `<span class="dot"></span>${r0(active)} kcal active` +
      `<small>not added to your goal</small>`;
  } else {
    actEl.hidden = true;
  }

  const note = $("#dayNote");
  if (t.k === 0) note.textContent = "Tap the ❙❙❙ button to scan a barcode, or + on a meal to search.";
  else if (left < 0) note.textContent = `${r0(-left)} kcal over your goal today.`;
  else note.textContent = "";
}

/* ---------------- Foods ---------------- */
function renderFoods() {
  const freq = frequentFoods(15);
  $("#frequentList").innerHTML = freq.length
    ? freq.map(f => resRow(f, S.counts[foodKey(f)] ? `${S.counts[foodKey(f)]}×` : "")).join("")
    : `<div class="hint">Foods you log will show up here for one-tap re-adding.</div>`;

  $("#customList").innerHTML = S.custom.length
    ? S.custom.map(f => `<div class="prow">
         ${resRow(f, syncEnabled() ? "shared" : "yours")}
         <button class="del" data-delfood="${esc(f.id)}" aria-label="Delete ${esc(f.name)}">✕</button>
       </div>`).join("")
    : `<div class="hint">No foods of your own yet.<br>Create one for anything you eat often that has no barcode.${syncEnabled() ? "<br>Foods you create here are shared with everyone on your server." : ""}</div>`;

  $$("[data-delfood]").forEach(b => b.onclick = e => {
    e.stopPropagation();
    const id = b.dataset.delfood;
    const f = S.custom.find(x => x.id === id);
    if (!f) return;
    const shared = syncEnabled();
    if (!confirm(`Delete "${f.name}"?${shared ? "\n\nIt's a shared food, so it goes for everyone on your server." : ""}\n\nDiary entries already logged are not affected.`)) return;
    S.custom = S.custom.filter(x => x.id !== id);
    S.deletedFoods[id] = Date.now();   // tombstone, so another device can't resurrect it
    delete S.foodStamps[id];
    save();
    renderFoods();
    toast("Deleted");
  });
}

function resRow(f, tag) {
  const sub = [f.brand, f.cat].filter(Boolean).join(" · ");
  return `<button class="res" data-food='${esc(JSON.stringify(f))}'>
      <div class="txt">
        <div class="nm">${esc(f.name)}</div>
        <div class="sub">${esc(sub || " ")}</div>
      </div>
      ${tag ? `<span class="tagpill">${esc(tag)}</span>` : ""}
      <span class="kc">${r0(f.per100.k)}/100g</span>
    </button>`;
}

/* ---------------- Trends ---------------- */
function renderTrends() {
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDays(ymd(new Date()), -i));
  const vals = days.map(d => dayTotals(d).k);
  const max = Math.max(S.goal * 1.15, ...vals, 1);

  $("#chart14").innerHTML = days.map((d, i) => {
    const v = vals[i];
    const cls = v > S.goal ? "over" : (v > 0 ? "full" : "");
    const lbl = new Date(...d.split("-").map((x, j) => j === 1 ? +x - 1 : +x)).toLocaleDateString("en-GB", { weekday: "narrow" });
    return `<div class="bar" title="${d}: ${r0(v)} kcal">
        <i class="${cls}" style="height:${clamp(v / max * 100, 0, 100)}%"></i><b>${lbl}</b></div>`;
  }).join("");

  const logged = vals.filter(v => v > 0);
  const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
  const under = logged.filter(v => v <= S.goal).length;
  $("#statGrid").innerHTML = `
    <div class="stat"><b>${r0(avg)}</b><small>avg kcal on days logged</small></div>
    <div class="stat"><b>${logged.length}/14</b><small>days logged</small></div>
    <div class="stat"><b>${under}</b><small>days at or under goal</small></div>
    <div class="stat"><b>${r0(avg - S.goal)}</b><small>avg vs goal</small></div>`;

  const wKeys = Object.keys(S.weights).sort().slice(-14);
  if (wKeys.length) {
    const wv = wKeys.map(k => S.weights[k]);
    const lo = Math.min(...wv) - 0.5, hi = Math.max(...wv) + 0.5;
    $("#chartW").innerHTML = wKeys.map((k, i) =>
      `<div class="bar" title="${k}: ${wv[i]} kg">
        <i class="full" style="height:${clamp((wv[i] - lo) / (hi - lo || 1) * 92 + 8, 8, 100)}%"></i>
        <b>${r1(wv[i])}</b></div>`).join("");
  } else {
    $("#chartW").innerHTML = `<div class="hint" style="margin:auto">No weight logged yet.</div>`;
  }
  $("#weightInput").value = S.weights[ymd(new Date())] ?? "";
}

/* ---------------- Settings ---------------- */
/* The sync card's Supabase half: sign in, or once you are, who you are and
   the device key the iOS Shortcut needs. */
function supabaseSyncCard() {
  if (!sbSignedIn()) {
    return `
      <p>Sign in as ${esc(profileLabel())}. Each person signs in as themselves — diaries are separate, the food library is shared.</p>
      <label class="fld"><span>Email</span>
        <input type="email" id="sbEmail" autocomplete="username" spellcheck="false" inputmode="email" placeholder="you@example.com"></label>
      <label class="fld"><span>Password</span>
        <input type="password" id="sbPass" autocomplete="current-password"></label>
      <div class="btnrow">
        <button class="primary" id="sbSignInBtn">Sign in</button>
      </div>
      <p>Accounts are created in the Supabase dashboard, not here — see the setup guide. Sign-ups should stay switched off so the project stays yours.</p>`;
  }
  return `
    <p>Signed in as <b>${esc(sbEmail())}</b> for the ${esc(profileLabel())} profile.</p>
    <div class="btnrow">
      <button class="ghost" id="syncNowBtn">Sync now</button>
      <button class="ghost" id="sbSignOutBtn">Sign out</button>
    </div>
    <h4>Active energy from your watch</h4>
    <p>A device key lets an iOS Shortcut post your Apple Health active energy without holding a password. It's shown once and stored only as a hash, so if you lose it you issue another.</p>
    <div class="btnrow"><button class="ghost" id="sbKeyBtn">Issue a device key</button></div>
    <p id="sbKeyOut"></p>`;
}

function renderSettings() {
  const m = S.macroPct;
  $("#settingsBody").innerHTML = `
    <div class="card">
      <h3>Daily goal</h3>
      <label class="fld"><span>Calories per day</span>
        <input type="number" inputmode="numeric" id="setGoal" value="${S.goal}"></label>
      <div class="row3">
        <label class="fld"><span>Protein %</span><input type="number" inputmode="numeric" id="setP" value="${m.p}"></label>
        <label class="fld"><span>Carbs %</span><input type="number" inputmode="numeric" id="setC" value="${m.c}"></label>
        <label class="fld"><span>Fat %</span><input type="number" inputmode="numeric" id="setF" value="${m.f}"></label>
      </div>
      <p id="pctNote"></p>
      <div class="btnrow"><button class="primary" id="saveGoal">Save goal</button></div>
    </div>

    <div class="card">
      <h3>Work out a goal</h3>
      <p>Mifflin–St Jeor estimate of what you burn, then an adjustment. A starting point, not a prescription.</p>
      <div class="row2">
        <label class="fld"><span>Sex</span><select id="cSex"><option value="m">Male</option><option value="f">Female</option></select></label>
        <label class="fld"><span>Age</span><input type="number" inputmode="numeric" id="cAge" placeholder="40"></label>
      </div>
      <div class="row2">
        <label class="fld"><span>Height (cm)</span><input type="number" inputmode="numeric" id="cHt" placeholder="178"></label>
        <label class="fld"><span>Weight (kg)</span><input type="number" inputmode="decimal" id="cWt" placeholder="80"></label>
      </div>
      <label class="fld"><span>Activity</span>
        <select id="cAct">
          <option value="1.2">Sedentary — desk job, little exercise</option>
          <option value="1.375" selected>Lightly active — 1–3 sessions a week</option>
          <option value="1.55">Moderately active — 3–5 a week</option>
          <option value="1.725">Very active — 6–7 a week</option>
        </select></label>
      <label class="fld"><span>Aim</span>
        <select id="cAim">
          <option value="0">Maintain weight</option>
          <option value="-275">Lose slowly (~0.25 kg a week)</option>
          <option value="-550" selected>Lose steadily (~0.5 kg a week)</option>
          <option value="275">Gain slowly (~0.25 kg a week)</option>
        </select></label>
      <div class="btnrow"><button class="ghost" id="calcGoal">Calculate</button></div>
      <p id="calcOut"></p>
    </div>

    <div class="card">
      <h3>Food search</h3>
      <p>Neither of these is needed. Typed search already covers ~2,900 UK foods from McCance &amp; Widdowson, offline, and barcodes come from Open Food Facts. These only add <em>more</em> results.</p>
      <label class="fld"><span>Your search server (offproxy)</span>
        <input type="text" id="setServer" value="${esc(S.serverUrl)}" placeholder="https://tally.yourdomain.com" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <p>Set this and typed search comes from Open Food Facts itself, via your own server — better UK coverage than USDA, and barcode lookups route through it too. Leave it empty to use USDA instead.</p>
      <label class="fld"><span>USDA API key ${serverBase() ? "(unused while a server is set)" : "(optional extra)"}</span>
        <input type="text" id="setUsda" value="${esc(S.usdaKey)}" placeholder="${USDA_DEMO}" autocomplete="off" spellcheck="false"></label>
      <p>Adds American generic foods on top of the UK data. Free key, about a minute: <a href="https://fdc.nal.usda.gov/api-key-signup.html" target="_blank" rel="noopener">fdc.nal.usda.gov</a>.</p>
      <p><b>You probably don't need this.</b> The UK data covers typed search on its own, and USDA's endpoint is intermittently unreliable. Clearing this box makes typed search entirely offline.</p>
      <div class="btnrow">
        <button class="primary" id="saveUsda">Save</button>
        <button class="ghost" id="testUsda">Test connection</button>
      </div>
      <p id="usdaTestOut"></p>
    </div>

    <div class="card">
      <h3>Who uses this device</h3>
      <p>Each person gets their own diary here. ${backend() === "supabase"
        ? "Who they're signed in as is what tells Supabase whose diary it is, and row-level security means one account genuinely cannot read the other's."
        : "Their sync token is what tells the server whose diary it is, so one person's token can never fetch the other's."} Custom foods are shared across the household on purpose.</p>
      <div class="list">
        ${P.list.map(p => `
          <div class="prow${p.id === P.active ? " is-active" : ""}">
            <div class="txt">
              <div class="nm">${esc(p.label)}${p.id === P.active ? ` <span class="tagpill">active</span>` : ""}</div>
              <div class="sub">${p.token ? "sync token set" : "no token — this device only"}</div>
            </div>
            ${p.id === P.active ? "" : `<button class="ghost small" data-switchto="${esc(p.id)}">Use</button>`}
            <button class="ghost small" data-editprofile="${esc(p.id)}">Edit</button>
          </div>`).join("")}
      </div>
      <div class="btnrow"><button class="ghost" id="addProfile">+ Add a person</button></div>
    </div>

    <div class="card">
      <h3>Sync</h3>
      <p>${esc(syncSummary())}</p>
      ${backend() === "supabase" ? supabaseSyncCard() : `
      <label class="fld"><span>Sync token for ${esc(profileLabel())}</span>
        <input type="password" id="setToken" value="${esc(activeProfile().token || "")}" placeholder="paste the token from OFFPROXY_ACCOUNTS" autocomplete="off" spellcheck="false"></label>
      <p>Generate one on the server with <code>offproxy -gen-token</code>, add it to <code>OFFPROXY_ACCOUNTS</code>, and paste the same value here. Without a token this profile stays on this device.</p>
      <div class="btnrow">
        <button class="primary" id="saveToken">Save token</button>
        <button class="ghost" id="syncNowBtn">Sync now</button>
      </div>`}
    </div>

    <div class="card">
      <h3>Supabase</h3>
      <p>The other way to sync, with nothing of your own left running. Supabase's free tier covers a household comfortably — see <code>supabase/README.md</code> for the ten-minute setup.</p>
      <label class="fld"><span>Project URL</span>
        <input type="text" id="setSbUrl" value="${esc(S.sbUrl)}" placeholder="https://abcdefgh.supabase.co" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <label class="fld"><span>Anon key</span>
        <input type="text" id="setSbKey" value="${esc(S.sbKey)}" placeholder="eyJhbGciOi..." autocomplete="off" spellcheck="false"></label>
      <p>Both are on the project's API settings page. The anon key is meant to be public — it's row-level security, not this key, that keeps your diary private.</p>
      <div class="btnrow">
        <button class="primary" id="saveSb">Save</button>
        ${sbConfigured() ? `<button class="ghost" id="clearSb">Stop using Supabase</button>` : ""}
      </div>
      <p id="sbOut"></p>
    </div>

    <div class="card">
      <h3>Your data</h3>
      <p>Everything is stored only in this browser${syncEnabled() ? " and on your own server" : ""}. Clearing site data or switching device loses the local copy — export now and then.</p>
      <div class="btnrow">
        <button class="ghost" id="exportBtn">Export JSON</button>
        <button class="ghost" id="importBtn">Import JSON</button>
      </div>
      <div class="btnrow"><button class="ghost danger wide" id="wipeBtn">Erase everything</button></div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>

    <div class="card">
      <h3>About</h3>
      <p>Tally v${VERSION} — offline-capable, no account, no analytics.<br>
      Product data from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a> (ODbL).
      UK reference foods from <a href="https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid" target="_blank" rel="noopener">McCance &amp; Widdowson's Composition of Foods Integrated Dataset</a> (CoFID 2021), plus ${BUILTIN.length} curated items with portion sizes.</p>
      <p>Contains public sector information licensed under the
      <a href="http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener">Open Government Licence v3.0</a>.</p>
      <p>Reference values are for generic foods. For anything packaged, scanning the barcode is more accurate.</p>
    </div>`;

  const pctNote = () => {
    const tot = (+$("#setP").value || 0) + (+$("#setC").value || 0) + (+$("#setF").value || 0);
    $("#pctNote").textContent = tot === 100 ? "" : `Macro split adds up to ${tot}% — it should be 100%.`;
  };
  ["setP", "setC", "setF"].forEach(id => $("#" + id).addEventListener("input", pctNote));
  pctNote();

  $("#saveGoal").onclick = () => {
    const g = clamp(+$("#setGoal").value || 2000, 500, 8000);
    S.goal = g;
    S.macroPct = { p: +$("#setP").value || 25, c: +$("#setC").value || 45, f: +$("#setF").value || 30 };
    S.settingsStamp = Date.now();
    save(); toast("Goal saved"); renderSettings();
  };

  $("#calcGoal").onclick = () => {
    const age = +$("#cAge").value, ht = +$("#cHt").value, wt = +$("#cWt").value;
    if (!age || !ht || !wt) { $("#calcOut").textContent = "Fill in age, height and weight first."; return; }
    const s = $("#cSex").value === "m" ? 5 : -161;
    const bmr = 10 * wt + 6.25 * ht - 5 * age + s;
    const tdee = bmr * (+$("#cAct").value);
    const target = Math.round((tdee + (+$("#cAim").value)) / 10) * 10;
    $("#setGoal").value = target;
    let msg = `Maintenance is around ${r0(tdee)} kcal. Suggested goal: ${target} kcal. Press “Save goal” to use it.`;
    if (target < 1500) msg += " That's a low target — worth sanity-checking with a GP or dietitian before committing to it.";
    $("#calcOut").textContent = msg;
  };

  const readSearchSettings = () => {
    S.serverUrl = $("#setServer").value.trim();
    S.usdaKey = $("#setUsda").value.trim();
    save();
  };

  $("#saveUsda").onclick = () => { readSearchSettings(); toast("Saved"); renderSettings(); };

  $("#testUsda").onclick = async () => {
    const out = $("#usdaTestOut");
    out.textContent = "Testing…";
    readSearchSettings();
    try {
      const list = await searchRemote("apple");
      if (!list.length) { out.textContent = "Connected, but that search returned nothing. Odd, but not a connection problem."; return; }
      out.innerHTML = backend() === "supabase"
        ? `Working — ${list.length} results from Open Food Facts via Supabase.`
        : serverBase()
          ? `Working — ${list.length} results from Open Food Facts via your server.`
          : `Working — ${list.length} results from USDA, using ${S.usdaKey ? "your key" : "the shared demo key"}.`;
    } catch (e) {
      out.innerHTML = searchErrorText(e);
    }
  };

  /* --- profiles --- */
  $$("[data-switchto]").forEach(b => b.onclick = () => switchProfile(b.dataset.switchto));

  $$("[data-editprofile]").forEach(b => b.onclick = () => {
    const p = P.list.find(x => x.id === b.dataset.editprofile);
    if (!p) return;
    const name = prompt(`Name for this person (blank to remove them from this device)`, p.label);
    if (name === null) return;
    if (name.trim() === "") {
      if (P.list.length === 1) { toast("You need at least one person"); return; }
      if (!confirm(`Remove ${p.label} from this device?\n\nTheir diary here is deleted. Anything already synced stays on the server.`)) return;
      try { localStorage.removeItem(dataKeyFor(p.id)); } catch (e) { /* nothing to do */ }
      P.list = P.list.filter(x => x.id !== p.id);
      if (P.active === p.id) { P.active = P.list[0].id; S = load(); }
      saveProfiles(); renderWhoBar(); renderSettings();
      toast("Removed");
      return;
    }
    p.label = name.trim();
    saveProfiles(); renderWhoBar(); renderSettings();
  });

  $("#addProfile").onclick = () => {
    const name = prompt("Name for the new person");
    if (!name || !name.trim()) return;
    const id = "p_" + uid();
    P.list.push({ id, label: name.trim(), token: "" });
    saveProfiles();
    renderWhoBar(); renderSettings();
    toast(`Added ${name.trim()} — switch to them to set their sync token`);
  };

  /* --- sync --- */
  if ($("#saveToken")) $("#saveToken").onclick = () => {
    activeProfile().token = $("#setToken").value.trim();
    saveProfiles();
    renderSettings();
    if (syncEnabled()) syncNow(true); else toast("Token cleared");
  };
  if ($("#syncNowBtn")) $("#syncNowBtn").onclick = () => syncNow(true);

  /* --- supabase --- */
  $("#saveSb").onclick = () => {
    const url = $("#setSbUrl").value.trim().replace(/\/+$/, "");
    const key = $("#setSbKey").value.trim();
    if (url && !/^https:\/\/[^\s/]+/.test(url)) {
      $("#sbOut").textContent = "That should be the https:// project URL from your API settings.";
      return;
    }
    S.sbUrl = url; S.sbKey = key;
    save(false);
    renderSettings();
    toast(url && key ? "Supabase set — sign in below" : "Saved");
  };

  if ($("#clearSb")) $("#clearSb").onclick = () => {
    if (!confirm("Stop using Supabase on this device?\n\nYour diary stays here. Anything already synced stays in the project.")) return;
    sbSignOut();
    S.sbUrl = ""; S.sbKey = "";
    save(false);
    renderSettings();
    toast("Supabase disconnected");
  };

  if ($("#sbSignInBtn")) $("#sbSignInBtn").onclick = async () => {
    const out = $("#sbOut");
    const email = $("#sbEmail").value.trim(), pass = $("#sbPass").value;
    if (!email || !pass) { out.textContent = "Email and password, please."; return; }
    out.textContent = "Signing in…";
    try {
      await sbSignIn(email, pass);
      out.textContent = "";
      renderSettings();
      syncNow(true);
    } catch (e) {
      /* The most common cause by far is an account that was never created,
         since sign-ups are meant to be off. Say so rather than "invalid". */
      out.innerHTML = e.auth
        ? `That email and password weren't accepted. If the account hasn't been created yet, add it under <b>Authentication → Users</b> in the Supabase dashboard.`
        : `Couldn't reach Supabase${e.detail ? " — " + esc(e.detail) : ""}.`;
    }
  };

  if ($("#sbSignOutBtn")) $("#sbSignOutBtn").onclick = () => {
    sbSignOut(); renderSettings(); toast("Signed out");
  };

  if ($("#sbKeyBtn")) $("#sbKeyBtn").onclick = async () => {
    const out = $("#sbKeyOut");
    out.textContent = "Issuing…";
    try {
      const key = await sbIssueDeviceKey("iPhone");
      /* Shown once, deliberately: only the hash is stored, so there is no
         "show it again" to offer later. */
      out.innerHTML = `<b>Copy this now — it won't be shown again:</b>
        <code class="keyout">${esc(key)}</code>
        Use it in the Shortcut as the <code>Authorization</code> header, as
        <code>Bearer ${esc(key.slice(0, 6))}…</code>, posting to
        <code>${esc(sbBase())}/functions/v1/activity</code>.`;
    } catch (e) {
      out.innerHTML = e.noSchema
        ? "That project doesn't have Tally's tables yet — run <code>supabase/schema.sql</code> first."
        : `Couldn't issue a key${e.detail ? " — " + esc(e.detail) : ""}.`;
    }
  };

  $("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const a = el("a"); a.href = URL.createObjectURL(blob);
    a.download = `tally-backup-${ymd(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data !== "object" || !("diary" in data)) throw new Error("Not a Tally backup");
      S = Object.assign(structuredClone(DEFAULTS), data);
      const now = Date.now();
      Object.keys(S.diary || {}).forEach(d => { S.dayStamps[d] = now; });
      Object.keys(S.weights || {}).forEach(d => { S.weightStamps[d] = now; });
      (S.custom || []).forEach(f => { S.foodStamps[f.id] = now; });
      S.settingsStamp = now;
      save(); toast("Backup restored"); show("today");
    } catch (err) { toast("Couldn't read that file"); console.error(err); }
    e.target.value = "";
  };
  $("#wipeBtn").onclick = () => {
    const who = P.list.length > 1 ? `${profileLabel()}'s ` : "";
    if (!confirm(`Erase ${who}diary entries, foods and settings on this device?` +
      (syncEnabled() ? "\n\nAnything already synced stays on the server and will come back on the next sync." : ""))) return;
    try { localStorage.removeItem(dataKey()); } catch (e) { /* nothing to do */ }
    S = structuredClone(DEFAULTS);
    save(false);
    show("today");
    toast("Erased on this device");
  };
}

/* ============================================================
   ADD SHEET
   ============================================================ */
let addMeal = "Breakfast";
let srcFilter = "all";
let searchAbort = null;

function openAdd(meal) {
  hideToast();
  /* the profile picker borrows this sheet — put it back how it was */
  $(".searchrow").hidden = false;
  $("#srcChips").hidden = false;
  $("#results").onclick = null;
  addMeal = meal || guessMeal();
  srcFilter = "all";
  $$("#srcChips .chip").forEach(c => c.classList.toggle("is-on", c.dataset.src === "all"));
  $("#addTitle").textContent = `Add to ${addMeal.toLowerCase()}`;
  $("#searchInput").value = "";
  $("#addSheet").hidden = false;
  renderResults("");
  setTimeout(() => { if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) $("#searchInput").focus(); }, 260);
}
function guessMeal() {
  const h = new Date().getHours();
  if (h < 11) return "Breakfast";
  if (h < 15) return "Lunch";
  if (h < 21) return "Dinner";
  return "Snacks";
}
function closeSheets() {
  $("#addSheet").hidden = true;
  $("#portionSheet").hidden = true;
  if (searchAbort) { searchAbort.abort(); searchAbort = null; }
}

let searchTimer;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $("#searchInput").value.trim();
  searchTimer = setTimeout(() => renderResults(q), 280);
}

function renderResults(q) {
  const box = $("#results");

  if (srcFilter === "quick") { box.innerHTML = quickAddForm(); wireQuickAdd(); return; }

  if (!q) {
    if (srcFilter === "mine") {
      box.innerHTML = S.custom.length ? S.custom.map(f => resRow(f, "yours")).join("")
        : `<div class="hint">You haven't created any foods yet.<br>Go to Foods → Create a food.</div>`;
      return;
    }
    const rec = S.recent.slice(0, 20);
    box.innerHTML = rec.length
      ? `<div class="hint" style="padding:10px 4px 4px;text-align:left">Recent</div>` + rec.map(f => resRow(f, "")).join("")
      : `<div class="hint">Scan a barcode, or start typing to search.<br><br>${BUILTIN.length + (typeof UK_FOODS === "undefined" ? 0 : UK_FOODS.length)} UK foods are built in and work offline.</div>`;
    return;
  }

  /* a bare number is almost certainly a barcode */
  if (/^\d{8,14}$/.test(q)) {
    box.innerHTML = `<button class="res" data-barcode="${q}">
        <div class="txt"><div class="nm">Look up barcode ${q}</div>
        <div class="sub">Search Open Food Facts</div></div><span class="kc">→</span></button>`;
    return;
  }

  const pools = { recent: S.recent, mine: S.custom };
  let local;
  if (srcFilter === "recent" || srcFilter === "mine") {
    local = (pools[srcFilter] || []).filter(f => scoreMatch(f.name, f.brand, q) > 0);
  } else {
    local = localSearch(q);
  }

  box.innerHTML = local.length
    ? local.map(f => resRow(f, f.source === "custom" ? "yours" : (f.source === "cofid" ? "UK" : ""))).join("")
    : "";

  if (srcFilter !== "all") {
    if (!local.length) box.innerHTML = `<div class="hint">Nothing matching “${esc(q)}” here.</div>`;
    return;
  }

  /* Nothing to add from the network, so don't spin a spinner for nothing. */
  if (!remoteSearchAvailable()) {
    if (!local.length) {
      box.innerHTML = `<div class="hint">No UK reference food matching “${esc(q)}”.<br>
        If it's a packaged product, scanning the barcode will find it.</div>`;
    }
    return;
  }

  const more = el("div");
  more.innerHTML = `<div class="spin"></div>`;
  box.appendChild(more);

  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();

  searchRemote(q, searchAbort.signal).then(list => {
    if (!list.length) { more.innerHTML = local.length ? "" : `<div class="hint">No matches for “${esc(q)}”.<br>If it's a packaged product, scanning the barcode will find it.</div>`; return; }
    more.innerHTML = `<div class="hint" style="padding:14px 4px 4px;text-align:left">${searchSourceLabel()}</div>`
      + list.map(f => resRow(f, "")).join("");
  }).catch(err => {
    if (err.name === "AbortError") return;

    /* The UK reference foods are the main event; USDA and your own server are
       extras. If the local search already answered, an extra falling over is
       not the user's problem — don't make a working app look broken. Only
       things they can act on (a bad key, a rate limit, a server they
       configured) get a quiet line. */
    if (local.length) {
      const actionable = err.kind === "key" || err.kind === "rate" || err.server;
      more.innerHTML = actionable ? `<div class="hint quiet">${searchErrorText(err)}</div>` : "";
      if (!actionable) console.warn("Optional food search unavailable:", err.message, err.status || "");
      return;
    }
    more.innerHTML = `<div class="hint">${searchErrorText(err)}</div>`;
  });
}

/* Say which failure actually happened, rather than one catch-all shrug. */
function searchErrorText(err) {
  if (err && err.server) return serverErrorText(err);
  return usdaErrorText(err);
}

function serverErrorText(err) {
  if (backend() === "supabase") return supabaseErrorText(err);
  const base = esc(serverBase());
  switch (err.kind) {
    case "file":
      return "The app is running from a file on disk, so it can't call your search server. It needs to be served over https.";
    case "rate":
      return "Your server is pacing itself to stay inside Open Food Facts' published limits (10 searches a minute). Try again in a few seconds.";
    case "upstream":
      return `Your server is up but couldn't get an answer from Open Food Facts${err.detail ? " — " + esc(err.detail) : ""}. Probably temporary.`;
    case "http":
      return `Your search server returned HTTP ${err.status}${err.detail ? " — " + esc(err.detail) : ""}.`;
    default:
      return `Couldn't reach your search server at <b>${base}</b>.<br>Check <code>offproxy</code> is running, that the URL is right, and that this page's origin is in its <code>OFFPROXY_ORIGINS</code> list.<br>Built-in foods still work.`;
  }
}

function supabaseErrorText(err) {
  switch (err.kind) {
    case "file":
      return "The app is running from a file on disk, so it can't call Supabase. It needs to be served over https.";
    case "rate":
      return "Pacing itself to stay inside Open Food Facts' published limits (10 searches a minute). Try again in a few seconds.";
    case "upstream":
      return `Supabase is up but couldn't get an answer from Open Food Facts${err.detail ? " — " + esc(err.detail) : ""}. Probably temporary.`;
    case "nofunc":
      return "The <code>off</code> function isn't deployed to this project yet — <code>supabase functions deploy off</code>.";
    case "noua":
      return "The <code>off</code> function has no contact address set. Add <code>OFF_USER_AGENT</code> to its secrets — Open Food Facts requires one.";
    case "http":
      return `Supabase returned HTTP ${err.status}${err.detail ? " — " + esc(err.detail) : ""}.`;
    default:
      return "Couldn't reach Supabase. If the project has been idle a week the free tier pauses it — open the dashboard and press Resume. Built-in foods still work.";
  }
}

/* Say which of the four very different failures actually happened. */
function usdaErrorText(err) {
  const own = !!(S.usdaKey || "").trim();
  switch (err && err.kind) {
    case "file":
      return "Food search can't run from a file on disk — the page has to be served over https. Barcode scanning needs that too.";
    case "rate":
      return own
        ? "Your USDA key has hit its hourly limit. It resets within the hour."
        : "The shared demo key has hit its hourly limit — it's about 30 searches an hour across everyone using it.<br>A personal key is free: <b>More → Food search key</b>.";
    case "key":
      return own
        ? `USDA rejected that API key${err.detail ? " — " + esc(err.detail) : ""}.<br>Check it in <b>More → Food search key</b>, or empty the box to fall back to the shared demo key.`
        : "USDA rejected the shared demo key. Add your own free key in <b>More → Food search key</b>.";
    case "http":
      return `Food search returned an error (HTTP ${err.status}${err.detail ? " — " + esc(err.detail) : ""}). Probably temporary.`;
    default:
      return "Couldn't reach the food search service. You're either offline, or something is blocking <b>api.nal.usda.gov</b> — an ad-blocker, a privacy extension, or Brave's Shields.<br>Built-in foods and barcode scanning are unaffected.";
  }
}

function quickAddForm() {
  return `<div style="padding:8px 2px">
    <p class="hint" style="padding:0 0 12px;text-align:left">For when you know the calories but not the detail — a restaurant meal, someone else's cooking.</p>
    <label class="fld"><span>Description (optional)</span><input type="text" id="qaName" placeholder="Dinner at the pub"></label>
    <div class="row2">
      <label class="fld"><span>Calories</span><input type="number" inputmode="numeric" id="qaK" placeholder="650"></label>
      <label class="fld"><span>Protein g</span><input type="number" inputmode="decimal" id="qaP" placeholder="0"></label>
    </div>
    <div class="row2">
      <label class="fld"><span>Carbs g</span><input type="number" inputmode="decimal" id="qaC" placeholder="0"></label>
      <label class="fld"><span>Fat g</span><input type="number" inputmode="decimal" id="qaF" placeholder="0"></label>
    </div>
    <div class="mealpick" id="qaMeals">${MEALS.map(m =>
      `<button class="chip ${m === addMeal ? "is-on" : ""}" data-qameal="${m}">${m}</button>`).join("")}</div>
    <div class="btnrow"><button class="primary wide" id="qaAdd">Add</button></div>
  </div>`;
}
function wireQuickAdd() {
  $("#qaMeals").onclick = e => {
    const b = e.target.closest("[data-qameal]"); if (!b) return;
    addMeal = b.dataset.qameal;
    $$("#qaMeals .chip").forEach(c => c.classList.toggle("is-on", c === b));
  };
  $("#qaAdd").onclick = () => {
    const k = +$("#qaK").value;
    if (!k) { toast("Enter a calorie figure"); return; }
    logEntry({
      id: uid(), name: $("#qaName").value.trim() || "Quick add", source: "quick",
      grams: 100, portionLabel: "quick add",
      per100: { k, p: +$("#qaP").value || 0, c: +$("#qaC").value || 0, f: +$("#qaF").value || 0 }
    }, addMeal, false);
    closeSheets();
  };
}

/* ============================================================
   PORTION SHEET
   ============================================================ */
let pFood = null, pIdx = 0, pCount = 1, pEditing = null;

function openPortion(food, editing) {
  hideToast();
  pFood = food;
  pEditing = editing || null;
  const ports = food.portions && food.portions.length ? food.portions : [{ label: "100 g", g: 100 }, GRAM_PORTION];
  pFood.portions = ports;

  if (editing) {
    const i = ports.findIndex(p => !p.gram && Math.abs(p.g * Math.round(editing.grams / p.g) - editing.grams) < 0.01 && p.label === editing.portionLabel);
    pIdx = i >= 0 ? i : ports.length - 1;
    pCount = ports[pIdx].gram ? editing.grams : editing.grams / ports[pIdx].g;
  } else {
    pIdx = 0; pCount = ports[0].gram ? 100 : 1;
  }
  $("#portionName").textContent = food.name;
  $("#portionSheet").hidden = false;
  drawPortion();
}

function curGrams() {
  const p = pFood.portions[pIdx];
  return p.gram ? pCount : pCount * p.g;
}

function drawPortion() {
  const g = curGrams(), v = macrosFor(pFood, g), p = pFood.portions[pIdx];
  const n = pFood.per100;
  const extras = [];
  if (n.fib != null) extras.push(`Fibre <i>${r1(n.fib * g / 100)}g</i>`);
  if (n.sug != null) extras.push(`Sugars <i>${r1(n.sug * g / 100)}g</i>`);
  if (n.sal != null) extras.push(`Salt <i>${r1(n.sal * g / 100)}g</i>`);

  $("#portionBody").innerHTML = `
    ${pFood.brand ? `<div class="pbrand">${esc(pFood.brand)}${pFood.code ? " · " + esc(pFood.code) : ""}</div>` : ""}
    <div class="pkcal">
      <b>${r0(v.k)}</b><small>kcal · ${r0(g)} g</small>
      <div class="pmac">
        <span>Protein <i>${r1(v.p)}g</i></span>
        <span>Carbs <i>${r1(v.c)}g</i></span>
        <span>Fat <i>${r1(v.f)}g</i></span>
      </div>
      ${extras.length ? `<div class="pmac">${extras.map(x => `<span>${x}</span>`).join("")}</div>` : ""}
    </div>

    <div class="amount">
      <button id="pMinus" aria-label="Less">−</button>
      <input type="number" inputmode="decimal" id="pAmt" value="${p.gram ? r0(pCount) : r1(pCount)}" step="${p.gram ? 10 : 0.5}" min="0">
      <button id="pPlus" aria-label="More">+</button>
    </div>

    <div class="units">
      ${pFood.portions.map((x, i) =>
        `<button class="chip ${i === pIdx ? "is-on" : ""}" data-port="${i}">${esc(x.gram ? "grams" : x.label)}</button>`).join("")}
    </div>

    ${p.gram ? "" : `<div class="presets">
      ${[0.5, 1, 1.5, 2, 3].map(m => `<button class="chip" data-mult="${m}">${m}×</button>`).join("")}
    </div>`}

    <div class="mealpick">
      ${MEALS.map(m => `<button class="chip ${m === addMeal ? "is-on" : ""}" data-pmeal="${m}">${m}</button>`).join("")}
    </div>

    <div class="btnrow"><button class="primary wide" id="pAdd">${pEditing ? "Save changes" : "Add to " + addMeal.toLowerCase()}</button></div>
    <div class="per100">Per 100 g: ${r0(n.k)} kcal · P ${r1(n.p)} · C ${r1(n.c)} · F ${r1(n.f)}${pFood.source === "off" ? " · Open Food Facts" : pFood.source === "cofid" ? " · McCance &amp; Widdowson (CoFID)" : pFood.source === "usda" ? " · USDA" : pFood.source === "builtin" ? " · built-in reference" : ""}</div>`;

  const body = $("#portionBody");
  const step = p.gram ? 10 : 0.5;

  /* Never re-render the sheet while the user is interacting with the amount:
     rebuilding the DOM under a finger loses the tap that follows. */
  $("#pMinus").onclick = () => { pCount = Math.max(p.gram ? 1 : 0.25, +(pCount - step).toFixed(2)); refreshAmount(); };
  $("#pPlus").onclick = () => { pCount = +(pCount + step).toFixed(2); refreshAmount(); };
  $("#pAmt").oninput = e => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val) && val >= 0) { pCount = val; softUpdate(); }
  };
  $("#pAmt").onblur = e => {
    const val = parseFloat(e.target.value);
    if (!Number.isFinite(val) || val <= 0) { pCount = p.gram ? 100 : 1; refreshAmount(); }
    else { pCount = val; refreshAmount(); }
  };

  body.querySelectorAll("[data-port]").forEach(b => b.onclick = () => {
    const ni = +b.dataset.port, np = pFood.portions[ni], og = curGrams();
    pIdx = ni;
    /* Picking "whole pack" means one whole pack, not the weight you already had.
       Switching to grams is the exception: you go there to fine-tune what's set. */
    pCount = np.gram ? Math.max(1, Math.round(og)) : 1;
    drawPortion();   /* unit change alters the step size and presets, so full redraw */
  });
  body.querySelectorAll("[data-mult]").forEach(b => b.onclick = () => { pCount = +b.dataset.mult; refreshAmount(); });
  body.querySelectorAll("[data-pmeal]").forEach(b => b.onclick = () => {
    addMeal = b.dataset.pmeal;
    body.querySelectorAll("[data-pmeal]").forEach(c => c.classList.toggle("is-on", c === b));
    $("#pAdd").textContent = pEditing ? "Save changes" : "Add to " + addMeal.toLowerCase();
  });
  $("#pAdd").onclick = commitPortion;
}

/* keep the amount box and the numbers in step without rebuilding the sheet */
function refreshAmount() {
  const p = pFood.portions[pIdx], inp = $("#pAmt");
  if (inp && document.activeElement !== inp) inp.value = p.gram ? String(r0(pCount)) : String(r1(pCount));
  softUpdate();
}

/* update the numbers without rebuilding (keeps the keyboard open) */
function softUpdate() {
  const g = curGrams(), v = macrosFor(pFood, g);
  const box = $("#portionBody .pkcal");
  if (!box) return;
  box.querySelector("b").textContent = r0(v.k);
  box.querySelector("small").textContent = `kcal · ${r0(g)} g`;
  const spans = box.querySelectorAll(".pmac i");
  if (spans[0]) spans[0].textContent = r1(v.p) + "g";
  if (spans[1]) spans[1].textContent = r1(v.c) + "g";
  if (spans[2]) spans[2].textContent = r1(v.f) + "g";
}

function commitPortion() {
  const g = curGrams();
  if (!g || g <= 0) { toast("Enter an amount"); return; }
  const p = pFood.portions[pIdx];
  const entry = {
    id: pEditing ? pEditing.id : uid(),
    name: pFood.name, brand: pFood.brand || "", code: pFood.code || "",
    source: pFood.source, per100: pFood.per100,
    grams: g,
    portionLabel: p.gram ? `${r0(g)} g` : (pCount === 1 ? p.label : `${r1(pCount)} × ${p.label}`)
  };

  if (pEditing) {
    const day = dayData(curDate);
    for (const m of MEALS) {
      const i = day[m].findIndex(e => e.id === pEditing.id);
      if (i >= 0) { day[m].splice(i, 1); touchDay(curDate); break; }
    }
    logEntry(entry, addMeal, true, "Updated");
  } else {
    logEntry(entry, addMeal, true);
  }
  closeSheets();
}

function logEntry(entry, meal, remember = true, verb = "Added") {
  const day = dayData(curDate);
  day[meal].push(entry);
  touchDay(curDate);

  if (remember && pFood) {
    const k = foodKey(pFood);
    S.counts[k] = (S.counts[k] || 0) + 1;
    S.recent = [pFood, ...S.recent.filter(f => foodKey(f) !== k)].slice(0, 60);
  }
  save();
  renderToday();
  show("today");
  toast(`${verb} to ${meal.toLowerCase()} · ${r0(macrosFor(entry, entry.grams).k)} kcal`, "Undo", () => {
    const d = dayData(curDate);
    const i = d[meal].findIndex(e => e.id === entry.id);
    if (i >= 0) d[meal].splice(i, 1);
    touchDay(curDate); save(); renderToday();
  });
}

/* ============================================================
   BARCODE SCANNER
   ============================================================ */
let stream = null, detector = null, rafId = null, zxReader = null, scanning = false;

async function openScanner() {
  const sc = $("#scanner");
  sc.hidden = false;
  scanning = true;
  $("#scanMsg").textContent = "Starting camera…";
  $("#torchBtn").hidden = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("#scanMsg").textContent = "This browser can't use the camera. Enter the number instead.";
    return;
  }
  if (!window.isSecureContext) {
    $("#scanMsg").textContent = "Camera needs a secure (https://) connection.";
    return;
  }

  /* Chrome / Android: the native detector is fastest and needs no download */
  let native = false;
  if ("BarcodeDetector" in window) {
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats();
      if (fmts.includes("ean_13")) {
        detector = new window.BarcodeDetector({
          formats: fmts.filter(f => ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf"].includes(f))
        });
        native = true;
      }
    } catch (e) { native = false; }
  }

  const constraints = { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

  try {
    if (native) {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      const v = $("#video");
      v.srcObject = stream;
      await v.play();
      setupTorch();
      $("#scanMsg").textContent = "Point at a barcode";
      tickNative();
    } else {
      /* Safari / iOS: fall back to ZXing */
      $("#scanMsg").textContent = "Loading scanner…";
      await loadZXing();
      $("#scanMsg").textContent = "Point at a barcode";
      zxReader = new ZXing.BrowserMultiFormatReader(null, { delayBetweenScanAttempts: 120 });
      zxReader.decodeFromConstraints(constraints, $("#video"), (result, err) => {
        if (result && scanning) {
          stream = $("#video").srcObject;
          setupTorch();
          onBarcode(result.getText());
        }
      });
      setTimeout(() => { stream = $("#video").srcObject; setupTorch(); }, 900);
    }
  } catch (e) {
    console.error(e);
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    $("#scanMsg").textContent = denied
      ? "Camera permission was refused. Allow it in your browser settings, or enter the number."
      : "Couldn't start the camera. Enter the number instead.";
  }
}

async function tickNative() {
  if (!scanning || !detector) return;
  const v = $("#video");
  try {
    if (v.readyState >= 2) {
      const codes = await detector.detect(v);
      if (codes && codes.length) { onBarcode(codes[0].rawValue); return; }
    }
  } catch (e) { /* transient decode errors are normal */ }
  rafId = requestAnimationFrame(tickNative);
}

function setupTorch() {
  try {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    if (!caps.torch) return;
    const btn = $("#torchBtn");
    btn.hidden = false;
    let on = false;
    btn.onclick = async () => {
      on = !on;
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.textContent = on ? "Torch on" : "Torch"; }
      catch (e) { btn.hidden = true; }
    };
  } catch (e) { /* torch is a bonus */ }
}

function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
    s.crossOrigin = "anonymous";
    s.onload = res;
    s.onerror = () => rej(new Error("Scanner library unavailable offline"));
    document.head.appendChild(s);
  });
}

function closeScanner() {
  scanning = false;
  if (rafId) cancelAnimationFrame(rafId), rafId = null;
  if (zxReader) { try { zxReader.reset(); } catch (e) {} zxReader = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const v = $("#video"); if (v) v.srcObject = null;
  detector = null;
  $("#scanner").hidden = true;
}

async function onBarcode(code) {
  if (!scanning) return;
  scanning = false;
  if (navigator.vibrate) navigator.vibrate(35);
  $("#scanMsg").textContent = `Looking up ${code}…`;
  closeScanner();
  await handleCode(code);
}

async function handleCode(code) {
  toast("Looking up " + code + "…");
  try {
    const food = await lookupBarcode(code);
    hideToast();
    if ($("#addSheet").hidden) addMeal = guessMeal();
    openPortion(food);
  } catch (e) {
    hideToast();
    if (e.notFound) {
      if (confirm(`Barcode ${code} isn't in Open Food Facts yet.\n\nCreate your own food for it?`)) newCustomFood(code);
    } else if (e.noNutrition) {
      if (confirm(`That product is in Open Food Facts but has no nutrition data.\n\nEnter the values yourself?`)) newCustomFood(code, e.raw && e.raw.product_name);
    } else {
      toast("Couldn't reach Open Food Facts — check your connection");
      console.error(e);
    }
  }
}

/* ============================================================
   CUSTOM FOODS
   ============================================================ */
function newCustomFood(code, prefillName) {
  const name = prompt("Food name", prefillName || "");
  if (!name) return;
  const k = parseFloat(prompt("Calories per 100 g (or per 100 ml)", ""));
  if (!Number.isFinite(k)) { toast("Need a calorie figure"); return; }
  const p = parseFloat(prompt("Protein g per 100 g", "0")) || 0;
  const c = parseFloat(prompt("Carbs g per 100 g", "0")) || 0;
  const f = parseFloat(prompt("Fat g per 100 g", "0")) || 0;
  const servTxt = prompt("Typical portion in grams (leave blank to skip)", "");
  const serv = parseFloat(servTxt);

  const portions = [];
  if (Number.isFinite(serv) && serv > 0) portions.push({ label: `portion (${r0(serv)} g)`, g: serv });
  portions.push({ label: "100 g", g: 100 }, GRAM_PORTION);

  const food = {
    id: "c_" + uid(), name: name.trim(), brand: "", code: code || "",
    source: "custom", cat: "Your food", per100: { k, p, c, f }, portions
  };
  S.custom.unshift(food);
  S.foodStamps[food.id] = Date.now();
  delete S.deletedFoods[food.id];
  save();
  toast(syncEnabled() ? "Food created — shared with the household" : "Food created");
  openPortion(food);
}

/* ============================================================
   WIRING
   ============================================================ */
function bind() {
  /* nav */
  $$(".tab").forEach(b => b.onclick = () => show(b.dataset.view));
  $("#fabScan").onclick = () => { addMeal = guessMeal(); openScanner(); };

  /* date */
  $("#dayPrev").onclick = () => { curDate = addDays(curDate, -1); renderToday(); };
  $("#dayNext").onclick = () => { curDate = addDays(curDate, 1); renderToday(); };
  $("#dayLabel").onclick = () => {
    const v = prompt("Jump to a date (YYYY-MM-DD)", curDate);
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) { curDate = v; renderToday(); }
    else if (v) toast("Use the format 2026-08-31");
  };

  /* today: add + delete + edit */
  $("#meals").addEventListener("click", e => {
    const add = e.target.closest("[data-addmeal]");
    if (add) { openAdd(add.dataset.addmeal); return; }

    const del = e.target.closest("[data-del]");
    if (del) {
      const [meal, i] = del.dataset.del.split("|");
      const day = dayData(curDate);
      const [removed] = day[meal].splice(+i, 1);
      touchDay(curDate); save(); renderToday();
      toast(`Removed ${removed.name}`, "Undo", () => {
        dayData(curDate)[meal].splice(+i, 0, removed); touchDay(curDate); save(); renderToday();
      });
      return;
    }

    const row = e.target.closest(".entry");
    if (row) {
      const meal = row.closest(".meal").querySelector("h3").textContent;
      const idx = [...row.parentElement.querySelectorAll(".entry")].indexOf(row);
      const entry = dayData(curDate)[meal][idx];
      if (!entry) return;
      addMeal = meal;
      openPortion({
        name: entry.name, brand: entry.brand, code: entry.code, source: entry.source,
        per100: entry.per100,
        portions: [{ label: entry.portionLabel.replace(/^[\d.]+ × /, ""), g: entry.grams }, { label: "100 g", g: 100 }, GRAM_PORTION]
      }, entry);
    }
  });

  /* sheets */
  $$("[data-close]").forEach(b => b.onclick = closeSheets);
  $("#searchInput").addEventListener("input", onSearchInput);
  $("#searchInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); renderResults($("#searchInput").value.trim()); } });
  $("#searchScan").onclick = () => { $("#addSheet").hidden = true; openScanner(); };

  $("#srcChips").onclick = e => {
    const c = e.target.closest(".chip"); if (!c) return;
    srcFilter = c.dataset.src;
    $$("#srcChips .chip").forEach(x => x.classList.toggle("is-on", x === c));
    renderResults($("#searchInput").value.trim());
  };

  /* result rows (add sheet + foods view) */
  document.addEventListener("click", e => {
    const bc = e.target.closest("[data-barcode]");
    if (bc) { closeSheets(); handleCode(bc.dataset.barcode); return; }
    const row = e.target.closest("[data-food]");
    if (!row) return;
    try {
      const food = JSON.parse(row.dataset.food);
      if ($("#addSheet").hidden) addMeal = guessMeal();
      openPortion(food);
    } catch (err) { console.error(err); }
  });

  /* foods view */
  $("#newCustomFood").onclick = () => newCustomFood();

  /* trends */
  $("#weightSave").onclick = () => {
    const v = parseFloat($("#weightInput").value);
    if (!Number.isFinite(v) || v <= 0) { toast("Enter a weight"); return; }
    const today = ymd(new Date());
    S.weights[today] = r1(v); S.weightStamps[today] = Date.now();
    save(); renderTrends(); toast("Weight logged");
  };

  /* scanner */
  $("#scanClose").onclick = closeScanner;
  $("#manualBtn").onclick = () => {
    closeScanner();
    const v = prompt("Barcode number");
    if (v && /^\d{6,14}$/.test(v.trim())) handleCode(v.trim());
    else if (v) toast("That doesn't look like a barcode");
  };

  /* keyboard escape, for desktop testing */
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("#scanner").hidden) closeScanner();
    else if (!$("#portionSheet").hidden || !$("#addSheet").hidden) closeSheets();
  });

  /* if the app is reopened on a new day, roll the date over */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const today = ymd(new Date());
    if (curDate !== today && curView === "today") { curDate = today; renderToday(); }
    if (syncEnabled()) scheduleSync(500);   // pick up whatever the other device did
  });
}

/* ---------------- start ---------------- */
function init() {
  bind();
  renderWhoBar();
  show("today");
  if (syncEnabled()) syncNow();

  /* home-screen shortcut: open straight into the scanner */
  if (new URLSearchParams(location.search).get("action") === "scan") {
    addMeal = guessMeal();
    setTimeout(openScanner, 250);
  } else if (!S.seenIntro) {
    S.seenIntro = true; save();
    setTimeout(() => toast("Set your calorie goal in More → Daily goal", "Open", () => show("settings")), 700);
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW registration failed", e));
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
