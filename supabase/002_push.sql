-- CutCoach push notifications. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run (schema.sql is not — its create policy statements error on a second run,
-- which is why this lives in its own file).

-- Reminder prefs live on the profile: strictly 1:1, and loadAll() already selects *,
-- so this costs no extra query. `reminders` defaults to '{}' rather than to the UI's
-- proposed defaults — the dispatcher requires an explicit enabled:true, so someone who
-- never opens settings receives nothing even with a live subscription.
alter table profiles add column if not exists timezone text;
alter table profiles add column if not exists reminders jsonb not null default '{}'::jsonb;

-- One row per browser install. Endpoint is globally unique, NOT unique per user: an
-- endpoint identifies a device+SW, not a person. If someone signs out and another
-- account signs in on that device the endpoint must MOVE, not duplicate — otherwise
-- the first user's weight and calories land on the second user's lock screen.
-- The rebind is an upsert on (endpoint), which is also why /api/push/subscribe writes
-- with the service-role client: RLS would block user B from updating user A's row and
-- the rebind would die on a unique violation.
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_error text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_push_subs_user on push_subscriptions (user_id);

-- The idempotency ledger. The unique constraint IS the mechanism: dispatch does
-- `insert ... on conflict do nothing returning *`, and an empty result means another
-- run already claimed this slot. Race-safe with no locking, which is what makes
-- overlapping or duplicated cron runs harmless.
create table if not exists notification_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_id text not null,
  local_date date not null,
  sent_at timestamptz not null default now(),
  unique (user_id, reminder_id, local_date)
);
create index if not exists idx_notification_log_user on notification_log (user_id, sent_at desc);

alter table push_subscriptions enable row level security;
alter table notification_log enable row level security;

-- Narrower than the rest of the schema on purpose. Clients only need to read their
-- own device list and delete a device; inserts go through the service-role route.
drop policy if exists "read own push_subscriptions" on push_subscriptions;
create policy "read own push_subscriptions" on push_subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "delete own push_subscriptions" on push_subscriptions;
create policy "delete own push_subscriptions" on push_subscriptions
  for delete using (auth.uid() = user_id);

-- Select only, and deliberately no insert policy at all: a client that could insert
-- here could forge a dedupe row and suppress its own reminders.
drop policy if exists "read own notification_log" on notification_log;
create policy "read own notification_log" on notification_log
  for select using (auth.uid() = user_id);
