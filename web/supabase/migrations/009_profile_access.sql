-- Opaque trusted-device cookies allow a family picker, never management access.
-- Short-lived grants are scoped to owner management or one student's practice.
create table if not exists public.access_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.access_grants (
  token_hash text primary key,
  device_id uuid not null unique references public.access_devices(id) on delete cascade,
  mode text not null check (mode in ('owner','student')),
  student_id uuid references public.students(id) on delete cascade,
  expires_at timestamptz not null,
  check ((mode='owner' and student_id is null) or (mode='student' and student_id is not null))
);
create index if not exists access_grants_device_idx on public.access_grants(device_id);
alter table public.access_devices enable row level security;
alter table public.access_grants enable row level security;
revoke all on public.access_devices, public.access_grants from anon, authenticated;
grant all on public.access_devices, public.access_grants to service_role;

-- The service route supplies the authorized learner/owner, never client IDs.
-- Session + question results are atomic and immutable on the recording path.
create or replace function public.record_practice_session(p_student_id uuid,p_owner_id uuid,p_session jsonb)
returns void language plpgsql set search_path = public as $$
declare existing_student uuid; inserted_id uuid;
begin
  if not exists(select 1 from public.students where id=p_student_id and owner_id=p_owner_id) then
    raise exception 'Student owner mismatch';
  end if;
  insert into public.practice_sessions(id,student_id,user_id,operation,started_at,ended_at)
  values((p_session->>'id')::uuid,p_student_id,p_owner_id,p_session->>'operation',(p_session->>'startedAt')::timestamptz,(p_session->>'endedAt')::timestamptz)
  on conflict(id) do nothing returning id into inserted_id;
  if inserted_id is null then
    select student_id into existing_student from public.practice_sessions where id=(p_session->>'id')::uuid;
    if existing_student is distinct from p_student_id then raise exception 'Session owner mismatch'; end if;
    return;
  end if;
  insert into public.attempts(id,session_id,student_id,user_id,fact,operation,is_correct,answer_correct,response_ms,heard,created_at,automaticity_audit)
  select (a->>'id')::uuid,inserted_id,p_student_id,p_owner_id,a->>'fact',a->>'operation',
    (a->>'answerCorrect')::boolean,(a->>'answerCorrect')::boolean,(a->>'responseMs')::integer,a->>'heard',(a->>'at')::timestamptz,a->'audit'
  from jsonb_array_elements(p_session->'attempts') a;
end;
$$;
revoke all on function public.record_practice_session(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_practice_session(uuid,uuid,jsonb) to service_role;
