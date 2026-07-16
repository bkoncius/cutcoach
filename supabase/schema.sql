-- CutCoach schema. Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

-- Profile & targets (one row per user)
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phase text not null default 'cut',
  kcal_target int not null default 2200,
  protein_target int not null default 175,
  start_weight numeric(5,1) not null default 87,
  target_weight numeric(5,1) not null default 75,
  last_checkin date,
  updated_at timestamptz not null default now()
);

-- One row per user per day (weight lives here)
create table if not exists daily_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  weight numeric(5,1),
  unique (user_id, date)
);

-- Meals (many per day)
create table if not exists meals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  name text not null default 'Meal',
  kcal int not null default 0,
  protein int not null default 0,
  carbs int not null default 0,
  fat int not null default 0,
  created_at timestamptz not null default now()
);

-- Workouts (exercises + sets as jsonb)
create table if not exists workouts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  template text not null,
  finisher boolean not null default false,
  exercises jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- Coach conversation
create table if not exists coach_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_daily_logs_user_date on daily_logs (user_id, date desc);
create index if not exists idx_meals_user_date on meals (user_id, date desc);
create index if not exists idx_workouts_user_date on workouts (user_id, date desc);
create index if not exists idx_coach_user_created on coach_messages (user_id, created_at desc);

-- Row Level Security: users can only see and modify their own rows.
alter table profiles enable row level security;
alter table daily_logs enable row level security;
alter table meals enable row level security;
alter table workouts enable row level security;
alter table coach_messages enable row level security;

create policy "own profile" on profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own daily_logs" on daily_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own meals" on meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own workouts" on workouts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own coach_messages" on coach_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
