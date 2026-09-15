// Pure food conversion and ranking, split out from index.ts so it can be
// tested without a Deno runtime or a network. See test/food.test.mjs.
//
// Ported from server/main.go: both backends must produce the same food shape,
// so that the client doesn't have to know which one answered.

/* -------------------------------------------------------- food conversion --
   Ported from server/main.go so both backends produce the same food shape and
   the client doesn't need to care which one answered. */
export type Food = {
  id: string; name: string; brand: string; code: string; source: string;
  per100: Record<string, number | null>;
  portions: { label: string; g: number; gram?: boolean }[];
};

function num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v.trim());
    return isFinite(f) ? f : null;
  }
  return null;
}

const r1 = (f: number) => Math.round(f * 10) / 10;

function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// OFF gives brands as a comma-joined string; take the first.
function firstBrand(v: unknown): string {
  const s = firstNonEmpty(v);
  return s ? s.split(",")[0].trim() : "";
}

export function toFood(p: Record<string, any>): Food | null {
  const n = p.nutriments ?? {};
  let kcal = num(n["energy-kcal_100g"]);
  if (kcal === null) {
    const kj = num(n["energy_100g"]);            // kJ unless stated otherwise
    if (kj !== null && kj > 0) kcal = kj / 4.184;
  }
  // An entry with no calories is worse than no entry — it looks logged but
  // contributes nothing, which is how a day silently under-reports.
  if (kcal === null || kcal <= 0) return null;

  let name = firstNonEmpty(p.product_name, p.product_name_en, p.generic_name);
  if (!name) {
    if (!p.code) return null;
    name = "Barcode " + p.code;
  }

  const portions: Food["portions"] = [];
  const sq = num(p.serving_quantity);
  if (sq !== null && sq > 0 && sq < 2000) {
    const size = firstNonEmpty(p.serving_size);
    portions.push({ label: size ? `serving — ${size}` : `serving (${Math.round(sq)} g)`, g: sq });
  }
  const pq = num(p.product_quantity);
  if (pq !== null && pq > 0 && pq < 5000 && pq !== sq) {
    portions.push({ label: `whole pack (${Math.round(pq)} g)`, g: pq });
  }
  portions.push({ label: "100 g", g: 100 });
  portions.push({ label: "grams", g: 1, gram: true });

  return {
    id: "o_" + (p.code ?? ""),
    name,
    brand: firstBrand(p.brands),
    code: String(p.code ?? ""),
    source: "off",
    per100: {
      k: r1(kcal),
      p: r1(num(n["proteins_100g"]) ?? 0),
      c: r1(num(n["carbohydrates_100g"]) ?? 0),
      f: r1(num(n["fat_100g"]) ?? 0),
      fib: num(n["fiber_100g"]),
      sug: num(n["sugars_100g"]),
      sal: num(n["salt_100g"]),
    },
    portions,
  };
}

/* --------------------------------------------------------------- ranking ---
   Upstream relevance is poor: "hovis wholemeal bread" returns Mission wraps
   and pâte feuilletée above the actual loaf. Ask for a wide page, re-rank here. */
export function rankFoods(foods: Food[], countries: string[][], q: string): Food[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const ql = q.toLowerCase();

  const scored: { f: Food; s: number }[] = [];
  foods.forEach((f, i) => {
    const hay = (f.name + " " + f.brand).toLowerCase();
    const hits = terms.filter((t) => hay.includes(t)).length;
    if (terms.length && hits === 0) return;   // nothing in common with the query

    let s = 0;
    if (terms.length) s += 10 * (hits / terms.length);   // proportion matched
    if (hay.includes(ql)) s += 6;                        // whole phrase, in order
    if (terms.length && hay.startsWith(terms[0])) s += 4;
    if ((countries[i] ?? []).includes("en:united-kingdom")) s += 5;  // used in the UK
    if (f.brand) s += 0.5;
    s -= Math.min(3, f.name.length / 40);                // prefer the less waffly name

    scored.push({ f, s });
  });

  scored.sort((a, b) => b.s - a.s);

  const seen = new Set<string>();
  const out: Food[] = [];
  for (const { f } of scored) {
    if (f.code && seen.has(f.code)) continue;
    seen.add(f.code);
    out.push(f);
  }
  return out;
}
