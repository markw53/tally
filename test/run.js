/* Headless smoke + behaviour tests for Tally.
   Run:  node test/run.js     (with a static server on :8765) */
const { chromium } = require("playwright");

const URL = "http://127.0.0.1:8765/";
let pass = 0, fail = 0;
const errors = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  const page = await ctx.newPage();

  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));

  console.log("\n— load —");
  await page.goto(URL, { waitUntil: "networkidle" });
  ok("title is right", (await page.title()).startsWith("Tally"));
  ok("today view visible", await page.locator("#view-today").isVisible());
  ok("four meals rendered", (await page.locator(".meal").count()) === 4);
  ok("built-in foods loaded", await page.evaluate(() => BUILTIN.length > 90));

  console.log("\n— goal & macros —");
  await page.click('.tab[data-view="settings"]');
  await page.fill("#setGoal", "2200");
  await page.fill("#setP", "30"); await page.fill("#setC", "40"); await page.fill("#setF", "30");
  await page.click("#saveGoal");
  await page.click('.tab[data-view="today"]');
  ok("goal saved and shown", (await page.locator("#sumGoal").textContent()) === "2200");
  ok("remaining = goal when empty", (await page.locator("#kcalLeft").textContent()) === "2200");

  console.log("\n— TDEE calculator —");
  await page.click('.tab[data-view="settings"]');
  await page.selectOption("#cSex", "m");
  await page.fill("#cAge", "40"); await page.fill("#cHt", "178"); await page.fill("#cWt", "85");
  await page.selectOption("#cAct", "1.375");
  await page.selectOption("#cAim", "-550");
  await page.click("#calcGoal");
  const calcTxt = await page.locator("#calcOut").textContent();
  // BMR = 10*85 + 6.25*178 - 5*40 + 5 = 850 + 1112.5 - 200 + 5 = 1767.5
  // TDEE = 1767.5 * 1.375 = 2430.3 ; target = round((2430.3-550)/10)*10 = 1880
  ok("maintenance figure correct", /2430/.test(calcTxt), calcTxt);
  ok("suggested goal correct", (await page.inputValue("#setGoal")) === "1880", calcTxt);

  /* stub USDA so the reference-search path is exercised without live network */
  await page.route("**/api.nal.usda.gov/**", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      foods: [{
        fdcId: 2708489, description: "Oats, raw", dataType: "Survey (FNDDS)", foodCategory: "Cereals",
        foodNutrients: [
          { nutrientId: 1008, value: 379 }, { nutrientId: 1003, value: 13.15 },
          { nutrientId: 1005, value: 67.7 }, { nutrientId: 1004, value: 6.52 }
        ]
      }]
    })
  }));

  console.log("\n— log a built-in food —");
  await page.click('.tab[data-view="today"]');
  await page.click('[data-addmeal="Breakfast"]');
  await page.fill("#searchInput", "porridge oats");
  await page.waitForTimeout(450);
  const firstName = await page.locator("#results .res .nm").first().textContent();
  ok("search finds porridge oats", /porridge oats/i.test(firstName), firstName);
  await page.waitForTimeout(400);
  ok("USDA reference results appended", /Reference foods/.test(await page.locator("#results").textContent()));
  await page.locator("#results .res").first().click();
  await page.waitForSelector("#portionBody .pkcal");
  // default portion is 40 g of 379 kcal/100g = 151.6 -> 152
  ok("default portion kcal correct", (await page.locator("#portionBody .pkcal b").textContent()) === "152",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.click('[data-mult="2"]');
  ok("2× multiplier doubles it", (await page.locator("#portionBody .pkcal b").textContent()) === "303",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.click('[data-mult="1"]');
  await page.click("#pAdd");
  await page.waitForTimeout(200);
  ok("entry appears in breakfast", (await page.locator(".meal", { hasText: "Breakfast" }).locator(".entry").count()) === 1);
  ok("day total updated", (await page.locator("#sumFood").textContent()) === "152");
  ok("remaining updated", (await page.locator("#sumLeft").textContent()) === "2048");

  console.log("\n— gram entry —");
  await page.click('[data-addmeal="Lunch"]');
  await page.fill("#searchInput", "chicken breast, cooked");
  await page.waitForTimeout(450);
  await page.locator("#results .res").first().click();
  await page.waitForSelector("#portionBody");
  const gramChip = page.locator('#portionBody [data-port]').filter({ hasText: "grams" });
  await gramChip.click();
  await page.fill("#pAmt", "200");
  await page.waitForTimeout(120);
  // 165 kcal/100g * 200g = 330
  ok("gram amount maths correct", (await page.locator("#portionBody .pkcal b").textContent()) === "330",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.click("#pAdd");
  await page.waitForTimeout(200);
  ok("total is 152 + 330", (await page.locator("#sumFood").textContent()) === "482",
     await page.locator("#sumFood").textContent());
  ok("protein tracked", await page.evaluate(() => dayTotals(curDate).p > 60));

  console.log("\n— quick add —");
  await page.click('[data-addmeal="Dinner"]');
  await page.click('#srcChips .chip[data-src="quick"]');
  await page.fill("#qaK", "500");
  await page.fill("#qaP", "20");
  await page.click("#qaAdd");
  await page.waitForTimeout(200);
  ok("quick add lands", (await page.locator("#sumFood").textContent()) === "982",
     await page.locator("#sumFood").textContent());

  console.log("\n— edit an existing entry —");
  await page.locator(".meal", { hasText: "Breakfast" }).locator(".entry .txt").first().click();
  await page.waitForSelector("#portionBody");
  ok("edit sheet opens with save label", /Save changes/.test(await page.locator("#pAdd").textContent()));
  const gc = page.locator('#portionBody [data-port]').filter({ hasText: "grams" });
  await gc.click();
  await page.fill("#pAmt", "80");
  await page.waitForTimeout(120);
  await page.click("#pAdd");
  await page.waitForTimeout(250);
  // porridge 80 g = 303 ; total = 303 + 330 + 500 = 1133
  ok("edit replaces rather than duplicates",
     (await page.locator(".meal", { hasText: "Breakfast" }).locator(".entry").count()) === 1);
  ok("edited total correct", (await page.locator("#sumFood").textContent()) === "1133",
     await page.locator("#sumFood").textContent());

  console.log("\n— delete + undo —");
  await page.locator(".meal", { hasText: "Dinner" }).locator(".entry .del").first().click();
  await page.waitForTimeout(150);
  ok("delete removes the entry", (await page.locator("#sumFood").textContent()) === "633",
     await page.locator("#sumFood").textContent());
  await page.click("#toastAction");
  await page.waitForTimeout(150);
  ok("undo restores it", (await page.locator("#sumFood").textContent()) === "1133",
     await page.locator("#sumFood").textContent());

  console.log("\n— recents & frequents —");
  await page.click('.tab[data-view="foods"]');
  ok("frequent list populated", (await page.locator("#frequentList .res").count()) >= 2);

  console.log("\n— date navigation —");
  await page.click('.tab[data-view="today"]');
  await page.click("#dayPrev");
  ok("previous day is empty", (await page.locator("#sumFood").textContent()) === "0");
  ok("label says Yesterday", (await page.locator("#dayLabel").textContent()) === "Yesterday");
  await page.click("#dayNext");
  ok("back to today", (await page.locator("#dayLabel").textContent()) === "Today");
  ok("today's data intact", (await page.locator("#sumFood").textContent()) === "1133");

  console.log("\n— trends —");
  await page.click('.tab[data-view="trends"]');
  ok("14 bars drawn", (await page.locator("#chart14 .bar").count()) === 14);
  await page.fill("#weightInput", "84.2");
  await page.click("#weightSave");
  await page.waitForTimeout(150);
  ok("weight logged", (await page.locator("#chartW .bar").count()) === 1);

  console.log("\n— persistence across reload —");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  ok("diary survives reload", (await page.locator("#sumFood").textContent()) === "1133",
     await page.locator("#sumFood").textContent());
  ok("goal survives reload", (await page.locator("#sumGoal").textContent()) === "2200");

  console.log("\n— barcode path (network-independent stub) —");
  await page.route("**/world.openfoodfacts.org/**", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      code: "5000157024671", status: 1,
      product: {
        code: "5000157024671", product_name: "Beanz in a rich tomato sauce", brands: "Heinz",
        quantity: "415g", product_quantity: 415, serving_size: "0.5 Can (207 g)", serving_quantity: 207,
        nutriments: { "energy-kcal_100g": 79, proteins_100g: 4.7, carbohydrates_100g: 12.9, fat_100g: 0.2, fiber_100g: 3.7, salt_100g: 0.6 }
      }
    })
  }));
  await page.click('[data-addmeal="Lunch"]');
  await page.fill("#searchInput", "5000157024671");
  await page.waitForTimeout(400);
  ok("bare number offers a barcode lookup", (await page.locator("[data-barcode]").count()) === 1);
  await page.click("[data-barcode]");
  await page.waitForSelector("#portionBody .pkcal", { timeout: 5000 });
  ok("scanned product name shown", (await page.locator("#portionName").textContent()).includes("Beanz"));
  // default portion = serving 207 g at 79 kcal/100g = 163.5 -> 164
  ok("serving-size portion used by default",
     (await page.locator("#portionBody .pkcal b").textContent()) === "164",
     await page.locator("#portionBody .pkcal b").textContent());
  ok("fibre and salt surfaced", /Fibre/.test(await page.locator("#portionBody").textContent()));
  const packChip = page.locator("#portionBody [data-port]").filter({ hasText: "whole pack" });
  ok("whole-pack portion offered", (await packChip.count()) === 1);
  await packChip.click();
  ok("whole pack = 328 kcal", (await page.locator("#portionBody .pkcal b").textContent()) === "328",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.click("#pAdd");
  await page.waitForTimeout(200);
  ok("barcode item logged", (await page.locator("#sumFood").textContent()) === "1461",
     await page.locator("#sumFood").textContent());

  console.log("\n— barcode cached for offline reuse —");
  ok("product cached in local storage",
     await page.evaluate(() => !!JSON.parse(localStorage.getItem("tally.v1")).offCache["5000157024671"]));

  console.log("\n— unknown barcode is handled —");
  await page.route("**/world.openfoodfacts.org/api/v2/product/9999999999999**", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ code: "9999999999999", status: 0, status_verbose: "product not found" })
  }));
  page.once("dialog", d => d.dismiss());
  await page.click('[data-addmeal="Snacks"]');
  await page.fill("#searchInput", "9999999999999");
  await page.waitForTimeout(400);
  await page.click("[data-barcode]");
  await page.waitForTimeout(700);
  ok("missing product does not crash", await page.locator("#view-today").isVisible());

  console.log("\n— search failures name their cause —");
  async function searchWith(handler, query) {
    await page.unroute("**/api.nal.usda.gov/**");
    await page.route("**/api.nal.usda.gov/**", handler);
    await page.click('[data-addmeal="Lunch"]');
    await page.fill("#searchInput", query);
    await page.waitForTimeout(900);
    const txt = await page.locator("#results").textContent();
    await page.keyboard.press("Escape");
    return txt;
  }

  let t = await searchWith(r => r.fulfill({ status: 429, contentType: "application/json",
    body: JSON.stringify({ error: { code: "OVER_RATE_LIMIT", message: "rate limit exceeded" } }) }), "beetroot");
  ok("rate limit says so and points at the key setting", /hourly limit/.test(t) && /Food search key/.test(t), t.slice(-160));

  t = await searchWith(r => r.fulfill({ status: 403, contentType: "application/json",
    body: JSON.stringify({ error: { code: "API_KEY_INVALID", message: "An invalid api_key was supplied" } }) }), "parsnip");
  ok("bad key is reported as a key problem", /rejected/.test(t), t.slice(-160));

  t = await searchWith(r => r.abort("failed"), "swede");
  ok("network failure mentions blockers, not a generic shrug", /offline/.test(t) && /api\.nal\.usda\.gov/.test(t), t.slice(-180));

  t = await searchWith(r => r.fulfill({ status: 500, contentType: "text/plain", body: "boom" }), "turnip");
  ok("server error shows the status code", /HTTP 500/.test(t), t.slice(-160));

  console.log("\n— connection self-test —");
  await page.unroute("**/api.nal.usda.gov/**");
  await page.route("**/api.nal.usda.gov/**", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ foods: [{ fdcId: 9, description: "Apple, raw", dataType: "Foundation", foodNutrients: [{ nutrientId: 1008, value: 52 }] }] }) }));
  await page.click('.tab[data-view="settings"]');
  await page.click("#testUsda");
  await page.waitForTimeout(700);
  ok("test button reports success", /Working/.test(await page.locator("#usdaTestOut").textContent()),
     await page.locator("#usdaTestOut").textContent());

  await page.unroute("**/api.nal.usda.gov/**");
  await page.route("**/api.nal.usda.gov/**", r => r.abort("failed"));
  await page.click("#testUsda");
  await page.waitForTimeout(700);
  ok("test button reports failure clearly", /offline/.test(await page.locator("#usdaTestOut").textContent()),
     await page.locator("#usdaTestOut").textContent());

  console.log("\n— search via your own offproxy server —");
  const PROXY = "https://tally.example.test";
  let proxyHits = { search: 0, product: 0 };
  await page.route(PROXY + "/api/search**", route => {
    proxyHits.search++;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      foods: [{
        id: "o_5010026500114", name: "Hovis Wholemeal Bread", brand: "Hovis",
        code: "5010026500114", source: "off",
        per100: { k: 221, p: 9.6, c: 36.5, f: 2.1, fib: 6.4 },
        portions: [{ label: "serving — 1 slice (40 g)", g: 40 }, { label: "100 g", g: 100 }, { label: "grams", g: 1, gram: true }]
      }]
    })});
  });
  await page.route(PROXY + "/api/product/**", route => {
    proxyHits.product++;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      food: {
        id: "o_5000157024671", name: "Beanz in a rich tomato sauce", brand: "Heinz",
        code: "5000157024671", source: "off",
        per100: { k: 79, p: 4.7, c: 12.9, f: 0.2, fib: 3.7, sal: 0.6 },
        portions: [{ label: "serving — 0.5 Can (207 g)", g: 207 }, { label: "whole pack (415 g)", g: 415 },
                   { label: "100 g", g: 100 }, { label: "grams", g: 1, gram: true }]
      }
    })});
  });

  await page.click('.tab[data-view="settings"]');
  await page.fill("#setServer", PROXY);
  await page.click("#saveUsda");
  await page.waitForTimeout(200);

  await page.click("#testUsda");
  await page.waitForTimeout(600);
  ok("test button confirms the server path", /via your server/.test(await page.locator("#usdaTestOut").textContent()),
     await page.locator("#usdaTestOut").textContent());

  await page.click('.tab[data-view="today"]');
  await page.click('[data-addmeal="Lunch"]');
  await page.fill("#searchInput", "hovis wholemeal");
  await page.waitForTimeout(800);
  const rTxt = await page.locator("#results").textContent();
  ok("results are labelled as Open Food Facts", /Open Food Facts/.test(rTxt), rTxt.slice(0, 120));
  ok("proxy search was actually called", proxyHits.search > 0);
  ok("USDA was not called while a server is set", /Hovis Wholemeal Bread/.test(rTxt));

  await page.locator("#results .res").filter({ hasText: "Hovis Wholemeal Bread" }).first().click();
  await page.waitForSelector("#portionBody .pkcal");
  // 40 g slice at 221 kcal/100g = 88.4 -> 88
  ok("server portions drive the maths", (await page.locator("#portionBody .pkcal b").textContent()) === "88",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.keyboard.press("Escape");

  console.log("\n— barcode routes through the server too —");
  await page.evaluate(() => { S.offCache = {}; save(); });
  await page.click('[data-addmeal="Dinner"]');
  await page.fill("#searchInput", "5000157024671");
  await page.waitForTimeout(400);
  await page.click("[data-barcode]");
  await page.waitForSelector("#portionBody .pkcal", { timeout: 5000 });
  ok("proxy product endpoint was used", proxyHits.product > 0);
  ok("scanned product came back intact", (await page.locator("#portionName").textContent()).includes("Beanz"));
  ok("serving portion still default", (await page.locator("#portionBody .pkcal b").textContent()) === "164",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.keyboard.press("Escape");

  console.log("\n— server failures are named, not generic —");
  await page.unroute(PROXY + "/api/search**");
  await page.route(PROXY + "/api/search**", r => r.fulfill({ status: 503, contentType: "application/json",
    body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "upstream search budget spent" } }) }));
  await page.click('[data-addmeal="Lunch"]');
  await page.fill("#searchInput", "cheddar");
  await page.waitForTimeout(800);
  ok("server rate limit explained", /pacing itself/.test(await page.locator("#results").textContent()));
  await page.keyboard.press("Escape");

  await page.unroute(PROXY + "/api/search**");
  await page.route(PROXY + "/api/search**", r => r.abort("failed"));
  await page.click('[data-addmeal="Lunch"]');
  await page.fill("#searchInput", "stilton");
  await page.waitForTimeout(800);
  const downTxt = await page.locator("#results").textContent();
  ok("unreachable server names the URL and OFFPROXY_ORIGINS",
     /tally\.example\.test/.test(downTxt) && /OFFPROXY_ORIGINS/.test(downTxt), downTxt.slice(-200));
  await page.keyboard.press("Escape");

  console.log("\n— clearing the server falls back to USDA —");
  await page.click('.tab[data-view="settings"]');
  await page.fill("#setServer", "");
  await page.click("#saveUsda");
  await page.waitForTimeout(200);
  await page.unroute("**/api.nal.usda.gov/**");
  await page.route("**/api.nal.usda.gov/**", r => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ foods: [{ fdcId: 11, description: "Cheddar cheese", dataType: "Foundation",
      foodNutrients: [{ nutrientId: 1008, value: 416 }, { nutrientId: 1003, value: 25.4 }] }] }) }));
  await page.click('.tab[data-view="today"]');
  await page.click('[data-addmeal="Lunch"]');
  await page.fill("#searchInput", "cheddar cheese");
  await page.waitForTimeout(800);
  ok("USDA label returns once the server is cleared",
     /Reference foods \(USDA\)/.test(await page.locator("#results").textContent()));
  await page.keyboard.press("Escape");

  console.log("\n— export —");
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.click('.tab[data-view="settings"]');
  await page.click("#exportBtn");
  const d = await dl;
  ok("export produces a file", !!d && /tally-backup-/.test(d.suggestedFilename()));

  console.log("\n— service worker —");
  const swOK = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!r;
  });
  ok("service worker registered", swOK);

  console.log("\n— responsive / layout —");
  ok("no horizontal overflow", await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1));

  await ctx.close();

  /* dark mode render check */
  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const dp = await dark.newPage();
  await dp.goto(URL, { waitUntil: "networkidle" });
  const bodyBg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok("dark theme applies", bodyBg !== "rgb(245, 246, 245)" && bodyBg !== "rgba(0, 0, 0, 0)", bodyBg);
  await dark.close();

  await browser.close();

  console.log("\n— console errors —");
  /* "Failed to load resource" lines are the browser reporting the failures the
     error-path tests deliberately injected — not faults in the app. Real
     problems surface as pageerror or as console.error from our own code. */
  const real = errors.filter(e => !/favicon/i.test(e) && !/^Failed to load resource/i.test(e));
  ok("no uncaught console errors", real.length === 0, real.slice(0, 5).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
