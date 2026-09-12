# offproxy

A ~600-line Go service that sits between Tally and Open Food Facts.

No dependencies — standard library only. Builds to one static binary.

## Why it exists

Open Food Facts asks every client to identify itself with a custom
`User-Agent` in the form `AppName/Version (ContactEmail)`, and documents read
limits of 15 req/min/IP for products and 10 req/min/IP for search.

A browser **cannot** set `User-Agent` — it's a forbidden header. So a browser
app is structurally incapable of being a well-behaved OFF client, which is
almost certainly why their search endpoints turn away anonymous traffic and
send no CORS headers to third-party origins. Their *product* endpoint has no
such restriction, which is why Tally can scan barcodes without any of this.

This service fixes the cause rather than working around it:

- **Identifies properly.** It refuses to start without `OFFPROXY_UA`.
- **Stays inside the published limits.** Token buckets at 10/min for search
  and 15/min for products. When the budget is spent it returns 503 with
  `Retry-After` rather than hammering upstream.
- **Caches.** Search results 6 h, products 7 days. Most lookups never leave
  your server, which is the single biggest thing you can do to be a good
  citizen of a free community API.
- **Re-ranks.** Upstream relevance is poor — searching "hovis wholemeal bread"
  returns Mission wraps and French pâte feuilletée above the actual Hovis loaf.
  This asks for a wide page, discards anything with no calorie data, scores by
  how much of your query matched, and boosts UK products.
- **Serves CORS you control**, so the browser can actually call it.

## Build

```bash
cd server
go test ./...
go build -ldflags="-s -w" -o offproxy .
```

Cross-compiling from your laptop to the server:

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o offproxy .
scp offproxy your-server:/usr/local/bin/
```

## Configuration

All via environment variables. The two without defaults are required.

| Variable | Default | Notes |
|---|---|---|
| `OFFPROXY_UA` | — **required** | `Tally/1.1 (you@example.com)`. Use a real address; it's how OFF contacts you if your client misbehaves. |
| `OFFPROXY_ORIGINS` | — **required** | Comma-separated origins allowed to call it, or `*`. e.g. `https://you.github.io` |
| `OFFPROXY_ADDR` | `127.0.0.1:8080` | Bind address. Keep it on loopback and put Caddy in front. |
| `OFFPROXY_SEARCH_TTL` | `6h` | Search cache lifetime. |
| `OFFPROXY_PRODUCT_TTL` | `168h` | Product cache lifetime. Nutrition data changes rarely. |
| `OFFPROXY_MAX_RESULTS` | `25` | Cap on results returned. |
| `OFFPROXY_DATA` | unset | Directory for diary storage. Unset = sync off. |
| `OFFPROXY_ACCOUNTS` | unset | `name:token,name:token`. Tokens must be ≥16 chars; use `-gen-token`. |

## Diary sync (optional)

Set `OFFPROXY_DATA` and `OFFPROXY_ACCOUNTS` and offproxy also syncs diaries
across devices, for one person or several. Leave both unset and it stays the
stateless search service described above.

```bash
offproxy -gen-token    # run once per person
```

```
OFFPROXY_DATA=/var/lib/offproxy
OFFPROXY_ACCOUNTS=mark:3f9a…,claire:b71c…
```

**Each diary is private to its token.** The account is derived from the token
alone — a client never gets to say who it is — so one person's device cannot
request another's diary however it asks. There are tests for exactly that.

**The food library is shared** across everyone on the server, deliberately:
create "Mum's lasagne" once and the whole household can log it.

Two configuration mistakes are refused at startup rather than becoming a
silent data-exposure problem later: setting one of the two variables without
the other, and combining accounts with `OFFPROXY_ORIGINS=*` (wildcard CORS
plus bearer tokens would let any site on the internet use a leaked token).

### How merging works

Nothing is ever replaced wholesale. Days, weights, settings and foods each
carry their own timestamp, and the newer one wins item by item. So a phone
that has been in a drawer for a week uploads its own days without wiping the
ones you made on the laptop meanwhile. Deleting a shared food writes a
tombstone rather than just removing it, so a stale device can't resurrect it.

The limit worth knowing: resolution is **per day**, not per entry. If you edit
the *same day* on two devices while one is offline, the later edit wins that
day outright and the other device's changes to it are lost. In practice you're
rarely logging the same day on two devices at once, and finer-grained merging
would cost a lot of complexity for a rare case.

## Endpoints

```
GET  /health
GET  /api/search?q=hovis+wholemeal&limit=20   -> {"foods":[Food,...]}
GET  /api/product/5000157024671                -> {"food":Food}

# sync — all require  Authorization: Bearer <token>
GET  /api/whoami                               -> {"account":"mark"}
GET  /api/diary                                -> {"account":…,"diary":…}
POST /api/diary                                -> merge, then return the merged diary
GET  /api/foods                                -> {"foods":{…}}     (shared)
POST /api/foods                                -> merge, then return the merged library
```

`Food` is exactly the shape the Tally client already uses, so the browser
drops the response straight into its UI with no transformation.

Errors are JSON: `{"error":{"code":"RATE_LIMITED","message":"..."}}`, with
`404 NOT_FOUND` for an unknown barcode and `422 NO_NUTRITION` for a product
that exists but carries no nutrition data. The client distinguishes all of
these and says something useful for each.

Responses carry `X-Cache: hit|miss` if you want to see the cache working.

