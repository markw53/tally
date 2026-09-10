/* ============================================================
   Tally — a food & calorie diary
   No accounts, no server, no tracking. Everything lives in this
   browser's local storage. Barcode data from Open Food Facts,
   reference foods from USDA FoodData Central.
   ============================================================ */

const VERSION = "1.1.0";
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

/* ---------------- persistent state ---------------- */
const KEY = "tally.v1";
const DEFAULTS = {
  goal: 2000,
  macroPct: { p: 25, c: 45, f: 30 },
  serverUrl: "",    // your offproxy instance; when set it replaces USDA for search
  usdaKey: "",
  diary: {},        // "YYYY-MM-DD" -> { Breakfast:[entry], ... }
  custom: [],       // user-created foods
  recent: [],       // recently logged foods (newest first)
  counts: {},       // foodKey -> times logged
  weights: {},      // "YYYY-MM-DD" -> kg
  offCache: {},     // barcode -> food
  seenIntro: false
};

let S = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? Object.assign(structuredClone(DEFAULTS), JSON.parse(raw)) : structuredClone(DEFAULTS);
  } catch (e) {
    console.warn("Could not read saved data:", e);
    return structuredClone(DEFAULTS);
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast("Couldn't save — storage may be full"); console.error(e); }
  }, 80);
}

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

  const food = serverBase() ? await proxyProduct(code) : await directProduct(code);

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

/* ---------------- text search ---------------- */

/* Your server if you have one, USDA otherwise. */
async function searchRemote(q, signal) {
  return serverBase() ? proxySearch(q, signal) : usdaSearch(q, signal);
}
function searchSourceLabel() {
  return serverBase() ? "Open Food Facts" : "Reference foods (USDA)";
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

async function usdaSearch(q, signal) {
  const key = (S.usdaKey || "").trim() || USDA_DEMO;
  const url = "https://api.nal.usda.gov/fdc/v1/foods/search?" + new URLSearchParams({
    query: q, api_key: key, pageSize: "20",
    dataType: "Foundation,SR Legacy,Survey (FNDDS)"
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
    let detail = "";
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.code)) || ""; } catch (e) { /* not JSON */ }
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
  if (hay.startsWith(terms[0])) s += 6;
  if (hay === q.toLowerCase()) s += 10;
  s -= Math.min(4, hay.length / 40);
  return s;
}

function localSearch(q) {
  const pool = [...S.custom, ...BUILTIN];
  if (!q) return [];
  return pool
    .map(f => ({ f, s: scoreMatch(f.name, f.brand, q) + (S.counts[foodKey(f)] || 0) * 0.4 }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 30)
    .map(x => x.f);
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
    ? S.custom.map(f => resRow(f, "yours")).join("")
    : `<div class="hint">No foods of your own yet.<br>Create one for anything you eat often that has no barcode.</div>`;
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
      <p>Barcode scanning needs neither of these. They only affect <em>typed</em> searches.</p>
      <label class="fld"><span>Your search server (offproxy)</span>
        <input type="text" id="setServer" value="${esc(S.serverUrl)}" placeholder="https://tally.yourdomain.com" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <p>Set this and typed search comes from Open Food Facts itself, via your own server — better UK coverage than USDA, and barcode lookups route through it too. Leave it empty to use USDA instead.</p>
      <label class="fld"><span>USDA API key ${serverBase() ? "(unused while a server is set)" : "(optional)"}</span>
        <input type="text" id="setUsda" value="${esc(S.usdaKey)}" placeholder="${USDA_DEMO}" autocomplete="off" spellcheck="false"></label>
      <p>Free key, about a minute: <a href="https://fdc.nal.usda.gov/api-key-signup.html" target="_blank" rel="noopener">fdc.nal.usda.gov</a>. Without one it falls back to a shared demo key limited to roughly 30 searches an hour.</p>
      <div class="btnrow">
        <button class="primary" id="saveUsda">Save</button>
        <button class="ghost" id="testUsda">Test connection</button>
      </div>
      <p id="usdaTestOut"></p>
    </div>

    <div class="card">
      <h3>Your data</h3>
      <p>Everything is stored only in this browser. Clearing site data or switching device loses it — export now and then.</p>
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
      Reference foods from USDA FoodData Central and a built-in table of ${BUILTIN.length} everyday items.</p>
      <p>Built-in values are typical figures for generic foods. For anything packaged, scan the barcode.</p>
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
      out.innerHTML = serverBase()
        ? `Working — ${list.length} results from Open Food Facts via your server.`
        : `Working — ${list.length} results from USDA, using ${S.usdaKey ? "your key" : "the shared demo key"}.`;
    } catch (e) {
      out.innerHTML = searchErrorText(e);
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
      save(); toast("Backup restored"); show("today");
    } catch (err) { toast("Couldn't read that file"); console.error(err); }
    e.target.value = "";
  };
  $("#wipeBtn").onclick = () => {
    if (!confirm("Erase all diary entries, foods and settings on this device?")) return;
    localStorage.removeItem(KEY); S = structuredClone(DEFAULTS); save(); show("today"); toast("Everything erased");
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
      : `<div class="hint">Scan a barcode, or start typing to search.<br><br>${BUILTIN.length} everyday foods are built in and work offline.</div>`;
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

  box.innerHTML = local.length ? local.map(f => resRow(f, f.source === "custom" ? "yours" : "")).join("") : "";

  if (srcFilter !== "all") {
    if (!local.length) box.innerHTML = `<div class="hint">Nothing matching “${esc(q)}” here.</div>`;
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
    more.innerHTML = `<div class="hint">${searchErrorText(err)}</div>`;
  });
}

/* Say which failure actually happened, rather than one catch-all shrug. */
function searchErrorText(err) {
  if (err && err.server) return serverErrorText(err);
  return usdaErrorText(err);
}

function serverErrorText(err) {
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
    <div class="per100">Per 100 g: ${r0(n.k)} kcal · P ${r1(n.p)} · C ${r1(n.c)} · F ${r1(n.f)}${pFood.source === "off" ? " · Open Food Facts" : pFood.source === "usda" ? " · USDA" : pFood.source === "builtin" ? " · built-in reference" : ""}</div>`;

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
      if (i >= 0) { day[m].splice(i, 1); break; }
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
    save(); renderToday();
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
  save();
  toast("Food created");
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
      save(); renderToday();
      toast(`Removed ${removed.name}`, "Undo", () => {
        dayData(curDate)[meal].splice(+i, 0, removed); save(); renderToday();
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
    S.weights[ymd(new Date())] = r1(v); save(); renderTrends(); toast("Weight logged");
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
  });
}

/* ---------------- start ---------------- */
function init() {
  bind();
  show("today");

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
