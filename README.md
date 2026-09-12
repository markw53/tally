# Tally

A MyFitnessPal-shaped food and calorie diary. Barcode scanning, no subscription,
no account, no analytics. Everything is stored in your browser; nothing is sent
anywhere except the food lookups you ask for.

Installs to the home screen on iOS and Android as a normal-looking app.

---

## What's in the box

```
index.html            markup
styles.css            all styling, light + dark
foods.js              121 everyday foods with portion sizes (a slice, half a tin)
foods-uk.js           2,854 UK reference foods from McCance & Widdowson
app.js                everything else
sw.js                 service worker (offline shell)
manifest.json         makes it installable
icons/                app icons
.nojekyll             stops GitHub Pages running the files through Jekyll
server/               optional Open Food Facts search service (Go)
tools/                regenerate foods-uk.js from the published CoFID spreadsheet
test/run.js           96 headless tests
```

Every path in the project is relative, so it works served from a domain root
*or* from a subpath like `user.github.io/tally/` with no changes.

No build step, no dependencies, no npm install. It's static files.

## Features

- **Barcode scanning** — Open Food Facts, ~4 million products, strong UK coverage.
  Uses the browser's native `BarcodeDetector` on Android (instant, no download)
  and falls back to ZXing on iOS.
- **Portion handling that isn't annoying** — a scanned product offers its own
  serving size, the whole pack, 100 g, or free grams, with 0.5×/2×/3× shortcuts.
- **~2,900 UK foods built in** — the whole of McCance & Widdowson's Composition
  of Foods, the UK's authoritative reference data, searchable instantly with no
  network, no API key and no rate limit.
- **Real portion sizes** on the everyday items — a slice of bread, a medium
  banana, half a tin — which the reference data itself doesn't carry.
- **Typed search needs nothing.** Optionally add your own Open Food Facts search
  server (see `server/`) for branded products, or a USDA key for American foods.
- **Quick add** for when you only know the calorie figure.
- **Recents and frequents**, so a repeat food is two taps.
- **Custom foods** for anything with no barcode.
- **Goal + macro targets**, with a Mifflin–St Jeor calculator if you want one.
- **14-day trend chart**, weight log, JSON export/import.
- **Works offline** once installed — scanned products are cached, so re-scanning
  something you've had before works with no signal.
- **Optional sync and multiple people** — separate private diaries, a shared
  food library, and a switcher for devices two people both use.

---

## 1. Put it online

The camera only works over HTTPS, so it has to be hosted somewhere. It's static
files, so this is free and takes a couple of minutes. Pick one:

### Netlify Drop — fastest, no account needed to try
1. Go to <https://app.netlify.com/drop>
2. Drag the whole `tally` folder onto the page.
3. You get an HTTPS URL immediately. Create a free account to keep it permanently
   and give it a nicer name.

### GitHub Pages — free, permanent, version-controlled
```bash
cd tally
git init -b main
git add -A && git commit -m "Tally"
gh repo create tally --public --source=. --push
```
Then **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
Live at `https://<you>.github.io/tally/` after a minute or so.

The repo has to be **public** — Pages on a private repo needs a paid plan.
To update later: edit, commit, push. Pages redeploys in about half a minute.

### Cloudflare Pages
`npx wrangler pages deploy .` — free tier, fast CDN, custom domains.

### Your own Hetzner box
It's a static site, so any web server will do. With Caddy the whole config is:
```
tally.example.com {
    root * /srv/tally
    file_server
}
```
Caddy gets the TLS certificate itself, which is all the camera needs.

### Updating an installed copy

The service worker serves the cached app shell first and refreshes in the
background, so after you push a change the phone picks it up on the *next*
launch, not the current one. If you want it immediately, bump the version
string at the top of `sw.js`:

```js
const CACHE = "tally-v1.3.1";   // any change to this forces a full refresh
```

### One thing to know before you pick

An installed web app is tied to its origin. Moving from
`user.github.io/tally/` to `tally.yourdomain.com` later means a fresh install
and an empty diary — so export your data first and import it on the new one.
If you think you'll want your own domain eventually, it's less faff to start
there.

## 2. Install it on your phone

**iOS** — open the URL **in Safari** (this bit matters; other iOS browsers make a
bookmark rather than a real web app). Share button → **Add to Home Screen**.
Launch it from the icon and it runs full-screen with no browser chrome. The first
scan will ask for camera permission.

**Android** — open in Chrome, then menu → **Install app** (or *Add to home screen*).
Same result, and Android additionally supports the "Scan a barcode" long-press
shortcut on the icon.

## 3. Two minutes of setup

1. **More → Daily goal** — set your calorie target and macro split. There's a
   Mifflin–St Jeor calculator underneath if you'd rather work one out.
That's it. Typed search and barcode scanning both work with no keys and no
accounts. **More → Food search** is there if you later want branded-product
search (your own server) or American foods (a free USDA key) — neither is needed.

---

## Where the data comes from

