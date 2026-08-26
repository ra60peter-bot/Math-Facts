-- Allow saved pronunciations for multiplication answers through 15 × 15.
alter table public.voice_mappings
  drop constraint if exists voice_mappings_answer_check;
alter table public.voice_mappings
  add constraint voice_mappings_answer_check
  check (answer >= 0 and answer <= 225);
