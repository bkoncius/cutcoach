# CutCoach — training & nutrition ledger with an AI coach

Next.js (Vercel) + Supabase (Postgres, Auth) + Anthropic API (server-side proxy).
Features: daily weigh-ins with 7-day average, meal logging with AI photo/text macro
estimation (HEIC supported), the 4-day training program with per-set logging and
previous-session prefill, cut/maintain/bulk phases, trend charts, and an AI coach
that reads your real data for daily check-ins.

Installable PWA with an offline shell and **condition-aware push reminders** — they
only fire when something is actually outstanding, and never nag about a weigh-in or
check-in you've already done.

## Launch checklist (~15 minutes)

### 1. Supabase project
1. Go to https://supabase.com → New project (pick the EU region, e.g. Frankfurt).
2. In the dashboard: **SQL Editor → New query** → paste the entire contents of
   `supabase/schema.sql` → **Run**. This creates all tables with row-level security.
3. Same again with `supabase/002_push.sql` (notification tables + profile columns).
   That one is safe to re-run; `schema.sql` is not.
4. **Authentication → Providers → Email**: make sure Email is enabled.
   Optional for solo use: turn OFF "Confirm email" so sign-up works instantly.
5. **Project Settings → API**: copy the **Project URL**, the **anon public** key, and
   the **service_role** key (that last one is server-only — see Security model).

### 2. Anthropic API key
1. https://console.anthropic.com → API Keys → Create key. Copy it (starts `sk-ant-`).
2. Add a few euros of credit. Typical usage here (a daily check-in + a few photo
   estimates) costs cents per day.

### 3. VAPID keys (for push)
```bash
npx web-push generate-vapid-keys
```
Keep both halves. **These are permanent** — rotating the private key rejects every
existing subscription with a 403, there is no migration path, and every device has to
resubscribe. Generate once, store in a password manager.

### 4. Deploy to Vercel
Recommended path — GitHub + Vercel:
1. Push this folder to a new GitHub repo (private is fine).
2. https://vercel.com → Add New → Project → import the repo. Framework is
   auto-detected (Next.js).
3. Before deploying, add **Environment Variables** (all environments) — see
   `.env.example` for the full annotated list:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from step 1.5
   - `SUPABASE_SERVICE_ROLE_KEY` — from step 1.5. **Never** prefix it `NEXT_PUBLIC_`.
   - `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` — from step 2
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — from step 3
   - `VAPID_SUBJECT` — `mailto:you@example.com`
   - `CRON_SECRET` — any 16+ random chars
4. Deploy. You'll get `https://your-app.vercel.app`.

CLI alternative: `npm i -g vercel && vercel` from this folder, add the same env
vars when prompted (or via `vercel env add`), then `vercel --prod`.

### 5. Finish auth wiring
Back in Supabase: **Authentication → URL Configuration** → set **Site URL** to your
Vercel URL. (Only strictly needed if email confirmation/magic links are on.)

### 6. Turn off Vercel Authentication for production
**Vercel → project → Settings → Deployment Protection → Vercel Authentication →
"Only Preview Deployments"** (or Disabled).

Not optional, and it fails silently if you skip it. With it on, *every* request to the
production URL — including the cron's — answers `302 → vercel.com/sso-api` instead of
reaching the app. `pg_net` doesn't report that, so `pg_cron` logs a successful run every
5 minutes while nothing happens, forever. It also makes the PWA unusable on a phone: an
installed app behind Vercel SSO bounces to a vercel.com login on launch.

Nothing is lost by turning it off. Supabase RLS plus the JWT check on `/api/ai` are the
actual guard, and `/api/cron/dispatch` requires `CRON_SECRET`. (If you must keep it on,
`supabase/003_cron.local.sql` has a Protection-Bypass-header variant at the bottom.)