## Deploying

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin offproxy
sudo cp offproxy /usr/local/bin/
sudo cp offproxy.service /etc/systemd/system/
sudo systemctl edit --full offproxy   # set your UA, origins, and sync if wanted
sudo systemctl enable --now offproxy
curl -s localhost:8080/health
```

The unit sets `StateDirectory=offproxy`, which creates `/var/lib/offproxy`
owned by the service and makes it writable despite the `ProtectSystem=strict`
hardening. Without that line, sync writes fail with a permission error that
looks like an application bug — so don't remove it if you move the data
directory; point `StateDirectory` at the new location instead.

`Caddyfile.example` shows serving the app and the API from the same domain,
which is the tidiest arrangement: same origin means CORS stops mattering at
all, and you still set the app's server URL to that domain.

## Where to host it

offproxy needs almost nothing — a 6 MB static binary, capped at 256 MB in the
unit file — so the constraint is rarely resources. Two things that are easy to
get wrong:

**Free tiers that reclaim idle instances.** Oracle Cloud's Always Free is the
obvious candidate on price, but Oracle reclaims Always Free compute if, over a
7-day window, CPU (95th percentile) is under 20%, network is under 20%, and —
on ARM shapes — memory is under 20%. A service answering a handful of sync
requests a day is idle by that definition, so it is a poor fit *specifically
because* it is efficient. Upgrading the account to Pay As You Go is the usual
way round it (Always Free resources still cost nothing), but that puts a card
on file. Check the current policy before relying on either.

**Oracle's two firewalls.** If you do use Oracle, opening a port in the VCN
security list is only half the job — their images also ship iptables/nftables
rules that block it independently. Ports 80 and 443 have to be opened in both,
and forgetting the instance-level one is the classic "the security list says
it's open but nothing connects" afternoon.

A low-power machine at home is often the better answer: no reclamation policy,
no capacity queue, and Cloudflare Tunnel gives it a public HTTPS hostname with
no port forwarding and no dynamic DNS.

Remember to match the build to the CPU — `GOARCH=arm64` for Ampere or a
Raspberry Pi, `GOARCH=amd64` for x86. A binary for the wrong one fails with
"cannot execute binary file", which reads like a corrupt download.

## Worked example: a spare laptop + Tailscale Funnel

The cheapest reliable host is usually hardware you already own. This is the
whole path, using a Surface Pro 7 as the example.

### 1. Linux on the machine

- **Disable Secure Boot first.** Power off, hold **Volume Up** and press power
  to enter UEFI, then Security → Secure Boot → Disabled, and put USB above the
  internal disk in the boot order. Surface firmware will not boot the installer
  otherwise.
- **Have a USB keyboard to hand.** The Type Cover may not be recognised by a
  stock installer kernel, and discovering that at the partitioning screen is
  miserable. A USB-C hub with a cheap keyboard is enough.
- Ubuntu Server LTS or Debian stable is the sane choice — no desktop, long
  support, Caddy and Tailscale both packaged.
- Only reach for [linux-surface](https://github.com/linux-surface/linux-surface)
  if hardware actually misbehaves. Headless, you need Wi-Fi and power
  management, and mainline handles both on this generation.

### 2. Stop it sleeping — the step everyone forgets

A laptop lid-down suspends, and a suspended server is an offline server.

```bash
sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/;
             s/^#*HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/;
             s/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' \
  /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

**The battery is the real cost.** Held at 100% permanently it will swell over
a year or two, and in a tablet that can crack the screen from the inside.
Surface hardware doesn't expose a reliable charge limit under Linux, so this
is a risk to accept knowingly rather than one to engineer away. Check on it
occasionally; if it starts to bulge, stop using the machine.

### 3. offproxy

Build on your usual machine and copy it over — the Surface is x86, so the
normal amd64 build is right:

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o offproxy .
scp offproxy offproxy.service surface:/tmp/
```

Install exactly as in *Deploying* above, leaving `OFFPROXY_ADDR` on
`127.0.0.1:8080`. Nothing needs to listen publicly.

### 4. Tailscale Funnel instead of Caddy

Funnel terminates TLS and proxies to your local port, so there is no
certificate to obtain, no port to forward and no dynamic DNS.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale funnel --bg 8080
tailscale funnel status
```

In the Tailscale admin console, **MagicDNS and HTTPS certificates both have to
be enabled** for the tailnet, or Funnel has no name to issue a certificate for.

You get `https://<device>.<tailnet>.ts.net`. Put that in `OFFPROXY_ORIGINS`'
neighbour — the app's **More → Food search** box — and set `OFFPROXY_ORIGINS`
to wherever the app itself is served from (your GitHub Pages origin).

Funnel is public, which is the point: neither phone needs the Tailscale app,
and it works on mobile data. The diaries are guarded by the bearer tokens and
the CORS origin list rather than by network position. If you would rather it
stay private, `tailscale serve` instead of `funnel` keeps it inside the
tailnet — at the cost of running the Tailscale app on every phone.

### 5. Back it up

Both diaries now live on one laptop in your house. `/var/lib/offproxy` is a
few kilobytes of JSON; rsync or Borg it somewhere else on a timer.

## A note on being a good neighbour

Open Food Facts is a volunteer project giving away data for free. The caching
and rate limiting here aren't ceremony — a badly behaved client is how free
APIs end up closed, which is exactly the wall we hit with their search
endpoint in the first place. If you fork this, keep them.

If your usage ever grows past what this makes sense for, the honest answer is
to stop querying their API and use one of the
[full data exports](https://world.openfoodfacts.org/data) instead.
