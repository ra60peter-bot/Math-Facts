-- Run this in the Supabase SQL Editor before deploying the app.
-- Accounts are created only by the authenticated admin invitation endpoint.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.card_states (
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_key text not null,
  state text not null check (state in ('learning', 'reviewing', 'mastered')),
  total_attempts integer not null default 0 check (total_attempts >= 0),
  total_correct integer not null default 0 check (total_correct >= 0),
  consecutive_correct integer not null default 0,
  consecutive_fast integer not null default 0,
  consecutive_failures integer not null default 0,
  rolling_avg_ms numeric not null default 0,
  last_response_ms integer not null default 0,
  difficulty numeric not null default 0.3 check (difficulty >= 0 and difficulty <= 1),
  interval_days numeric not null default 0,
  due_at timestamptz,
  last_seen_at timestamptz,
  fsrs_due timestamptz,
  fsrs_stability numeric,
  fsrs_difficulty numeric,
  fsrs_elapsed_days integer,
  fsrs_scheduled_days integer,
  fsrs_learning_steps integer,
  fsrs_reps integer,
  fsrs_lapses integer,
  fsrs_state integer,
  fsrs_last_review timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, card_key)
);

create table if not exists public.practice_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  operation text not null check (operation in ('add', 'sub', 'mul')),
  started_at timestamptz not null,
  ended_at timestamptz not null
);

create table if not exists public.attempts (
  id uuid primary key,
  session_id uuid not null references public.practice_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  fact text not null,
  operation text not null check (operation in ('add', 'sub', 'mul')),
  is_correct boolean not null,
  answer_correct boolean not null,
  response_ms integer not null check (response_ms >= 0),
  heard text,
  created_at timestamptz not null
);

create table if not exists public.voice_mappings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  heard_text text not null,
  answer integer not null check (answer >= 0 and answer <= 225),
  updated_at timestamptz not null default now(),
  primary key (user_id, heard_text)
);

create index if not exists card_states_user_id_idx on public.card_states(user_id);
create index if not exists card_states_user_due_idx on public.card_states(user_id, fsrs_due);
create index if not exists practice_sessions_user_id_ended_at_idx on public.practice_sessions(user_id, ended_at desc);
create index if not exists attempts_user_id_idx on public.attempts(user_id);

alter table public.profiles enable row level security;
alter table public.card_states enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.attempts enable row level security;
alter table public.voice_mappings enable row level security;

create policy "profiles are visible to their owner" on public.profiles for select using (auth.uid() = id);
create policy "profiles are editable by their owner" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "users manage their own card states" on public.card_states for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own practice sessions" on public.practice_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own attempts" on public.attempts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage their own voice mappings" on public.voice_mappings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- After you accept the first invitation, run this once with your own email:
-- update public.profiles set is_admin = true where email = 'you@example.com';
