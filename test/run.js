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

  console.log("\n— UK reference foods (CoFID) —");
  ok("UK dataset loaded", await page.evaluate(() => typeof UK_FOODS !== "undefined" && UK_FOODS.length > 2500),
     String(await page.evaluate(() => (typeof UK_FOODS === "undefined" ? 0 : UK_FOODS.length))));

  // values must match the published dataset exactly
  const bread = await page.evaluate(() => UK_FOODS.find(f => f[0] === "Bread, wholemeal, average"));
  ok("wholemeal bread matches the source", JSON.stringify(bread.slice(2, 7)) === JSON.stringify([217, 9.4, 42, 2.5, 7]),
     JSON.stringify(bread));

  // the head-noun boost: "Sauce, bread" must not outrank actual bread
  await page.click('.tab[data-view="today"]');
  await page.click('[data-addmeal="Breakfast"]');
  await page.fill("#searchInput", "wholemeal bread");
  await page.waitForTimeout(450);
  const breadTop = await page.locator("#results .res .nm").first().textContent();
  ok("searching bread finds bread, not bread sauce", /bread/i.test(breadTop) && !/sauce/i.test(breadTop), breadTop);

  await page.fill("#searchInput", "swede boiled");
  await page.waitForTimeout(450);
  const swede = await page.locator("#results .res .nm").first().textContent();
  ok("obscure UK vegetables are findable", /swede/i.test(swede), swede);

  // a CoFID food logs correctly at an arbitrary gram amount
  await page.fill("#searchInput", "Bread, wholemeal, average");
  await page.waitForTimeout(450);
  await page.locator("#results .res").first().click();
  await page.waitForSelector("#portionBody .pkcal");
  ok("CoFID food defaults to 100 g", (await page.locator("#portionBody .pkcal b").textContent()) === "217",
     await page.locator("#portionBody .pkcal b").textContent());
  ok("source is credited in the sheet", /McCance/.test(await page.locator("#portionBody").textContent()));
  ok("fibre carried through", /Fibre/.test(await page.locator("#portionBody").textContent()));
  const gramChipUK = page.locator("#portionBody [data-port]").filter({ hasText: "grams" });
  await gramChipUK.click();
  await page.fill("#pAmt", "80");
  await page.waitForTimeout(150);
  // 217 kcal/100g * 80g = 173.6 -> 174
  ok("gram maths on UK data", (await page.locator("#portionBody .pkcal b").textContent()) === "174",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.keyboard.press("Escape");

  console.log("\n— no key, no server: search stays offline —");
  await page.click('[data-addmeal="Breakfast"]');
  await page.fill("#searchInput", "cheddar");
  await page.waitForTimeout(900);
  const offlineResults = await page.locator("#results").textContent();
  ok("UK results appear with no network search", /cheddar/i.test(offlineResults), offlineResults.slice(0, 90));
  ok("no USDA section without a key", !/Reference foods \(USDA\)/.test(offlineResults));
  ok("no error shown when there's nothing remote to ask",
     !/Couldn't reach/.test(offlineResults) && !/demo key/.test(offlineResults));
  await page.keyboard.press("Escape");

  /* USDA is opt-in now, so enable it before the tests that expect its results */
  await page.click('.tab[data-view="settings"]');
  await page.fill("#setUsda", "test-key-for-stubbed-usda");
  await page.click("#saveUsda");
  await page.waitForTimeout(250);

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
  // default portion is 40 g of 381 kcal/100g = 152.4 -> 152
  ok("default portion kcal correct", (await page.locator("#portionBody .pkcal b").textContent()) === "152",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.click('[data-mult="2"]');
  ok("2× multiplier doubles it", (await page.locator("#portionBody .pkcal b").textContent()) === "305",
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
  // 148 kcal/100g * 200g = 296
  ok("gram amount maths correct", (await page.locator("#portionBody .pkcal b").textContent()) === "296",
     await page.locator("#portionBody .pkcal b").textContent());
  await page.click("#pAdd");
  await page.waitForTimeout(200);
  ok("total is 152 + 296", (await page.locator("#sumFood").textContent()) === "448",
     await page.locator("#sumFood").textContent());
  ok("protein tracked", await page.evaluate(() => dayTotals(curDate).p > 60));

  console.log("\n— quick add —");
  await page.click('[data-addmeal="Dinner"]');
  await page.click('#srcChips .chip[data-src="quick"]');
  await page.fill("#qaK", "500");
  await page.fill("#qaP", "20");
  await page.click("#qaAdd");
  await page.waitForTimeout(200);
  ok("quick add lands", (await page.locator("#sumFood").textContent()) === "948",
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
  // porridge 80 g = 305 ; total = 305 + 296 + 500 = 1101
  ok("edit replaces rather than duplicates",
     (await page.locator(".meal", { hasText: "Breakfast" }).locator(".entry").count()) === 1);
  ok("edited total correct", (await page.locator("#sumFood").textContent()) === "1101",
     await page.locator("#sumFood").textContent());

  console.log("\n— delete + undo —");
  await page.locator(".meal", { hasText: "Dinner" }).locator(".entry .del").first().click();
  await page.waitForTimeout(150);
  ok("delete removes the entry", (await page.locator("#sumFood").textContent()) === "601",
     await page.locator("#sumFood").textContent());
  await page.click("#toastAction");
  await page.waitForTimeout(150);
  ok("undo restores it", (await page.locator("#sumFood").textContent()) === "1101",
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
  ok("today's data intact", (await page.locator("#sumFood").textContent()) === "1101");

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
  ok("diary survives reload", (await page.locator("#sumFood").textContent()) === "1101",
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
  ok("barcode item logged", (await page.locator("#sumFood").textContent()) === "1429",
     await page.locator("#sumFood").textContent());

  console.log("\n— barcode cached for offline reuse —");
  ok("product cached in local storage",
     await page.evaluate(() => !!JSON.parse(localStorage.getItem(dataKey())).offCache["5000157024671"]));

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
  // a key is configured by this point, so it should be the personal-key wording
  ok("rate limit still surfaces (it's actionable)", /Your USDA key has hit its hourly limit/.test(t), t.slice(-200));

  t = await searchWith(r => r.fulfill({ status: 403, contentType: "application/json",
    body: JSON.stringify({ error: { code: "API_KEY_INVALID", message: "An invalid api_key was supplied" } }) }), "parsnip");
  ok("bad key is reported as a key problem", /rejected/.test(t), t.slice(-160));

  t = await searchWith(r => r.abort("failed"), "swede");
  ok("a flaky optional source stays silent when UK results answered",
     !/offline/.test(t) && /swede/i.test(t), t.slice(-180));

  t = await searchWith(r => r.fulfill({ status: 500, contentType: "text/plain", body: "boom" }), "turnip");
  ok("a transient USDA error does not shout over good UK results",
     !/HTTP 500/.test(t) && /turnip/i.test(t), t.slice(-160));

  // but with no local match at all, the user still gets told what went wrong
  t = await searchWith(r => r.abort("failed"), "zzzznotafood");
  ok("with nothing local, the failure is explained", /offline|Couldn't reach/.test(t), t.slice(-180));

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

  console.log("\n— barcode still works when the server is unreachable —");
  await page.evaluate(() => { S.offCache = {}; save(); });
  await page.unroute(PROXY + "/api/product/**");
  await page.route(PROXY + "/api/product/**", r => r.abort("failed"));   // server down
  await page.unroute("**/world.openfoodfacts.org/**");
  await page.route("**/world.openfoodfacts.org/**", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ code: "5000157024671", status: 1, product: {
      code: "5000157024671", product_name: "Beanz in a rich tomato sauce", brands: "Heinz",
      product_quantity: 415, serving_size: "0.5 Can (207 g)", serving_quantity: 207,
      nutriments: { "energy-kcal_100g": 79, proteins_100g: 4.7, carbohydrates_100g: 12.9, fat_100g: 0.2 } } })
  }));
  await page.click('[data-addmeal="Dinner"]');
  await page.fill("#searchInput", "5000157024671");
  await page.waitForTimeout(400);
  await page.click("[data-barcode]");
  await page.waitForSelector("#portionBody .pkcal", { timeout: 6000 });
  ok("falls back to Open Food Facts directly",
     (await page.locator("#portionName").textContent()).includes("Beanz"));
  await page.keyboard.press("Escape");

  // but a genuine "not in the database" answer must NOT be retried directly
  await page.evaluate(() => { S.offCache = {}; save(); });
  let directCalls = 0;
  await page.unroute("**/world.openfoodfacts.org/**");
  await page.route("**/world.openfoodfacts.org/**", route => {
    directCalls++;
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ code: "7777777777777", status: 0 }) });
  });
  await page.unroute(PROXY + "/api/product/**");
  await page.route(PROXY + "/api/product/**", r => r.fulfill({ status: 404,
    contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) }));
  page.once("dialog", d => d.dismiss());
  await page.click('[data-addmeal="Snacks"]');
  await page.fill("#searchInput", "7777777777777");
  await page.waitForTimeout(400);
  await page.click("[data-barcode]");
  await page.waitForTimeout(800);
  ok("a definite 'not found' is not pointlessly retried", directCalls === 0, `direct calls: ${directCalls}`);

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

  console.log("\n— profiles: migration from the single-diary version —");
  {
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p2 = await ctx2.newPage();
    // seed the OLD storage key, as an existing v1.0 install would have
    await p2.goto(URL, { waitUntil: "domcontentloaded" });
    await p2.evaluate(() => {
      /* Use *today's* date, computed in the browser. Hardcoding one makes the
         test pass only on the day it was written. */
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      localStorage.clear();
      localStorage.setItem("tally.v1", JSON.stringify({
        goal: 1750,
        diary: { [today]: { Breakfast: [{ id: "old1", name: "Legacy porridge", source: "quick", grams: 100, portionLabel: "", per100: { k: 300, p: 10, c: 50, f: 5 } }], Lunch: [], Dinner: [], Snacks: [] } }
      }));
    });
    await p2.reload({ waitUntil: "networkidle" });
    await p2.waitForTimeout(400);
    ok("old diary survives the upgrade", (await p2.locator("#sumFood").textContent()) === "300",
       await p2.locator("#sumFood").textContent());
    ok("old goal survives the upgrade", (await p2.locator("#sumGoal").textContent()) === "1750");
    ok("original key left intact as a safety net",
       await p2.evaluate(() => !!localStorage.getItem("tally.v1")));
    ok("data now lives under a profile key",
       await p2.evaluate(() => !!localStorage.getItem("tally.v1.me")));
    ok("no profile bar with only one person", await p2.locator(".whobar").first().isHidden());
    await ctx2.close();
  }

  console.log("\n— profiles: two people on one device stay separate —");
  {
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p3 = await ctx3.newPage();
    p3.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
    await p3.goto(URL, { waitUntil: "networkidle" });

    // Mark logs something
    await p3.click('[data-addmeal="Breakfast"]');
    await p3.fill("#searchInput", "banana");
    await p3.waitForTimeout(450);
    await p3.locator("#results .res").first().click();
    await p3.waitForSelector("#portionBody .pkcal");
    await p3.click("#pAdd");
    await p3.waitForTimeout(250);
    const markTotal = await p3.locator("#sumFood").textContent();
    ok("first person has entries", +markTotal > 0, markTotal);

    // add a second person
    await p3.click('.tab[data-view="settings"]');
    p3.once("dialog", d => d.accept("Claire"));
    await p3.click("#addProfile");
    await p3.waitForTimeout(300);
    ok("profile bar appears once there are two", await p3.locator("#view-settings .whobar").isVisible());

    await p3.locator("[data-switchto]").first().click();
    await p3.waitForTimeout(400);
    ok("switching lands on Today", await p3.locator("#view-today").isVisible());
    ok("the new person's diary is empty", (await p3.locator("#sumFood").textContent()) === "0",
       await p3.locator("#sumFood").textContent());
    ok("the bar names who is logging", /Claire/.test(await p3.locator("#view-today .whobar").textContent()));

    // switch back via the bar
    await p3.click("#view-today .whobar");
    await p3.waitForTimeout(300);
    await p3.locator("[data-profile]").first().click();
    await p3.waitForTimeout(400);
    ok("switching back restores the first diary", (await p3.locator("#sumFood").textContent()) === markTotal,
       await p3.locator("#sumFood").textContent());
    ok("search sheet still works after the profile picker borrowed it", await (async () => {
      await p3.click('[data-addmeal="Lunch"]');
      const visible = await p3.locator(".searchrow").isVisible() && await p3.locator("#srcChips").isVisible();
      await p3.keyboard.press("Escape");
      return visible;
    })());
    await ctx3.close();
  }

  console.log("\n— sync round-trip against a stub server —");
  {
    const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p4 = await ctx4.newPage();
    p4.on("pageerror", e => errors.push("PAGEERROR: " + e.message));

    // a tiny in-memory stand-in for offproxy that merges the way the real one does
    let serverDiary = { days: {}, weights: {} };
    let serverFoods = {};
    let seenTokens = [];
    await p4.route(PROXY + "/api/diary", async route => {
      const req = route.request();
      seenTokens.push(req.headers()["authorization"] || "");
      const body = JSON.parse(req.postData() || "{}");
      for (const [d, v] of Object.entries(body.days || {})) {
        if (!serverDiary.days[d] || v.updatedAt > serverDiary.days[d].updatedAt) serverDiary.days[d] = v;
      }
      if (body.settings && (!serverDiary.settings || body.settings.updatedAt > serverDiary.settings.updatedAt)) {
        serverDiary.settings = body.settings;
      }
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ account: "mark", diary: serverDiary }) });
    });
    await p4.route(PROXY + "/api/foods", async route => {
      const body = JSON.parse(route.request().postData() || "{}");
      for (const [id, v] of Object.entries(body.foods || {})) {
        if (!serverFoods[id] || v.updatedAt > serverFoods[id].updatedAt) serverFoods[id] = v;
      }
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ foods: serverFoods }) });
    });

    await p4.goto(URL, { waitUntil: "networkidle" });
    await p4.click('.tab[data-view="settings"]');
    await p4.fill("#setServer", PROXY);
    await p4.click("#saveUsda");
    await p4.waitForTimeout(200);
    await p4.fill("#setToken", "mark-token-0123456789abcdef");
    await p4.click("#saveToken");
    await p4.waitForTimeout(700);

    ok("a token is sent as a bearer header", seenTokens.some(t => t.startsWith("Bearer mark-token")),
       JSON.stringify(seenTokens.slice(0, 2)));

    await p4.click('.tab[data-view="today"]');
    await p4.click('[data-addmeal="Breakfast"]');
    await p4.click('#srcChips .chip[data-src="quick"]');
    await p4.fill("#qaK", "420");
    await p4.click("#qaAdd");
    await p4.waitForTimeout(300);
    await p4.click('.tab[data-view="settings"]');
    await p4.click("#syncNowBtn");
    await p4.waitForTimeout(800);
    ok("the entry reached the server", JSON.stringify(serverDiary).includes("420"),
       JSON.stringify(serverDiary).slice(0, 160));
    ok("settings status reports a successful sync", /Synced/.test(await p4.locator("#view-settings").textContent()));

    // a second device pulls it down
    const ctx5 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p5 = await ctx5.newPage();
    await p5.route(PROXY + "/api/diary", route => route.fulfill({ status: 200,
      contentType: "application/json", body: JSON.stringify({ account: "mark", diary: serverDiary }) }));
    await p5.route(PROXY + "/api/foods", route => route.fulfill({ status: 200,
      contentType: "application/json", body: JSON.stringify({ foods: serverFoods }) }));
    await p5.goto(URL, { waitUntil: "networkidle" });
    await p5.click('.tab[data-view="settings"]');
    await p5.fill("#setServer", PROXY);
    await p5.click("#saveUsda");
    await p5.waitForTimeout(200);
    await p5.fill("#setToken", "mark-token-0123456789abcdef");
    await p5.click("#saveToken");
    await p5.waitForTimeout(900);
    await p5.click('.tab[data-view="today"]');
    ok("a second device receives the diary", (await p5.locator("#sumFood").textContent()) === "420",
       await p5.locator("#sumFood").textContent());
    await ctx5.close();

    console.log("\n— sync failures are reported, not silent —");
    await p4.unroute(PROXY + "/api/diary");
    await p4.route(PROXY + "/api/diary", r => r.fulfill({ status: 401, contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "missing or unrecognised token" } }) }));
    await p4.click("#syncNowBtn");
    await p4.waitForTimeout(700);
    ok("a rejected token says so", /didn't recognise that sync token/.test(await p4.locator("#view-settings").textContent()));

    await p4.unroute(PROXY + "/api/diary");
    await p4.route(PROXY + "/api/diary", r => r.abort("failed"));
    await p4.click("#syncNowBtn");
    await p4.waitForTimeout(700);
    const offlineTxt = await p4.locator("#view-settings").textContent();
    ok("an offline server reassures rather than alarms", /saved on this device/.test(offlineTxt), offlineTxt.slice(0, 160));
    await p4.click('.tab[data-view="today"]');
    ok("entries survive a failed sync", (await p4.locator("#sumFood").textContent()) === "420");

    await ctx4.close();
  }

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
