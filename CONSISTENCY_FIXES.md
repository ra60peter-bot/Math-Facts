# Math Facts desktop/web consistency review

Repository reviewed: `ra60peter-bot/Math-Facts` at `main` (`fa96b3e16549e503346ddce7524bcfd7b49396f2`).

## Comparison and fixes

| Area | Desktop behavior | Web behavior before | Implemented web behavior |
| --- | --- | --- | --- |
| Question generation | Addition 1–9 (81 facts), positive subtraction using 1–10 (45 facts), multiplication 2–15 (196 facts); no avoidable adjacent repeats | Addition included 0 (100 facts), subtraction was missing, and multiplication ended at 12 | Uses the same 81/45/196 fact sets, exposes subtraction, extends multiplication through 15, and avoids adjacent repeats in base and retry queues |
| Answer validation | Limits parsed results to valid fact answers; supports desktop child-pronunciation variants, filler words, alternate forms such as “one forty four,” and custom mappings | Accepted any 1–3 digit value and supported a different, smaller phrase set | Mirrors the desktop valid-answer set, generated number phrases, child variants, filler handling, and custom mappings |
| Pronunciation correction | Saves a rejected phrase for future answers; the current attempt remains incorrect | Rewound the current card state and retroactively changed the current attempt to correct | Saves the phrase for future recognition while retaining the current incorrect attempt and its retry |
| Session scoring | Any mathematically correct answer counts toward accuracy; speed is tracked separately | Only answers at or below 1.5 seconds counted as correct in session results and admin summaries | Slow correct answers count as correct in local history, results, cloud storage, and admin summaries; speed still determines Hard/Good/Easy fluency grades |
| Mastery scoring | 0–1000 score using accuracy (60%), speed (25%), and consistency (15%), rounded with Python’s half-to-even rule | Same formula but JavaScript half-up rounding | Uses half-to-even rounding to match desktop edge cases |
| Learning progression | Used custom fluency intervals; Hard is correct and only Again demotes | Recorded FSRS state, but its queue behavior and the desktop custom schedule were not aligned | Both apps now actively review and order cards with FSRS at 90% desired retention. Due/low-retrievability reviews come first, then new facts, then future reviews; shared fluency metrics break ties and control within-session retries |

## Online users and permissions

- `impleader@gmail.com` is the sole bootstrap administrator. A Google sign-in for this exact normalized address creates or promotes an active administrator without requiring an invitation.
- Every other online account is invitation-only. Invited users can finish setup with an email/password or use Google with the same invited email.
- Login sessions persist across browser restarts, refresh automatically, and include an explicit **Sign out** control.
- Users can create and delete their own student profiles. Students do not authenticate: after the owner signs in, the student selects their name from a dropdown.
- A selected student can choose operation, facts, and question count; take quizzes; and view only that student's history and performance.
- The administrator can invite and remove users, create or remove students under any account, and inspect every student's history.
- Supabase row-level security scopes progress, sessions, attempts, and voice mappings to the owning account's students, with an administrator override. Server-only routes separately enforce active-user and administrator roles.

## Other compatibility work

- Added subtraction to the web UI, stored operation types, initial Supabase schema, and an idempotent `005_add_subtraction.sql` migration for existing deployments.
- Extended multiplication to 15 in both apps, expanded spoken-number handling through 225, and added `006_expand_multiplication_to_15.sql` for existing voice-mapping tables.
- Standardized practice sessions at 10–100 questions in both apps, with a shared default of 50.
- Added migration `007_account_student_hierarchy.sql` for account roles, invitations, student ownership, progress migration, bootstrap administration, and row-level-security policies.
- Updated operation labels/symbols in practice, history, local admin, and cloud admin views.
- Corrected the operation toggle markup so every button has a distinct accessible name.
- Updated the web README to describe the shared desktop progression model and migration sequence.

## Verification

- ESLint: passed.
- TypeScript `--noEmit`: passed.
- Next.js 16.3.2 production build: passed; all static and dynamic routes compiled.
- Desktop `test_changes.py`: passed with UTF-8 console output enabled.
- Desktop FSRS persistence and replay: passed for both a direct database round-trip and rebuilding state from saved attempt history.
- Focused parity assertions: passed for card counts, arithmetic answers, grading boundaries, Hard/Again transitions, priority, spoken-number parsing, and retry adjacency.
- Local browser check: 81 addition, 45 subtraction, and 196 multiplication facts; no browser warnings or errors.

The supplied source archive is a local implementation snapshot. No commit, push, pull request, deployment, Google OAuth credential creation, or remote database migration was performed. Deployment requires applying migrations 001–007 and configuring the Google provider in Supabase as described in `web/README.md`.
