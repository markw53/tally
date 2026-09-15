# Tally on Supabase

Sync for two people with nothing of your own left running, for £0.

This is the alternative to `server/` (offproxy). Same app, same features — the
difference is where the diary lives and what you have to keep alive:

| | GitHub Pages only | **Supabase** | offproxy on your own box |
|---|---|---|---|
| Cost | £0 | £0 | the box |
| Sync between devices | no | yes | yes |
| Two separate diaries | no | yes | yes |
| Branded typed search | no | yes | yes |
| Active energy from your watch | no | yes | yes |
| Something you have to keep running | no | no | yes |
| Fails if you stop looking after it | no | pauses after 7 idle days | yes |

Barcode scanning works in all three — it goes straight to Open Food Facts.

---

## What you get

- **Real accounts.** You and Claire sign in with an email and password instead
  of pasting a token.
- **Privacy enforced by Postgres, not by my code.** Row-level security means
  the database itself refuses to return one person's diary to the other. With
  offproxy that promise held because the Go code was correct; here it holds
  because the query returns nothing.
- **Better merging.** Each day is its own row, so two devices editing
  *different* days can no longer lose one of them. Offproxy merged whole
  documents; this doesn't.
- **A shared food library**, same as before. Create "Mum's lasagne" once.

---

## Setting it up

