-- CutCoach adaptive calorie engine. Run once after 004_identity.sql. Safe to re-run.

-- The data-quality bit the whole engine stands on: was this day's food FULLY logged?
-- A day with zero meals is indistinguishable from a fast, and people systematically
-- skip logging their heaviest days — averaging only logged days biases intake low and
-- would make the engine cut calories for phantom deficits. Explicit user tap, no
-- heuristics: a meals-count threshold misreads both fasts and grazers.
alter table daily_logs add column if not exists intake_complete boolean not null default false;

-- Optional one-off backfill for history predating the feature (run manually, edit the
-- thresholds to taste — deliberately NOT executed by this migration):
--   update daily_logs dl set intake_complete = true
--   where exists (select 1 from meals m where m.user_id = dl.user_id and m.date = dl.date
--                 group by m.user_id having count(*) >= 3 and sum(m.kcal) >= 1800);

-- One row per user per local week; the unique constraint IS the idempotency claim
-- (same pattern as notification_log). The dispatcher inserts the claim BEFORE doing
-- any work, so overlapping cron ticks can't double-run a user's week.
-- status 'none' records "engine ran, verdict in-lane / not enough data, no change" —
-- weeks are never silently skipped, which the coach check-in relies on.
create table if not exists engine_proposals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,           -- the user's LOCAL Monday, never UTC
  status text not null default 'pending'
    check (status in ('pending','applied','dismissed','none')),
  proposal jsonb not null default '{}',
  -- { newKcal, step, newProtein?, reason, confidence, verdict,
  --   basis: { trendWeight, rate, tdeeFormula, tdeeAdaptive, tdeeBlended, blendWeight,
  --            completeDays, weighIns, spanDays, kcalAtEval, proteinAtEval } }
  created_at timestamptz not null default now(),
  acted_at timestamptz,
  unique (user_id, week_start)
);
create index if not exists idx_engine_proposals_user on engine_proposals (user_id, week_start desc);

alter table engine_proposals enable row level security;

-- Clients read their own rows and act on them (apply/dismiss). No insert policy at
-- all: only the service-role dispatcher authors proposals. RLS can't express "status
-- transitions only" — the worst a user can forge is their own proposal's status,
-- which is acceptable at this trust level.
drop policy if exists "read own engine_proposals" on engine_proposals;
create policy "read own engine_proposals" on engine_proposals
  for select using (auth.uid() = user_id);
drop policy if exists "act on own engine_proposals" on engine_proposals;
create policy "act on own engine_proposals" on engine_proposals
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