Confirm it's off — this should return your app's HTML, not a redirect:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-APP.vercel.app/   # want 200, not 302
```

### 7. Schedule the reminders
Run `supabase/003_cron.local.sql` in the SQL Editor — it's pre-filled with your domain
and secret. (`003_cron.sql` is the committed template with placeholders; the `.local`
copy is gitignored so the real secret never enters git.) It enables `pg_cron` + `pg_net`
and polls `/api/cron/dispatch` every 5 minutes.

**Run it last** — after the code is deployed and `CRON_SECRET` is set in Vercel.
Scheduling against a route that doesn't exist yet looks identical to success.

Vercel Cron is deliberately **not** used: on the Hobby plan cron is capped at once per
day with ±59 min precision, and a sub-daily expression fails at *deploy* time. Since
cron runs in UTC and one job serves every user, per-user local-time reminders need a
finer tick than Hobby allows. The endpoint is scheduler-agnostic — both callers send
the same `Authorization: Bearer` header — so moving to Vercel Pro later is a
`vercel.json` block plus `cron.unschedule()`, with no code change.

### 8. Use it
Open the Vercel URL on your phone → Sign up → Share → **Add to Home Screen**.
Then open it **from the home screen** and turn on reminders in Settings (gear icon) →
Reminders → Enable → Send test notification.

> On iOS, push only works from an installed home-screen app — never a Safari tab —
> and the permission prompt must come from a real tap. A denial is permanent and only
> reversible in iOS Settings, so the app never auto-prompts.

## Local development
```bash
npm install
cp .env.example .env.local   # fill in your values
npm run dev                  # http://localhost:3000
```

The service worker is **gated to production builds** — it fights HMR under `next dev`.
To exercise the PWA and push locally:
```bash
npm run build && npm run start
```
`localhost` counts as a secure context, so the SW, the permission prompt, and real push
delivery all work without HTTPS or a tunnel. Only the inbound cron trigger can't reach
localhost — call it yourself:
```bash
# Set ALLOW_CRON_DEBUG=1 in .env.local first, or these params are ignored
# and the endpoint sends for real.
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/dispatch?dry=1&now=2026-07-16T07:30:00Z"
```
`?dry=1` plans the sends and delivers nothing; `?now=` pretends it's a given instant, so
you can exercise every branch without waiting until 07:30. Both are gated on
`ALLOW_CRON_DEBUG=1` — leave it unset on Vercel and they're inert there.

Icons are committed. Only re-run this after editing `assets/*.svg`:
```bash
npm run icons
```

## Security model
- **Row Level Security** on every table: `auth.uid() = user_id`. Even with the
  public anon key, users can only ever read/write their own rows.
- The `NEXT_PUBLIC_*` values are public by design (that's how Supabase works);
  RLS is the actual guard.
- `ANTHROPIC_API_KEY` lives **only on the server**. The browser calls `/api/ai`,
  which verifies the caller's Supabase JWT before forwarding to Anthropic — so
  nobody can burn your credits without an account in your app.
- `SUPABASE_SERVICE_ROLE_KEY` **bypasses RLS entirely** — it can read and write every
  user's data. The cron dispatcher needs it to check whose weigh-in is outstanding.
  It is server-only, and `lib/supabaseAdmin.js` imports `server-only` so that a client
  component importing it fails the **build** instead of quietly shipping the key to
  every browser. Never prefix it `NEXT_PUBLIC_`.
- The service worker never caches cross-origin responses. That's a one-line origin
  check in `public/sw.js`, and it's load-bearing: caching Supabase replies would leave
  a previous user's ledger and auth tokens in CacheStorage after sign-out.
- `notification_log` has no insert policy at all, so a client can't forge a dedupe row
  to suppress its own reminders.
- Sign-ups are open by default. For a strictly personal app, create your account,
  then in Supabase disable new sign-ups (Authentication → Providers → Email →
  "Allow new users to sign up" off).

## Structure
```
app/page.js                  auth gate → app
app/layout.js                metadata, PWA meta tags, SW registration
app/manifest.js              → /manifest.webmanifest
app/api/ai/route.js          Anthropic proxy (JWT-checked, key server-side)
app/api/push/*               subscribe / unsubscribe / test
app/api/cron/dispatch        the reminder scheduler endpoint
components/CutCoachApp.jsx   the whole app UI
components/NotificationSettings.jsx  reminders card + diagnostics panel
components/ServiceWorkerRegistrar.jsx  registration + "Update ready" pill
components/ui.jsx            shared Card / Eyebrow / Bar
components/Auth.jsx          sign in / sign up
public/sw.js                 service worker (offline shell + push handlers)
lib/supabaseClient.js        lazy Supabase client (browser)
lib/supabaseAdmin.js         service-role client (server-only)
lib/serverAuth.js            requireUser / requireCron
lib/api.js                   askClaude → /api/ai
lib/db.js                    reads/writes for all tables
lib/ledgerCache.js           localStorage snapshot for offline + instant boot
lib/push.js                  web-push sender, prunes dead subscriptions
lib/pushClient.js            browser subscription lifecycle
lib/reminders.js             reminder catalog — shared by the UI and the dispatcher
lib/program.js               the 4-day program — shared by the UI and the dispatcher
assets/*.svg                 icon sources (npm run icons)
supabase/schema.sql          tables + RLS (run once)
supabase/002_push.sql        push tables + profile columns (re-runnable)
supabase/003_cron.sql        pg_cron schedule (edit placeholders first)
```

## How reminders work
`lib/reminders.js` is the single source of truth — the settings UI and the cron
dispatcher both import it, so the two can't drift. Each reminder owns its skip
condition and its copy in one function.

Every 5 minutes the dispatcher converts "now" into each user's local wall clock
(`Intl`, no dependency), fires anything whose time fell in the last 30 minutes, checks
the condition, and skips if it's already been done. The wide window is deliberate:
scheduled runs get missed and duplicated in practice, and a unique index on
`(user_id, reminder_id, local_date)` does the only-once work — dispatch claims that row
*before* sending, so a duplicate run is harmless with no locking.

| id | fires | skipped when |
|---|---|---|
| `weigh_in` | 07:30, **on** | a weight is logged for today |
| `protein` | 15:00, off | you're past half your protein target |
| `train` | 17:30, off | trained today, or the gap is under 2 days |
| `checkin` | 20:30, **on** | you've already checked in with the coach |

The training nudge is **gap-based, not weekday-based**: the program is a rotating
sequence with no fixed schedule, so the rotation answers *what* to train and the gap
answers *when* to nudge. It targets drift, not a missed Tuesday.

Reminders are stored per-user in `profiles.reminders` and default to `{}` — the
dispatcher requires an explicit `enabled: true`, so nothing ever fires until you open
the Reminders card and save.

## Adjusting later
- Coach behavior/rules: `buildContext()` in `components/CutCoachApp.jsx`.
- Training program: `lib/program.js` (shared with the notification copy).
- Reminder times, copy, and conditions: `lib/reminders.js`.
- Model or spend: `ANTHROPIC_MODEL` env var; `max_tokens` cap in `app/api/ai/route.js`.
- Icon artwork: `assets/*.svg`, then `npm run icons`.

## Troubleshooting push
The Reminders card has a **Diagnostics** disclosure showing permission state, whether
you're running standalone, whether the SW is controlling, the subscription endpoint,
and the last test result. On iOS that panel is the only debugger you get — Safari Web
Inspector needs a Mac, and nothing can attach to an installed iOS PWA from Windows.

- **Nothing arrives on iOS** → you're almost certainly in a Safari tab, not the
  installed app. Push requires launching from the home-screen icon (iOS 16.4+).
- **"Enable" does nothing** → permission was denied at some point. It can't be
  re-requested; fix it in iOS Settings → Notifications → CutCoach, or delete and
  re-add the app.
- **Test works, scheduled reminders don't** → the cron isn't reaching you. `pg_net` is
  fire-and-forget and reports *nothing* to `pg_cron`, so a wrong `CRON_SECRET`, a
  missing route, or an SSO redirect all show up as a successful job that silently does
  nothing. `cron.job_run_details` will tell you it succeeded. Check the response, not
  the job:
  ```sql
  select id, status_code, content, error_msg, created
    from net._http_response order by created desc limit 10;
  ```
  `302` = Vercel Authentication is still on (step 6) — by far the most likely cause.
  `401` = secret mismatch. `404` = the code isn't deployed. `200` = working, and the
  body tells you what it decided. Also note the Supabase free tier pauses a project
  after 7 days idle, which stops `pg_cron` with it.
- **Every send 403s** → the VAPID public and private keys don't match. Subscribing
  still succeeds, which makes this look like a delivery problem; it isn't.
