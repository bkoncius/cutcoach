-- CutCoach identity & onboarding. Run once in Supabase after 002_push.sql.
-- Safe to re-run.
--
-- Two things happen here:
--   1. profiles learns who the client actually is (sex, birthdate, height, lifestyle),
--      which the BMR/TDEE formulas and phase lanes need.
--   2. The magic-number column defaults (2200/175/87/75) are DROPPED. They caused
--      every new sign-up to be silently written as an 87→75 kg cut on 2200 kcal
--      without ever being asked. After this migration, only the onboarding wizard
--      mints target values — a code path that inserts a bare profiles row now fails
--      loudly instead of inventing a plan for the wrong person.
--
-- NOTE: saveReminders() upserts a profiles row naming only reminder columns. That
-- would violate the now-default-less NOT NULL targets on a user with NO row — which
-- can't happen in practice because the reminders UI is unreachable before onboarding
-- creates the row. Keep it that way.

alter table profiles add column if not exists display_name   text;
alter table profiles add column if not exists sex             text check (sex in ('male','female','unspecified'));
alter table profiles add column if not exists birthdate       date;
alter table profiles add column if not exists height_cm       numeric(4,1);
alter table profiles add column if not exists activity_level  text check (activity_level in ('sedentary','light','moderate','active','very_active'));
alter table profiles add column if not exists experience      text check (experience in ('beginner','intermediate','advanced'));
alter table profiles add column if not exists equipment       text check (equipment in ('gym','dumbbells','bodyweight'));
alter table profiles add column if not exists days_per_week   int  check (days_per_week between 2 and 6);
alter table profiles add column if not exists units           text not null default 'metric' check (units in ('metric','imperial'));
alter table profiles add column if not exists bodyfat_pct     numeric(4,1) check (bodyfat_pct > 0 and bodyfat_pct < 75);
-- Stamped by onboarding, manual phase switches, and (later) engine applies. The
-- adjustment engine refuses to propose inside the first 14 days of a phase.
alter table profiles add column if not exists phase_started_at date;
-- The onboarding gate: null => the wizard runs on next open.
alter table profiles add column if not exists onboarded_at    timestamptz;

-- Existing rows predate the wizard; a conservative phase age just delays the first
-- engine proposal by two weeks.
update profiles set phase_started_at = current_date where phase_started_at is null;

-- Fail closed: no more invented targets.
alter table profiles alter column kcal_target    drop default;
alter table profiles alter column protein_target drop default;
alter table profiles alter column start_weight   drop default;
alter table profiles alter column target_weight  drop default;

-- Every applied target change, with the trend context that justified it. This is what
-- lets the engine (and the coach) say "2200 kcal from July 1st produced −0.4 kg/wk"
-- instead of guessing. Sources: onboarding | manual (settings panel) | engine.
create table if not exists target_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('onboarding','manual','engine')),
  phase text not null,
  kcal_target int not null,
  protein_target int not null,
  prev_kcal int,
  prev_protein int,
  context jsonb not null default '{}',  -- {trendWeight, rate, confidence, tdeeFormula?, tdeeBlended?, proposalId?}
  created_at timestamptz not null default now()
);
create index if not exists idx_target_history_user on target_history (user_id, created_at desc);

alter table target_history enable row level security;
drop policy if exists "own target_history" on target_history;
create policy "own target_history" on target_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
