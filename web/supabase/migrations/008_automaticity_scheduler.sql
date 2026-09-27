-- Additive migration. Existing statistics, sessions and FSRS evidence remain intact.
-- Existing student ownership/admin RLS also protects this scheduler snapshot.
alter table public.students add column if not exists automaticity jsonb;
alter table public.attempts add column if not exists automaticity_audit jsonb;
comment on column public.students.automaticity is 'Versioned automaticity scheduler: ordered facts, exposures, auditable outcomes and resumable session caps.';
comment on column public.attempts.automaticity_audit is 'Original first-answer classification and cold-check eligibility; legacy attempts may be null.';
