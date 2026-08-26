-- Keep existing deployments compatible with the desktop app's subtraction facts.
alter table public.practice_sessions
  drop constraint if exists practice_sessions_operation_check;
alter table public.practice_sessions
  add constraint practice_sessions_operation_check
  check (operation in ('add', 'sub', 'mul'));

alter table public.attempts
  drop constraint if exists attempts_operation_check;
alter table public.attempts
  add constraint attempts_operation_check
  check (operation in ('add', 'sub', 'mul'));
