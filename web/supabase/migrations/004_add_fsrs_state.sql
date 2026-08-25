-- Adds modern Anki-style FSRS scheduling state without removing legacy progress metrics.
alter table public.card_states add column if not exists fsrs_due timestamptz;
alter table public.card_states add column if not exists fsrs_stability numeric;
alter table public.card_states add column if not exists fsrs_difficulty numeric;
alter table public.card_states add column if not exists fsrs_elapsed_days integer;
alter table public.card_states add column if not exists fsrs_scheduled_days integer;
alter table public.card_states add column if not exists fsrs_learning_steps integer;
alter table public.card_states add column if not exists fsrs_reps integer;
alter table public.card_states add column if not exists fsrs_lapses integer;
alter table public.card_states add column if not exists fsrs_state integer;
alter table public.card_states add column if not exists fsrs_last_review timestamptz;

create index if not exists card_states_user_due_idx on public.card_states(user_id, fsrs_due);
