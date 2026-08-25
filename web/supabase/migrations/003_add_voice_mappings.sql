-- Run after 001_initial_schema.sql if the project was created before voice mappings existed.
create table if not exists public.voice_mappings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  heard_text text not null,
  answer integer not null check (answer >= 0 and answer <= 144),
  updated_at timestamptz not null default now(),
  primary key (user_id, heard_text)
);

alter table public.voice_mappings enable row level security;

drop policy if exists "users manage their own voice mappings" on public.voice_mappings;
create policy "users manage their own voice mappings"
  on public.voice_mappings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
