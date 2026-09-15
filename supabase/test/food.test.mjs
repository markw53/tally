/* Tests for the pure half of the off edge function — the conversion from an
   Open Food Facts product to Tally's food shape, and the re-ranking.

   Run:  node --experimental-strip-types supabase/test/food.test.mjs
   (or plain `node` on 23 and later, where that's the default)

   No Deno and no network — Node strips the types and runs the real file, so
   what's tested is what deploys. What's being guarded here is a port: the
   same logic lives in server/main.go, and the two backends have to agree, or
   the same barcode gives different calories depending on which answered. */

import { toFood, rankFoods } from "../functions/off/food.ts";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

console.log("\n— converting a product —");

const beans = toFood({
  code: "5000157024671",
  product_name: "Baked Beans In Tomato Sauce",
  brands: "Heinz,H.J. Heinz",
  serving_size: "1/2 can (207g)",
  serving_quantity: 207,
  product_quantity: 415,
  nutriments: {
    "energy-kcal_100g": 78, proteins_100g: 4.7, carbohydrates_100g: 12.9,
    fat_100g: 0.2, fiber_100g: 3.7, sugars_100g: 4.7, salt_100g: 0.6,
  },
});

ok("energy carried through", beans.per100.k === 78, JSON.stringify(beans.per100));
ok("only the first brand is kept", beans.brand === "Heinz", beans.brand);
ok("the pack's own serving is offered", beans.portions[0].g === 207, JSON.stringify(beans.portions[0]));
ok("as is the whole tin", beans.portions.some(p => p.g === 415));
ok("100 g and free grams are always there",
   beans.portions.some(p => p.g === 100) && beans.portions.some(p => p.gram));
ok("id is namespaced by source", beans.id === "o_5000157024671", beans.id);

// OFF gives kJ when a product has no kcal figure
const kj = toFood({ code: "1", product_name: "Something", nutriments: { energy_100g: 1000 } });
ok("kJ converts to kcal", kj && Math.abs(kj.per100.k - 239) < 1, JSON.stringify(kj && kj.per100));

// OFF sometimes sends numbers as strings
const str = toFood({ code: "2", product_name: "Stringy", nutriments: { "energy-kcal_100g": "150.4" } });
ok("numbers sent as strings are accepted", str && str.per100.k === 150.4, JSON.stringify(str && str.per100));

/* An entry with no calories is worse than no entry: it looks logged but adds
   nothing, which is exactly how a day silently under-reports. */
ok("a product with no energy is rejected",
   toFood({ code: "3", product_name: "Mystery", nutriments: {} }) === null);
ok("so is one with zero energy",
   toFood({ code: "4", product_name: "Zero", nutriments: { "energy-kcal_100g": 0 } }) === null);

// a nameless product still has a barcode, which beats showing nothing
const noName = toFood({ code: "9999", nutriments: { "energy-kcal_100g": 50 } });
ok("a nameless product falls back to its barcode", noName && noName.name === "Barcode 9999",
   noName && noName.name);

// a serving quantity equal to the pack shouldn't produce two identical chips
const single = toFood({
  code: "5", product_name: "Single pot", serving_quantity: 150, product_quantity: 150,
  nutriments: { "energy-kcal_100g": 90 },
});
ok("a single-serving pack isn't listed twice",
   single.portions.filter(p => p.g === 150).length === 1,
   JSON.stringify(single.portions));

console.log("\n— ranking —");

/* The case that justifies the whole function: upstream puts Mission wraps and
   pâte feuilletée above the actual loaf when you search for Hovis. */
const foods = [
  { name: "Mission Deli Wraps", brand: "Mission", code: "a", per100: {}, portions: [] },
  { name: "Pâte feuilletée", brand: "Croustipate", code: "b", per100: {}, portions: [] },
  { name: "Hovis Wholemeal Medium Sliced Bread", brand: "Hovis", code: "c", per100: {}, portions: [] },
  { name: "Wholemeal flour", brand: "", code: "d", per100: {}, portions: [] },
];
const countries = [[], [], ["en:united-kingdom"], []];

const ranked = rankFoods(foods, countries, "hovis wholemeal bread");
ok("the thing you searched for comes first", ranked[0].code === "c", ranked.map(f => f.name).join(" | "));
ok("products sharing no word with the query are dropped",
   !ranked.some(f => f.code === "a" || f.code === "b"), ranked.map(f => f.name).join(" | "));

// shorter, less waffly names win ties
const tie = rankFoods([
  { name: "Cheddar Cheese Mature Extra Strong Vintage Reserve Selection", brand: "X", code: "1", per100: {}, portions: [] },
  { name: "Cheddar Cheese", brand: "X", code: "2", per100: {}, portions: [] },
], [[], []], "cheddar cheese");
ok("the plainer name wins a tie", tie[0].code === "2", tie.map(f => f.name).join(" | "));

// UK products float up, because that's where this is used
const uk = rankFoods([
  { name: "Digestive Biscuits", brand: "Generic", code: "1", per100: {}, portions: [] },
  { name: "Digestive Biscuits", brand: "Generic", code: "2", per100: {}, portions: [] },
], [[], ["en:united-kingdom"]], "digestive biscuits");
ok("UK products are preferred", uk[0].code === "2", uk.map(f => f.code).join(","));

// the same barcode twice in a page shouldn't show twice
const dupes = rankFoods([
  { name: "Milk", brand: "A", code: "same", per100: {}, portions: [] },
  { name: "Milk semi skimmed", brand: "A", code: "same", per100: {}, portions: [] },
], [[], []], "milk");
ok("duplicate barcodes are collapsed", dupes.length === 1, String(dupes.length));

// an empty query shouldn't throw or drop everything
ok("an empty query is survivable", rankFoods(foods, countries, "").length === foods.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
