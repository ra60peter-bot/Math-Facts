## Progress display update

The 0–1,000 bar now reflects each fact's latest scored first answer across the entire current operation, independently of verification: wrong/assisted/unassessed = 0; correct = 500 + 500 × min(1, 1500 / responseMs). The bar averages these credits across ALL facts for that operation (81 addition, 45 subtraction, 121 multiplication), independently of the practice selection, and reaches 1,000 only when every fact is correct within 1.5 seconds. Unassessed facts are explicitly labeled; they are not recorded as wrong. Invalid attempts preserve prior evidence. Verified counts and every scheduling rule below remain unchanged. This supersedes the original verified-count-only display.

# Adaptive automaticity scheduler

One pure scheduler in `lib/automaticity.ts` serves all three operations. It replaces
the fixed FSRS queue and insertion-based retries. No speech decoder, parser,
microphone-onset measurement, accounts or fact ranges were replaced.

## Product defaults

All scheduling settings live in `lib/automaticity-config.ts`. These are configurable
product choices, not experimentally established optimal values or a claimed future
success probability.

- First substantive, unassisted correct answer at **≤1,500 ms** passes. Exactly
  1,500 passes; 1,501 does not. Faster passing answers earn identical schedules.
- Existing answer window remains **4,000 ms**, separate from the speed target.
- Active training pool: at most 10 prompts, preferring one per commutative family.
- At most 5 graded attempts of a fact per session, including assessments/checks.
- Wrong/assisted: 3 unrelated completions **and** 15 seconds before a retry.
- Very slow correct (>3,000 ms): 4 completions **and** 20 seconds.
- Slow correct (1,501–3,000 ms): 8 completions **and** 30 seconds.
- First fast training success: 12 completions **and** 60 seconds. The second
  consecutive fast success of that fact ends its training for that session.
- Cross-day checks use intervals of 1, 2, 4, 7, 14, then 30 days, anchored to actual
  completion timestamps. Late visits advance only one step.
- Four consecutive successful cold checks, on four distinct local dates and
  spanning at least seven actual days, establish current verified automaticity.
- Queue allocation repeats T,T,C,T,T,C,T,T,T,C, falling back when one queue has
  no eligible questions. Due checks precede unassessed facts in CHECK.

Cold eligibility is captured before presentation. It requires a due check, no
family exposure for at least 24 actual hours, no family exposure on the current
practice date, and no same answer among the last three recent completed questions.
Recent same-answer history carries across operations and resumed sessions; entries
at least 24 hours old no longer prime a new day's first question. This resolves the
specification's requirement not to invent a three-question warm-up. Learner timezone
is captured from the device on migration and persisted, so switching devices does
not silently change the calendar. Elapsed intervals always use absolute time.

## Stages and reporting

`UNASSESSED` → Not assessed; `TRAINING` → Building speed; `VERIFYING` → Fast in
practice; verifying; `MAINTENANCE` → Verified automatic.

A fast first assessment enters VERIFYING with a next-day check and **zero** cold
successes. A later slow/wrong/assisted answer returns the fact to TRAINING, resets
the current verification streak and preserves `everVerifiedAutomatic`. Reverification
requires a fresh qualifying streak. Overdue alone is not failure.

The purple/gold 0–1,000 bar is now the share of selected facts currently verified,
not a score based on average speed or warm repetitions. Stage counts, assessed
coverage, due checks, cold correctness and cold within-target correctness accompany
it. Per-fact status shows pending checks and previously verified facts needing recheck.
Session accuracy/average time remain useful history, but do not award verification.

## Storage, migration and session semantics

Apply `supabase/migrations/008_automaticity_scheduler.sql` before deploying the app.
It adds `students.automaticity` and `attempts.automaticity_audit` JSONB columns under
existing owner/admin RLS. It changes no privileges and deletes no records.

The existing learner local-storage record and cloud progress loader/uploader carry
the versioned scheduler snapshot. It contains ordered fact records, family exposure
events, original attempt outcomes, completion history and the active session. No
audio is stored. Completed history also carries the original attempt audit.

Old sessions and card statistics remain. Their records cannot reliably distinguish
first answers, assistance, prompt exposure and qualifying cold checks, so their old
mastery badges do not become verified achievement. Legacy attempt counts/status and
latest known exposure are retained, and facts receive fresh assessment under these
rules. Old FSRS fields/module remain for historical compatibility but no longer
choose practice questions or award current verification.

Existing ranges are preserved: addition 1–9 (81 ordered prompts); subtraction
operands 1–10 with positive results only (45); multiplication 2–12 (121). IDs retain
their existing hyphen format. Reversals of addition/multiplication share interference
families only; achievement stays ordered and operation-specific. Subtraction remains
ordered. Excluding facts does not delete their state.

Reload resumes the original session/configuration with its caps, warm streaks,
allocation position and pending retries. An interrupted prompt becomes ungraded
ABANDONED exposure; a technical retry cannot manufacture another cold check.
Open corrective feedback is conservatively treated as exposed until resume/end.
Exit ends and records the session, including early exits; Repeat explicitly starts
a new session with retained settings. Insufficient spacing or a tiny deck can end
a session early with a reason and next useful time; this is not a mastery claim.

Presentation IDs remain UUID-compatible with the existing attempts table. Duplicate
and stale result IDs do not grade again. Recognition callbacks still use the existing
recognizer-identity guard. A correction after supplied feedback preserves the original
first-answer outcome. Explicit “I don't know” and captured silence through the answer
deadline are failures; capture/network failures and detected speech without a usable
transcript are ungraded technical events.

Deleting a visible history session retains learned scheduling state, as before this
change. This does not implement the earlier canceled request to reverse learning
when history is deleted. Deleting the learner removes its snapshot with the learner.

## Validation

Run from `web`:

```text
node --test tests/*.test.mjs
npm run lint
npx tsc --noEmit
npm run build
```

The suite includes a fake-clock Day 0 (3800→2300→1400→1200) and Day 1/3/7/14
verification sequence followed by a maintenance speed lapse, all boundaries,
operation identity/ranges, coverage, retry gaps, priming, DST, caps, assisted answers,
reload/resume, stale/duplicate IDs, UUIDs, cloud snapshot/audit round-trip and existing
speech regressions. A temporary local browser fixture exercised the actual practice
component with simulated transcripts: ten fast assessments, Repeat, wrong feedback,
reload/resume and early exit. It was removed before release. This is UI integration
testing, not a new claim about real microphone accuracy.

September 27 validation: **107/107 tests passed**, ESLint passed, TypeScript passed,
and the production build succeeded (bundled Node invoked the scripts directly
because npm was not on this machine's PATH). Production schema migration was applied
and both JSONB columns verified before release.

## Limits

- The existing snapshot sync serializes writes on one device; it does not merge
  simultaneous practice by the same learner on multiple devices. Finish/sync before
  switching devices. Offline work remains local until upload succeeds.
- Exposure/audit history grows with use inside the existing local/cloud snapshot;
  large-scale retention/compaction is not implemented here.
- Stored device timezone has no new editing UI. Reliable elapsed timing assumes
  the device wall clock is reasonable; speech timing is the pre-existing mechanism.
- A captured silent window is indistinguishable from a microphone that supplies
  silence without reporting a device error. Reported technical failures remain
  ungraded; the scheduler does not redesign audio diagnostics.
- The “next useful review” is the earliest time known from current spacing/due
  constraints. New exposures and still-needed unrelated questions can defer it.
