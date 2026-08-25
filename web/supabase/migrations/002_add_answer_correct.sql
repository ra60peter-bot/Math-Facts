-- Safe to run if 001_initial_schema.sql was applied before answer_correct was added.
alter table public.attempts add column if not exists answer_correct boolean;
update public.attempts set answer_correct = is_correct where answer_correct is null;
alter table public.attempts alter column answer_correct set not null;
