-- Apply before deploying the recovery UI. No existing profile/history is deleted.
begin;
alter table public.profiles add column if not exists deleted_at timestamptz;
alter table public.students add column if not exists deleted_at timestamptz;
create index if not exists profiles_deleted_idx on public.profiles(deleted_at) where deleted_at is not null;
create index if not exists students_deleted_idx on public.students(deleted_at) where deleted_at is not null;

-- Retain the existing unique student-name constraint, including trash. Restoring
-- a student therefore never silently overwrites or merges a newer profile.
create or replace function public.current_account_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id=(select auth.uid())
    and access_status='active' and deleted_at is null
$$;
create or replace function public.owns_student(target_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.students s join public.profiles p on p.id=s.owner_id
    where s.id=target_student_id and p.id=(select auth.uid())
    and s.deleted_at is null and p.deleted_at is null and p.access_status='active')
$$;

-- All app writes use guarded service routes. A stale Supabase session must not
-- bypass soft deletion, edit a recovery deadline, or permanently delete a row.
revoke insert,update,delete on public.students,public.card_states,
  public.practice_sessions,public.attempts,public.voice_mappings from authenticated;
drop policy if exists "accounts view permitted students" on public.students;
create policy "accounts view permitted students" on public.students for select to authenticated
  using (public.owns_student(id) or public.is_account_admin());

-- One transaction, with the owner locked first for consistent concurrency.
create or replace function public.change_profile_deletion(p_actor uuid,p_kind text,p_id uuid,p_restore boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare actor public.profiles%rowtype; owner public.profiles%rowtype;
  learner public.students%rowtype; owner_id uuid; stamp timestamptz;
begin
  select * into actor from public.profiles where id=p_actor for update;
  if not found or actor.deleted_at is not null or actor.access_status<>'active' then
    raise exception 'Account access is not permitted';
  end if;
  if p_kind='user' then
    if actor.role<>'admin' and not actor.is_admin then raise exception 'Administrator access is required'; end if;
    select * into owner from public.profiles where id=p_id for update;
    if not found then raise exception 'User not found'; end if;
    if owner.id=p_actor or owner.role='admin' or owner.is_admin then raise exception 'Administrator accounts cannot be deleted here'; end if;
    stamp:=owner.deleted_at;
  elsif p_kind='student' then
    select s.owner_id into owner_id from public.students s where id=p_id;
    select * into owner from public.profiles where id=owner_id for update;
    if not found or owner.deleted_at is not null or owner.access_status<>'active' then
      raise exception 'Restore the account owner first';
    end if;
    if owner.id<>p_actor and actor.role<>'admin' and not actor.is_admin then
      raise exception 'You can only manage students belonging to your account';
    end if;
    select * into learner from public.students where id=p_id for update;
    if not found then raise exception 'Student not found'; end if;
    stamp:=learner.deleted_at;
  else raise exception 'Unknown profile type';
  end if;

  if p_restore then
    if stamp is null then return; end if;
    if stamp + interval '30 days' <= clock_timestamp() then raise exception 'The 30-day recovery period has ended'; end if;
    if p_kind='user' then update public.profiles set deleted_at=null where id=p_id;
    else update public.students set deleted_at=null where id=p_id; end if;
  else
    -- A repeated delete never extends the recovery period.
    if stamp is not null then return; end if;
    if p_kind='user' then
      update public.profiles set deleted_at=clock_timestamp() where id=p_id;
      delete from public.access_devices where access_devices.owner_id=p_id;
    else
      update public.students set deleted_at=clock_timestamp() where id=p_id;
      delete from public.access_grants where student_id=p_id;
    end if;
  end if;
end;
$$;
revoke all on function public.change_profile_deletion(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.change_profile_deletion(uuid,text,uuid,boolean) to service_role;

-- Freeze retained history even if a request passed its HTTP access check just
-- before deletion. Parent locks serialize these writes with delete/restore.
create or replace function public.guard_retained_progress()
returns trigger language plpgsql set search_path = '' as $$
declare owner_id uuid; learner_id uuid; owner_deleted timestamptz; learner_deleted timestamptz;
begin
  if TG_OP='DELETE' then owner_id:=OLD.user_id; learner_id:=OLD.student_id;
  else owner_id:=NEW.user_id; learner_id:=NEW.student_id; end if;
  select deleted_at into owner_deleted from public.profiles where id=owner_id for share;
  if not found and TG_OP='DELETE' then return OLD; end if;
  select deleted_at into learner_deleted from public.students where id=learner_id for share;
  if not found and TG_OP='DELETE' then return OLD; end if;
  if owner_deleted is not null or learner_deleted is not null then
    raise exception 'Restore the deleted profile before changing its progress';
  end if;
  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end;
$$;
revoke all on function public.guard_retained_progress() from public,anon,authenticated;
do $$
declare name text;
begin
  foreach name in array array['card_states','practice_sessions','attempts','voice_mappings'] loop
    execute format('drop trigger if exists protect_retained_progress on public.%I',name);
    execute format('create trigger protect_retained_progress before insert or update or delete on public.%I for each row execute function public.guard_retained_progress()',name);
  end loop;
end;
$$;

create or replace function public.guard_retained_scheduler()
returns trigger language plpgsql set search_path = '' as $$
declare owner_deleted timestamptz;
begin
  select deleted_at into owner_deleted from public.profiles where id=NEW.owner_id for share;
  if NEW.automaticity is distinct from OLD.automaticity and
    (OLD.deleted_at is not null or owner_deleted is not null) then
    raise exception 'Restore the deleted profile before changing its progress';
  end if;
  return NEW;
end;
$$;
revoke all on function public.guard_retained_scheduler() from public,anon,authenticated;
drop trigger if exists protect_retained_scheduler on public.students;
create trigger protect_retained_scheduler before update of automaticity on public.students
  for each row execute function public.guard_retained_scheduler();

-- Daily cleanup. Restores and cleanup lock the same profile rows, so a successful
-- restore cannot race with deletion. Cascading FKs remove only expired families.
create or replace function public.purge_expired_profiles()
returns void language plpgsql security definer set search_path = '' as $$
declare target record;
begin
  for target in select id,email from public.profiles
    where deleted_at <= now()-interval '30 days' and role<>'admin' and not is_admin for update
  loop
    delete from public.account_invitations where email=target.email;
    delete from auth.users where id=target.id;
  end loop;
  -- A separately deleted student retains its own deadline. While its owner is
  -- in trash, keep the whole family until the owner's recovery period ends.
  for target in select p.id from public.profiles p where p.deleted_at is null for update
  loop
    delete from public.students where owner_id=target.id and deleted_at <= now()-interval '30 days';
  end loop;
end;
$$;
revoke all on function public.purge_expired_profiles() from public,anon,authenticated;
grant execute on function public.purge_expired_profiles() to service_role;
-- Supabase Cron runs this even when nobody visits the app.
create extension if not exists pg_cron;
select cron.schedule('math-facts-profile-retention','17 3 * * *','select public.purge_expired_profiles()');
commit;