About ten minutes. You need the [Supabase CLI](https://supabase.com/docs/guides/cli)
for the last step; everything else is the web dashboard.

### 1. Make a project

[database.new](https://database.new). Any region near you — London is `eu-west-2`.
Save the database password somewhere; you won't need it for this, but you'll
want it if you ever do.

### 2. Create the tables

Dashboard → **SQL Editor** → **New query**. Paste the whole of
[`schema.sql`](schema.sql) and run it. It's idempotent, so re-running it after
an upgrade is safe.

### 3. Make your two accounts

Dashboard → **Authentication** → **Users** → **Add user** → *Create new user*.
Do it twice, once for each of you. Use real email addresses and pick passwords
properly — these are the keys to the diaries.

### 4. Turn sign-ups off

> **This is the one step you mustn't skip.**

Dashboard → **Authentication** → **Sign In / Providers** → Email → turn
**Allow new users to sign up** off.

The app ships with the project's anon key in it, which is by design — it's a
public identifier, not a secret. But while sign-ups are open, anyone who finds
that key can create themselves an account, and a signed-in stranger can read
and write the *shared food library* (not your diary — that's still locked to
its owner). With sign-ups off, the only accounts that exist are the ones you
made in step 3.

### 5. Deploy the two functions

```bash
cd supabase
supabase login
supabase link --project-ref <your project ref>

# Open Food Facts wants a contact address, and will block an anonymous
# scraper rather than just rate-limiting it. Use a real one.
supabase secrets set OFF_USER_AGENT="Tally/1.5 (you@example.com)"

# Where the app is served from, so the browser is allowed to call the function.
supabase secrets set ALLOWED_ORIGINS="https://<you>.github.io"

supabase functions deploy off
supabase functions deploy activity
```

`config.toml` sets `verify_jwt` correctly for each: `off` requires a signed-in
caller, `activity` doesn't (see below for why).

### 6. Point the app at it

In Tally: **More → Supabase**. Paste the **Project URL** and the **anon key**,
both from Dashboard → **Project Settings** → **API**. Save, then sign in under
**More → Sync**.

Claire does the same on her phone with her own email and password. Same project,
separate diaries.

---

## Active energy from Apple Health

Same as the offproxy version, different endpoint. The figure is *shown* and
never added to your calorie goal — the reasoning is in
[`../server/README.md`](../server/README.md#why-it-isnt-added-to-your-calorie-goal),
and it hasn't changed.

### Get a device key

**More → Sync → Issue a device key**. It's shown once and stored only as a
SHA-256 hash, so if you lose it you issue another rather than recovering it.

A key rather than your password because a Shortcut runs unattended at 11pm and
has nowhere to keep a refreshable session. It can only post active energy — it
can't read your diary or change anything else.

### Build the Shortcut

On the iPhone, Shortcuts → **+**:

1. **Find Health Samples** — Type: *Active Energy*, Sort by *Start Date*,
   Limit off, Date range: *Today*.
2. **Calculate Statistics** — *Sum* of *Value* over the samples above.
3. **Format Date** — *Current Date*, Custom format `yyyy-MM-dd`.
4. **Text** — exactly this, with the two magic variables from steps 3 and 2:
   ```
   {"date":"[Formatted Date]","kcal":[Statistic]}
   ```
5. **Get Contents of URL**
   - URL: `https://<your project>.supabase.co/functions/v1/activity`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer tk_…your device key…`
     and `Content-Type` = `application/json`
   - Request Body: **File** → the Text from step 4

Then Automation → **+** → Time of Day → 11:00pm → Run Immediately, no
notification. Adding a second one on *When iPhone is Unlocked* keeps the
current day roughly live if you like watching it move.

Check it before trusting it:

```bash
curl -X POST https://<your project>.supabase.co/functions/v1/activity \
  -H "Authorization: Bearer tk_..." \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-09-15","kcal":612}'
# {"ok":true,"date":"2026-09-15","kcal":612}
```

Two details that matter:

- **The date comes from the phone.** The function runs on UTC and doesn't know
  where your day boundary is. A 23:30 post from the UK in summer would
  otherwise land on tomorrow.
- **`kcal` is accepted as a string or a number**, because Shortcuts formats
  numbers unpredictably depending on which block produced them, and failing at
  11pm when nobody is watching is the worst time to be strict.

---

## The free tier, honestly

The limits are generous for this: 500 MB of database against a diary measured
in kilobytes, 50,000 monthly active users against two, 500,000 function calls
against maybe a hundred a day.

**The one real catch is pausing.** A free project with no activity for 7 days
gets paused, and you restore it by hand from the dashboard. Nothing is lost —
it comes back exactly as it was, and the window to restore is a year.

For a food diary you open daily this never triggers. It would if you both
stopped logging for a fortnight's holiday, and the thing you'd notice on
getting back is the app saying it can't reach Supabase while the diary carries
on working locally — because it does. Entries queue up on the device and sync
when the project is back.

Two other things worth knowing before you commit:

- **Moving off later means exporting.** More → Your data → Export JSON, and
  import it wherever you land. The same is true of every option here.
- **The anon key is public.** That's how Supabase is designed — security comes
  from row-level policies, which is why step 4 matters so much. Don't let the
  word "key" make you cautious about the wrong thing: the anon key in your
  GitHub repo is fine, sign-ups left open is not.

---

## Testing it

The schema tests run against a throwaway local Postgres — no project, no
network, nothing touched:

```bash
./supabase/test/run.sh
```

They assert what the design rests on: that newest-wins merging actually merges,
that Claire cannot read, write or delete Mark's diary by any route including
aiming directly at his rows, that a stale device can't resurrect a deleted food,
and that a syncing client cannot touch watch data.

The edge function's pure half — converting an Open Food Facts product, and the
re-ranking that puts the actual Hovis loaf above Mission wraps — has its own:

```bash
node --experimental-strip-types supabase/test/food.test.mjs
```

---

## What's in here

```
schema.sql              tables, row-level security, and the merge functions
config.toml             which function needs a JWT and which doesn't
functions/off/          Open Food Facts search + barcode, with a proper User-Agent
functions/off/food.ts   the pure conversion and ranking, split out to be testable
functions/activity/     the Apple Health endpoint, device-key authenticated
test/                   schema tests against a local Postgres, plus the above
```

## If something's wrong

| What you see | What it usually is |
|---|---|
| "That project doesn't have Tally's tables yet" | step 2 wasn't run, or was run on a different project |
| Sign-in rejected | the account doesn't exist — create it in Authentication → Users |
| "The `off` function isn't deployed" | `supabase functions deploy off` |
| "no contact address set" | `OFF_USER_AGENT` secret missing |
| Search works, the browser console shows CORS | `ALLOWED_ORIGINS` doesn't match where the app is served from |
| Everything stops after a break | the project paused — dashboard → Resume |
| The Shortcut posts but nothing appears | check the date it sent; it should be *your* today |
