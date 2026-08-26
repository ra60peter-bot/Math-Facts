-- Adds the online account hierarchy:
--   administrator -> invited account -> non-authenticated student profiles.
-- Existing learner-owned progress is moved to a default student for that account.

alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists access_status text;
alter table public.profiles add column if not exists invited_by uuid references public.profiles(id) on delete set null;

update public.profiles
set role = case when is_admin then 'admin' else 'user' end
where role is null;
update public.profiles set access_status = 'active' where access_status is null;

-- This is the sole bootstrap administrator. The same rule is repeated in the
-- signup trigger below so a first-time Google sign-in can create the account.
update public.profiles
set role = 'admin', is_admin = true, access_status = 'active'
where lower(email) = 'impleader@gmail.com';

alter table public.profiles alter column role set default 'user';
alter table public.profiles alter column role set not null;
alter table public.profiles alter column access_status set default 'blocked';
alter table public.profiles alter column access_status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'user'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_access_status_check') then
    alter table public.profiles add constraint profiles_access_status_check check (access_status in ('active', 'blocked'));
  end if;
end $$;

create table if not exists public.account_invitations (
  email text primary key check (email = lower(email)),
  invited_by uuid not null references public.profiles(id) on delete cascade,
  invited_at timestamptz not null default now(),
  accepted_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (id, owner_id)
);

create unique index if not exists students_owner_name_idx
  on public.students(owner_id, lower(display_name));
create index if not exists students_owner_id_idx on public.students(owner_id);

insert into public.students (owner_id, display_name)
select p.id,
       left(coalesce(nullif(trim(p.display_name), ''), nullif(split_part(p.email, '@', 1), ''), 'Student'), 60)
from public.profiles p
where not exists (select 1 from public.students s where s.owner_id = p.id);

alter table public.card_states add column if not exists student_id uuid references public.students(id) on delete cascade;
alter table public.practice_sessions add column if not exists student_id uuid references public.students(id) on delete cascade;
alter table public.attempts add column if not exists student_id uuid references public.students(id) on delete cascade;
alter table public.voice_mappings add column if not exists student_id uuid references public.students(id) on delete cascade;

update public.card_states cs
set student_id = (select s.id from public.students s where s.owner_id = cs.user_id order by s.created_at limit 1)
where cs.student_id is null;
update public.practice_sessions ps
set student_id = (select s.id from public.students s where s.owner_id = ps.user_id order by s.created_at limit 1)
where ps.student_id is null;
update public.attempts a
set student_id = (select s.id from public.students s where s.owner_id = a.user_id order by s.created_at limit 1)
where a.student_id is null;
update public.voice_mappings vm
set student_id = (select s.id from public.students s where s.owner_id = vm.user_id order by s.created_at limit 1)
where vm.student_id is null;

alter table public.card_states alter column student_id set not null;
alter table public.practice_sessions alter column student_id set not null;
alter table public.attempts alter column student_id set not null;
alter table public.voice_mappings alter column student_id set not null;

alter table public.card_states drop constraint if exists card_states_pkey;
alter table public.card_states add primary key (student_id, card_key);
alter table public.voice_mappings drop constraint if exists voice_mappings_pkey;
alter table public.voice_mappings add primary key (student_id, heard_text);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'card_states_student_owner_fkey') then
    alter table public.card_states add constraint card_states_student_owner_fkey
      foreign key (student_id, user_id) references public.students(id, owner_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'practice_sessions_student_owner_fkey') then
    alter table public.practice_sessions add constraint practice_sessions_student_owner_fkey
      foreign key (student_id, user_id) references public.students(id, owner_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attempts_student_owner_fkey') then
    alter table public.attempts add constraint attempts_student_owner_fkey
      foreign key (student_id, user_id) references public.students(id, owner_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'voice_mappings_student_owner_fkey') then
    alter table public.voice_mappings add constraint voice_mappings_student_owner_fkey
      foreign key (student_id, user_id) references public.students(id, owner_id) on delete cascade;
  end if;
end $$;

create index if not exists card_states_student_id_idx on public.card_states(student_id);
create index if not exists card_states_student_due_idx on public.card_states(student_id, fsrs_due);
create index if not exists practice_sessions_student_ended_idx on public.practice_sessions(student_id, ended_at desc);
create index if not exists attempts_student_id_idx on public.attempts(student_id);

create or replace function public.current_account_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid()) and p.access_status = 'active'
$$;

create or replace function public.is_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_account_role() = 'admin', false)
$$;

create or replace function public.owns_student(target_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.students s
    where s.id = target_student_id and s.owner_id = (select auth.uid())
  )
$$;

revoke all on function public.current_account_role() from public;
revoke all on function public.is_account_admin() from public;
revoke all on function public.owns_student(uuid) from public;
grant execute on function public.current_account_role() to authenticated;
grant execute on function public.is_account_admin() to authenticated;
grant execute on function public.owns_student(uuid) to authenticated;

alter table public.account_invitations enable row level security;
alter table public.students enable row level security;

drop policy if exists "profiles are visible to their owner" on public.profiles;
drop policy if exists "profiles are editable by their owner" on public.profiles;
drop policy if exists "accounts view own profile or admin views all" on public.profiles;
create policy "accounts view own profile or admin views all"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id or (select public.is_account_admin()));

