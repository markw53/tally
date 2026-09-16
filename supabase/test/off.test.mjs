/* Runs the real off function under Node, with Deno and fetch stubbed, so the
   request path is tested rather than described.

   Run:  node --experimental-strip-types supabase/test/off.test.mjs

   The point of this file is the auth gate. The platform's verify_jwt is off
   for this function — it can't be used on a project with the newer asymmetric
   signing keys — which means the "you must be signed in" promise rests
   entirely on the code below being right. */

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

/* ---- the environment the function expects ---- */
const ENV = {
  OFF_USER_AGENT: "Tally/1.5 (test@example.com)",
  ALLOWED_ORIGINS: "https://example.github.io",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

let handler;
globalThis.Deno = {
  env: { get: (k) => ENV[k] },
  serve: (h) => { handler = h; },
};

/* ---- a stub Supabase + Open Food Facts ---- */
const calls = { auth: 0, off: 0, cacheReads: 0, cacheWrites: 0 };
let validTokens = new Set(["good-token"]);

function jwt(expSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ sub: "u1", exp: expSeconds })}.sig`;
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", ...headers },
    });

  if (u.includes("/auth/v1/user")) {
    calls.auth++;
    const tok = (init.headers?.Authorization ?? "").replace(/^Bearer\s+/, "");
    if (!validTokens.has(tok)) return json(401, { msg: "invalid claim" });
    return json(200, { id: "user-1", email: "mark@example.com" });
  }
  if (u.includes("/rest/v1/off_cache")) {
    if ((init.method ?? "GET") === "GET") { calls.cacheReads++; return json(200, []); }
    calls.cacheWrites++; return json(201, {});
  }
  if (u.includes("openfoodfacts.org")) {
    calls.off++;
    if (u.includes("/api/v2/product/")) {
      return json(200, { status: 1, product: {
        code: "5000", product_name: "Baked Beans", brands: "Heinz",
        nutriments: { "energy-kcal_100g": 78, proteins_100g: 4.7 },
      }});
    }
    return json(200, { hits: [{
      code: "1", product_name: "Hovis Wholemeal Bread", brands: "Hovis",
      countries_tags: ["en:united-kingdom"],
      nutriments: { "energy-kcal_100g": 217, proteins_100g: 9.4 },
    }]});
  }
  throw new Error("unexpected fetch: " + u);
};

/* Test whichever copy is asked for. The dashboard bundle is what gets pasted
   into the editor, so it is the file that actually runs for anyone who
   deployed without the CLI — testing only the source would miss a bundler bug
   entirely. */
const TARGET = process.env.OFF_TARGET ?? "../functions/off/index.ts";
await import(TARGET);
console.log("  (testing " + TARGET + ")");

const call = (path, headers = {}) =>
  handler(new Request("https://proj.supabase.co/functions/v1/" + path, { headers }));

const AUTH = { Authorization: "Bearer good-token" };

console.log("\n— the auth gate —");
{
  let r = await call("off?q=bread");
  ok("no Authorization header is refused", r.status === 401, String(r.status));
  ok("and says what to do", (await r.json()).error.code === "NO_AUTH");

  r = await call("off?q=bread", { Authorization: "Bearer forged" });
  ok("a token GoTrue doesn't recognise is refused", r.status === 401, String(r.status));
  ok("with a different code, so the app can tell them apart",
     (await r.json()).error.code === "BAD_AUTH");

  const before = calls.off;
  await call("off?q=bread", { Authorization: "Bearer forged" });
  ok("a refused caller never reaches Open Food Facts", calls.off === before);

  r = await call("off?q=bread", AUTH);
  ok("a signed-in caller gets through", r.status === 200, String(r.status));
  ok("and gets results", (await r.json()).foods.length > 0);
}

console.log("\n— the auth cache —");
{
  calls.auth = 0;
  await call("off?q=cheese", AUTH);
  await call("off?q=milk", AUTH);
  await call("off?q=eggs", AUTH);
  ok("a verified token isn't re-checked on every keystroke", calls.auth === 0,
     "auth calls: " + calls.auth);

  /* A token that expires in 2 seconds must not be trusted for the full 5
     minutes the cache would otherwise hold it. */
  const shortLived = jwt(Math.floor(Date.now() / 1000) + 2);
  validTokens.add(shortLived);
  calls.auth = 0;
  await call("off?q=beans", { Authorization: "Bearer " + shortLived });
  ok("a new token is checked once", calls.auth === 1, "auth calls: " + calls.auth);

  validTokens.delete(shortLived);          // as if the session were revoked
  await new Promise(r => setTimeout(r, 2100));
  const r = await call("off?q=beans", { Authorization: "Bearer " + shortLived });
  ok("an expired token is re-checked rather than trusted from cache",
     r.status === 401, String(r.status));
}

console.log("\n— it still does its actual job —");
{
  const r = await call("off?code=5000", AUTH);
  ok("a barcode lookup works", r.status === 200, String(r.status));
  const body = await r.json();
  ok("and returns a usable food", body.food && body.food.per100.k === 78,
     JSON.stringify(body).slice(0, 120));

  const bad = await call("off?code=abc", AUTH);
  ok("a non-numeric barcode is rejected", bad.status === 400, String(bad.status));

  const none = await call("off", AUTH);
  ok("no query at all is a 400, not a crash", none.status === 400, String(none.status));

  /* CORS still has to be right or the browser never sees any of this. */
  const cors = await call("off?q=bread", { ...AUTH, Origin: "https://example.github.io" });
  ok("an allowed origin is echoed back",
     cors.headers.get("access-control-allow-origin") === "https://example.github.io",
     cors.headers.get("access-control-allow-origin"));
  const other = await call("off?q=bread", { ...AUTH, Origin: "https://evil.example" });
  ok("an unlisted origin is not",
     other.headers.get("access-control-allow-origin") === "null",
     other.headers.get("access-control-allow-origin"));

  const pre = await handler(new Request("https://proj.supabase.co/functions/v1/off", {
    method: "OPTIONS", headers: { Origin: "https://example.github.io" },
  }));
  ok("the preflight doesn't need a sign-in", pre.status === 200, String(pre.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