| Source | Used for | Key needed | Notes |
|---|---|---|---|
| `foods-uk.js` — [CoFID](https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid) | typed search | no | 2,854 UK foods, offline, Open Government Licence v3.0 |
| `foods.js` | the everyday items | no | portion sizes on top of CoFID values |
| [Open Food Facts](https://world.openfoodfacts.org) | barcode lookups | no | branded products, ODbL licensed |
| Open Food Facts via `server/` | branded typed search | no | optional; needs offproxy running |
| [USDA FoodData Central](https://fdc.nal.usda.gov) | American generic foods | free, optional | only if you paste a key in |

### Where the numbers come from

Nutrition values are **McCance & Widdowson's The Composition of Foods Integrated
Dataset (CoFID 2021)**, published by Public Health England — the same data
behind UK food labelling and the National Diet and Nutrition Survey. The
everyday-foods list adds portion sizes on top; its values are taken from CoFID
too wherever a clean equivalent exists (`tools/portion-map.json`), so the app
gives one answer per food rather than two.

This matters more than it sounds. UK and US figures differ: wholemeal bread is
217 kcal/100 g here against USDA's 247, a banana 81 against 89, chicken breast
148 against 165. On staples logged daily that adds up.

To regenerate after a new CoFID release:

```bash
python3 tools/build-cofid.py CoFID.xlsx > foods-uk.js
node tools/apply-cofid-values.js
```

Contains public sector information licensed under the
[Open Government Licence v3.0](http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

**Why typed search doesn't hit Open Food Facts directly.** OFF asks every client
to identify itself with a custom `User-Agent`, and browsers are forbidden from
setting that header. Their search endpoints accordingly turn away anonymous
traffic and send no CORS headers to third-party origins — `cgi/search.pl`
answers "not available to anonymous users", and neither `search.openfoodfacts.org`
nor `/api/v2/search` will talk to a web page. Their *barcode* endpoint has no
such restriction, which is why scanning works directly and typed search doesn't.

## Optional: your own search server

`server/` contains **offproxy** — a small dependency-free Go service that fixes
the cause rather than working around it. It identifies itself properly, stays
inside OFF's published rate limits, caches aggressively, and re-ranks results
(upstream puts Mission wraps above the actual loaf when you search for Hovis).

Run it and typed search comes from Open Food Facts itself, with better UK
coverage than USDA and no API key anywhere. Barcode lookups route through it
too, picking up the shared cache.

```bash
cd server && go test ./... && go build -o offproxy .
```

Then set the address in the app under **More → Food search**. See
[`server/README.md`](server/README.md) for deployment, a hardened systemd unit,
and a Caddyfile that serves the app and the API from one domain.

Leave the server field empty and nothing changes — USDA handles typed search
exactly as before.

## More than one person

Tally handles a household. Each person gets their own diary, and the two
things that differ are handled separately:

- **Diaries are private.** Each account's diary is reachable only with that
  account's own sync token. The server derives who you are from the token —
  a client never gets to claim an identity — so one person's device cannot
  fetch the other's diary however it asks.
- **Custom foods are shared.** Create "Mum's lasagne, 180 kcal per 100 g"
  once and everyone on your server can log it. That's the point.

On a shared device (an iPad, a family laptop) add each person under
**More → Who uses this device**. Whoever is currently logging is shown in a
band across the top of every screen, and tapping it switches. That band is
deliberately hard to miss — logging your lunch into someone else's diary is
the one mistake worth designing against.

Each person needs a sync token from `OFFPROXY_ACCOUNTS` pasted into
**More → Sync**. Without a token a profile simply stays on that device.

Sync merges rather than overwrites, per day: a phone that's been offline for a
week uploads its days without wiping newer ones from the laptop. The limit is
that resolution is per *day* — edit the same day on two devices while one is
offline and the later edit wins that day outright. See
[`server/README.md`](server/README.md) for the details.

## Your data

Everything lives in this browser's `localStorage`, under `tally.v1.<profile>`.

- Nothing leaves the device unless you configure a sync server of your own.
- Clearing site data, or switching phone, loses the local copy.
- **More → Your data → Export JSON** takes a backup. Worth doing occasionally.
- Import restores a backup on any device.
- Upgrading from a single-diary version migrates your existing diary into the
  first profile automatically, and leaves the old storage key untouched as a
  safety net.

Built-in food values are typical figures for generic foods, not any specific
brand. For anything packaged, scanning the barcode will always be more accurate.

## Running the tests

```bash
python3 -m http.server 8765     # in this folder
node test/run.js                # needs playwright
```

96 tests covering portion arithmetic, the diary, editing, undo, persistence,
the barcode path, and the layout.

---

## If you later want a real App Store / Play Store build

The PWA is genuinely all most people need, and it dodges the £79/year Apple
Developer fee — which would cost you roughly what MyFitnessPal does. But if you
want a store listing, [Capacitor](https://capacitorjs.com) wraps these exact
files with no rewrite:

```bash
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/camera
npx cap init Tally com.yourname.tally --web-dir=.
npx cap add android      # needs Android Studio
npx cap add ios          # needs a Mac + Xcode
npx cap run android
```

Android you can build and sideload today for nothing. iOS needs a Mac, and
sideloading a self-signed build means re-signing every 7 days unless you pay for
the developer programme. Worth knowing before you start down that path.

---

Product data © Open Food Facts contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
