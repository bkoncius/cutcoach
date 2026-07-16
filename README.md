# CutCoach — training & nutrition ledger with an AI coach

Next.js (Vercel) + Supabase (Postgres, Auth) + Anthropic API (server-side proxy).
Features: daily weigh-ins with 7-day average, meal logging with AI photo/text macro
estimation (HEIC supported), the 4-day training program with per-set logging and
previous-session prefill, cut/maintain/bulk phases, trend charts, and an AI coach
that reads your real data for daily check-ins.

## Launch checklist (~15 minutes)

### 1. Supabase project
1. Go to https://supabase.com → New project (pick the EU region, e.g. Frankfurt).
2. In the dashboard: **SQL Editor → New query** → paste the entire contents of
   `supabase/schema.sql` → **Run**. This creates all tables with row-level security.
3. **Authentication → Providers → Email**: make sure Email is enabled.
   Optional for solo use: turn OFF "Confirm email" so sign-up works instantly.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key.

### 2. Anthropic API key
1. https://console.anthropic.com → API Keys → Create key. Copy it (starts `sk-ant-`).
2. Add a few euros of credit. Typical usage here (a daily check-in + a few photo
   estimates) costs cents per day.

### 3. Deploy to Vercel
Recommended path — GitHub + Vercel:
1. Push this folder to a new GitHub repo (private is fine).
2. https://vercel.com → Add New → Project → import the repo. Framework is
   auto-detected (Next.js).
3. Before deploying, add **Environment Variables** (all environments):
   - `NEXT_PUBLIC_SUPABASE_URL` — from step 1.4
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from step 1.4
   - `ANTHROPIC_API_KEY` — from step 2
   - `ANTHROPIC_MODEL` — `claude-sonnet-4-6` (or change later)
4. Deploy. You'll get `https://your-app.vercel.app`.

CLI alternative: `npm i -g vercel && vercel` from this folder, add the same env
vars when prompted (or via `vercel env add`), then `vercel --prod`.

### 4. Finish auth wiring
Back in Supabase: **Authentication → URL Configuration** → set **Site URL** to your
Vercel URL. (Only strictly needed if email confirmation/magic links are on.)

### 5. Use it
Open the Vercel URL on your phone → Sign up → Share → **Add to Home Screen**.
Full-screen, camera works, HEIC converts automatically, data syncs to Postgres.

## Local development
```bash
npm install
cp .env.example .env.local   # fill in your values
npm run dev                  # http://localhost:3000
```

## Security model
- **Row Level Security** on every table: `auth.uid() = user_id`. Even with the
  public anon key, users can only ever read/write their own rows.
- The `NEXT_PUBLIC_*` values are public by design (that's how Supabase works);
  RLS is the actual guard.
- `ANTHROPIC_API_KEY` lives **only on the server**. The browser calls `/api/ai`,
  which verifies the caller's Supabase JWT before forwarding to Anthropic — so
  nobody can burn your credits without an account in your app.
- Sign-ups are open by default. For a strictly personal app, create your account,
  then in Supabase disable new sign-ups (Authentication → Providers → Email →
  "Allow new users to sign up" off).

## Structure
```
app/page.js            auth gate → app
app/api/ai/route.js    Anthropic proxy (JWT-checked, key server-side)
components/CutCoachApp.jsx   the whole app UI
components/Auth.jsx    sign in / sign up
lib/supabaseClient.js  lazy Supabase client
lib/api.js             askClaude → /api/ai
lib/db.js              typed reads/writes for all tables
supabase/schema.sql    tables + RLS (run once)
```

## Adjusting later
- Coach behavior/rules: `buildContext()` in `components/CutCoachApp.jsx`.
- Training program: the `PROGRAM` constant in the same file.
- Model or spend: `ANTHROPIC_MODEL` env var; `max_tokens` cap in `app/api/ai/route.js`.
