/* Replace the curated list's nutrition values with the authoritative CoFID
 * figures, keeping its names, categories and — the whole point — its portion
 * sizes, which CoFID does not have.
 *
 *   node tools/apply-cofid-values.js        # rewrites foods.js in place
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const { UK_FOODS } = require(path.join(root, "foods-uk.js"));
const map = require(path.join(root, "tools/portion-map.json"));

const uk = new Map(UK_FOODS.map(f => [f[0], f]));
let src = fs.readFileSync(path.join(root, "foods.js"), "utf8");

const changed = [], unmapped = [], missing = [];
for (const [name, cofidName] of Object.entries(map)) {
  if (name.startsWith("_")) continue;
  const ref = uk.get(cofidName);
  if (!ref) { missing.push(`${name} -> ${cofidName}`); continue; }

  // ["Name","Cat",kcal,p,c,f,  ...rest
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(\\["${esc}","[^"]*",)(-?[\\d.]+),(-?[\\d.]+),(-?[\\d.]+),(-?[\\d.]+),`);
  const m = src.match(re);
  if (!m) { unmapped.push(name); continue; }

  const before = [m[2], m[3], m[4], m[5]].map(Number);
  const after = [ref[2], ref[3], ref[4], ref[5]];
  if (before.join() !== after.join()) {
    changed.push({ name, cofidName, before, after });
  }
  src = src.replace(re, `$1${after[0]},${after[1]},${after[2]},${after[3]},`);
}

fs.writeFileSync(path.join(root, "foods.js"), src);

changed.sort((a, b) => Math.abs(b.after[0] - b.before[0]) - Math.abs(a.after[0] - a.before[0]));
console.log(`updated ${changed.length} foods from CoFID`);
console.log(`unchanged (already correct): ${Object.keys(map).length - 1 - changed.length - unmapped.length - missing.length}`);
if (unmapped.length) console.log("NOT FOUND in foods.js:", unmapped.join(", "));
if (missing.length) console.log("NOT FOUND in CoFID:", missing.join(", "));
console.log("\nLargest corrections (kcal per 100 g):");
for (const c of changed.slice(0, 18)) {
  const d = c.after[0] - c.before[0];
  console.log(`  ${c.name.padEnd(28).slice(0,28)} ${String(c.before[0]).padStart(4)} -> ${String(c.after[0]).padStart(4)}  (${d > 0 ? "+" : ""}${d})`);
}