drop policy if exists "accounts view permitted students" on public.students;
drop policy if exists "accounts create permitted students" on public.students;
drop policy if exists "accounts update permitted students" on public.students;
drop policy if exists "accounts delete permitted students" on public.students;
create policy "accounts view permitted students"
  on public.students for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_account_admin()));
create policy "accounts create permitted students"
  on public.students for insert to authenticated
  with check (owner_id = (select auth.uid()) or (select public.is_account_admin()));
create policy "accounts update permitted students"
  on public.students for update to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_account_admin()))
  with check (owner_id = (select auth.uid()) or (select public.is_account_admin()));
create policy "accounts delete permitted students"
  on public.students for delete to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_account_admin()));

drop policy if exists "users manage their own card states" on public.card_states;
drop policy if exists "users manage their own practice sessions" on public.practice_sessions;
drop policy if exists "users manage their own attempts" on public.attempts;
drop policy if exists "users manage their own voice mappings" on public.voice_mappings;

drop policy if exists "accounts read permitted card states" on public.card_states;
drop policy if exists "accounts insert permitted card states" on public.card_states;
drop policy if exists "accounts update permitted card states" on public.card_states;
drop policy if exists "accounts delete permitted card states" on public.card_states;
drop policy if exists "accounts read permitted practice sessions" on public.practice_sessions;
drop policy if exists "accounts insert permitted practice sessions" on public.practice_sessions;
drop policy if exists "accounts update permitted practice sessions" on public.practice_sessions;
drop policy if exists "accounts delete permitted practice sessions" on public.practice_sessions;
drop policy if exists "accounts read permitted attempts" on public.attempts;
drop policy if exists "accounts insert permitted attempts" on public.attempts;
drop policy if exists "accounts update permitted attempts" on public.attempts;
drop policy if exists "accounts delete permitted attempts" on public.attempts;
drop policy if exists "accounts read permitted voice mappings" on public.voice_mappings;
drop policy if exists "accounts insert permitted voice mappings" on public.voice_mappings;
drop policy if exists "accounts update permitted voice mappings" on public.voice_mappings;
drop policy if exists "accounts delete permitted voice mappings" on public.voice_mappings;

create policy "accounts read permitted card states"
  on public.card_states for select to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts insert permitted card states"
  on public.card_states for insert to authenticated
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts update permitted card states"
  on public.card_states for update to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()))
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts delete permitted card states"
  on public.card_states for delete to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));

create policy "accounts read permitted practice sessions"
  on public.practice_sessions for select to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts insert permitted practice sessions"
  on public.practice_sessions for insert to authenticated
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts update permitted practice sessions"
  on public.practice_sessions for update to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()))
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts delete permitted practice sessions"
  on public.practice_sessions for delete to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));

create policy "accounts read permitted attempts"
  on public.attempts for select to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts insert permitted attempts"
  on public.attempts for insert to authenticated
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts update permitted attempts"
  on public.attempts for update to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()))
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts delete permitted attempts"
  on public.attempts for delete to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));

create policy "accounts read permitted voice mappings"
  on public.voice_mappings for select to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts insert permitted voice mappings"
  on public.voice_mappings for insert to authenticated
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts update permitted voice mappings"
  on public.voice_mappings for update to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()))
  with check ((select public.owns_student(student_id)) or (select public.is_account_admin()));
create policy "accounts delete permitted voice mappings"
  on public.voice_mappings for delete to authenticated
  using ((select public.owns_student(student_id)) or (select public.is_account_admin()));

revoke all on public.account_invitations from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.students to authenticated;
grant select, insert, update, delete on public.card_states to authenticated;
grant select, insert, update, delete on public.practice_sessions to authenticated;
grant select, insert, update, delete on public.attempts to authenticated;
grant select, insert, update, delete on public.voice_mappings to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  invitation public.account_invitations%rowtype;
  normalized_email text;
  bootstrap_admin boolean;
begin
  normalized_email := lower(coalesce(new.email, ''));
  bootstrap_admin := normalized_email = 'impleader@gmail.com';

  select * into invitation
  from public.account_invitations
  where email = normalized_email;

  insert into public.profiles (id, email, display_name, role, access_status, invited_by, is_admin)
  values (
    new.id,
    normalized_email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), ''),
    case when bootstrap_admin then 'admin' else 'user' end,
    case when bootstrap_admin or invitation.email is not null then 'active' else 'blocked' end,
    invitation.invited_by,
    bootstrap_admin
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(public.profiles.display_name, excluded.display_name),
    role = case when bootstrap_admin then 'admin' else public.profiles.role end,
    access_status = case when bootstrap_admin or invitation.email is not null then 'active' else public.profiles.access_status end,
    invited_by = coalesce(public.profiles.invited_by, excluded.invited_by),
    is_admin = public.profiles.is_admin or bootstrap_admin;

  if invitation.email is not null then
    update public.account_invitations
    set accepted_by = new.id, accepted_at = now()
    where email = invitation.email;
  end if;
  return new;
end;
$$;
