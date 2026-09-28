# Math Facts: desktop handoff

Updated September 27, 2026. Read this before continuing work.

### Progress panel height correction

The user meant to reduce HEIGHT, not width. The progress panel now spans the full available width with a compact horizontal layout: identity, score, and thin meter with scale/caption. Desktop preview at 1100px is about 74px tall; smaller screens wrap for readability. Purple/gold colors and whole-operation scoring remain unchanged. This supersedes the earlier 40%-width layout.

### Whole-subject progress scope (current clarification)

The 0–1,000 progress panel now uses EVERY fact for the current operation, independent of the practice selection: addition 81, subtraction 45, multiplication 121. Its score and assessed count use getProgressSummary over allCards. The practice queue and selected-fact breakdown still use selectedCards. Deselecting difficult facts cannot raise the subject score or produce 1,000; all facts in the operation must earn full credit. Partial-credit formula and recognition/scheduling behavior are unchanged. This supersedes selected-fact scope in the progress-display section below.

### Compact progress, fact selection and navigation (current)

The progress bar is now a latest-performance score, separate from cold-check verification. For each selected fact: wrong/assisted/corrected-first-answer/unassessed = 0; correct first answer = 500 + 500 * min(1, 1500 / responseMs). Average per-fact credit across all selected facts. Examples: all correct at 3s = 750; at 2s = 875; all at <=1.5s = 1000. Cap at 999 until every fact earns full credit to prevent rounding to false completion. Latest wrong answers lower the score; invalid/abandoned attempts preserve previous evidence. Repeating one easy fact cannot inflate other facts. Existing scheduler queues, verified counts and cold-check requirements are unchanged. This supersedes the older verified-count-only bar description below. No database migration.

Bar card is 40% of its former full width on desktop with a readable 320px minimum, full width on narrow screens. Retains student/assessed count/score, simplified 0/500/1000 scale and brief meaning. Both themes verified. Switch User sits directly beneath the last sidebar nav option with a 16px gap and remains available on mobile. The fact grid is always expanded for students and owners; no optional disclosure. History and session-summary averages display two decimal places, without prematurely rounding the average to milliseconds.

Validation: new score tests cover all operations, wrong/slow/fast boundaries, 1501ms rounding, distinct-fact averaging, assisted answers and technical failures; full suite 125 tests. Browser sample-data QA showed 875 for all-correct 2s, a 0.76s session average, visible grid and top Switch User. Temporary fixture removed before release. No speech changes.

### Default number recognition and recorded answers (current)

Number recognition (the separate local Vosk engine) now prepares automatically when PracticeApp loads, including after choosing a profile. Practice/Repeat wait while it prepares. Preparation uses the existing shared/cache-aware model loader; it does not request microphone access until practice begins. Browser recognition remains an explicit alternative and fallback on preparation failure. Generation guards prevent unmounted/Strict Mode preparations from activating stale UI. This supersedes older instructions saying number recognition is opt-in.

Expanded history now includes Answer heard for every question, showing the original stored transcript including wrong answers. Missing transcripts say No answer recorded; older missing transcripts are not reconstructed. Existing heard fields already persist locally, in scheduler audit/recovery, and in Supabase attempts, so no migration is required. Admin account history now uses the same expandable question-details view and receives stored transcripts via its existing authorized API.

Validation: 122 tests pass, including automatic preparation/success/failure/unmount coverage, rendered wrong/missing-answer history, and wrong-answer transcript cloud round-trip. Browser QA used sample account/history API responses with the REAL local speech model: automatically prepared, then became active without clicking Enable; start was disabled until ready. Wrong-answer/missing-transcript rows visually verified. No live microphone scoring was tested or changed. Temporary fixture removed.

### Owner password gate and student mode (current)

Implemented the user's clarified account model: owner signs in once before a browser can list family students; every subsequent owner selection requires password; password-free students can practice and view their own history only. Owners manage only their students; admin alone manages adults. Invitations/password-reset callback sets a password, then opens Students. Admin Google sign-in remains available. See `web/PROFILE-ACCESS.md` for enforcement, migration and limits.

Migration `009_profile_access.sql` applied to production: private hashed device/grant tables, RLS, service-only immutable session recording RPC. Cookies remember the family for 90 days, while eight-hour scoped grants stay in memory. Switching or reloading locks access; student selection rotates and revokes owner grants. Supabase owner tokens are not persisted in browser storage. API progress writes derive the authorized owner and cannot rewrite history. Existing accounts, students, history, speech, scheduler and canceled deletion-recalculation behavior are preserved.

Validation: 118 tests, typecheck, lint and production build. Browser QA used mocked sample accounts to check picker, owner/password flow, reload lock, student own-history/details, absence of deletion/management controls and owner management. Actual DB recording/immutability test ran in a rolled-back transaction. No real invitation was sent or password changed by QA. Existing owners need one sign-in after this rollout; Google-only regular owners can choose Set or reset password. This new role-selection requirement supersedes earlier canceled per-deletion password requests below.

### Adaptive automaticity scheduler (current)

The explicit user-supplied scheduler replaces the fixed FSRS queue and average-based mastery display. Read `web/AUTOMATICITY.md` for behavior, migration, validation and limitations. Shared engine is `web/lib/automaticity.ts`; all product defaults in `web/lib/automaticity-config.ts`. First-answer unassisted correctness within **1,500 ms inclusive** is the target; preserve the separate existing four-second answer window. Dynamic 7-training/3-check allocation, explicit spacing AND unrelated completions, five-attempt session cap, ten-active-prompt pool, shuffled unseen coverage, cold priming/family guards, 1/2/4/7/14/30-day ladder and four-success/seven-day verification are implemented. Reversals share interference only, not achievement.

The purple/gold bar now shows the proportion of SELECTED facts currently verified on later cold checks (0–1,000). Old mastery badges/counts are retained as historical data, not imported as proof of automaticity. Existing decks unchanged: addition 81, subtraction 45, multiplication 121. Existing accounts, voice parsers/decoders and onset measurement preserved. Correct slow feedback is neutral. Correction after an initial wrong answer no longer grants successful first-answer credit. Full silent captured window scores a timeout; technical recognition failures remain ungraded exposures.

Migration `008_automaticity_scheduler.sql` was applied to production Supabase and both JSONB columns verified: `students.automaticity`, `attempts.automaticity_audit`. Existing RLS/records untouched. Snapshot persists event/exposure audit and resumable session caps/allocation/retry state in existing local/cloud progress. Reload offers Resume or End saved session. Repeat starts a genuinely new session; unavailable queues end explicitly with a spacing explanation. The canceled history-deletion/recalculation request remains canceled: deleting visible sessions retains learned state.

Validation: 107 tests pass, ESLint passes, TypeScript passes, production build succeeds. Temporary local UI fixture verified ten fast initial assessments → VERIFYING with zero cold credits, Repeat, wrong-answer feedback, reload/resume and early-exit history. Fixture removed. Browser tests used simulated transcripts, not live microphone claims. Build used bundled Node directly (npm is not on this machine's PATH), including the number-model preparation step.

Limitations: one learner should practice on one device at a time; existing snapshot sync does not merge concurrent devices. Offline work requires upload before switching devices. Audit snapshot grows with usage; no archival/compaction yet. Stored initial device timezone has no new timezone-editing UI. See `web/AUTOMATICITY.md` for assumptions about recent-answer priming and silent-window classification. Earlier sections below describe superseded scheduler/scoring behavior where they conflict with this section.

### Repeat completed practice session

Session complete now has a primary Repeat button beside New session and View history. Calls the existing startPractice handler with the retained student, operation, selected facts, question count, and speech mode. Starts a fresh session/attempt list and builds a new queue using current learning state; identical configuration does not mean replaying the same question order. New session still opens setup.

### Subject mastery bar in practice setup

Added a prominent purple mastery panel with a gold position marker inside Your practice session. Shows selected student, selected operation, score out of 1,000, and a 0/250/500/750/1,000 scale. Uses existing masteryScore over ALL cards for the operation (81 addition, 45 subtraction, 121 multiplication), not only selected practice facts. No scoring, speech, database, or scheduling changes. Component is web/components/mastery-progress.tsx; includes labeled accessible progressbar and light/dark colors. Temporary browser fixture checked scores 0/224/500/1000, operation/student label changes, and the light theme; removed before release.

### Student deletion password requirement canceled

User explicitly requested undo of b36bfcb. Its code, password setup/reset UI, migration file, and tests were reverted, restoring the previous student-delete confirmation flow. Production SQL restored the migration 007 owner/admin DELETE policy and authenticated DELETE privilege on students; verified authenticated DELETE=true and the exact owner/admin policy expression. No student records were deleted. The temporary password requirement is no longer wanted; do not reintroduce it based on older messages. 67 tests and production build pass.

### 108 zero time and interim Wrong flash (latest)

User reports "one oh eight" recognized as108 with0.0s, and a red Wrong flash before Correct. The interim UI was judging partial numeric prefixes (one→one oh→one oh eight). Mismatching interim transcripts now remain neutral; only completed answers show Wrong. Matching interim feedback remains immediate.

The local decoder's word-start0 was accepted as a response at question reveal. New `web/lib/speech-onset.ts` keeps 10ms energy summaries of PCM already going to Vosk (no audio gating/storage). Only for zero/near-zero word alignment, it searches within the first word's span for sustained acoustic activity above the estimated noise floor, rejecting a brief startup click. Normal nonzero word timestamps are unchanged. If no reliable acoustic onset is available, practice keeps the understood answer and uses first numeric transcript arrival as an explicitly labeled estimated duration; it does not fabricate a0.0s or reject the answer. This fallback can overestimate reaction time by recognition latency; it is not equivalent to a measured acoustic onset. Previous handoff claims that missing timing always causes unscored retry are superseded.

67 tests pass, including forced zero alignment with delayed speech, ambiguous noise, missing/early timing fallback, and the entire108 partial sequence. Real end-to-end audio replay through MediaStream→AudioWorklet→adapter→Vosk recognized108 in all four cases: quiet delays0.7/1.7s gave onsets0.81/1.83s; background noise plus startup click gave0.86/1.86s. The fixtures include leading speech silence and audio-path latency. Real user's microphone/voice remains unverified. Temporary QA route removed before release.

### False early-speech rejection and hundred-number variants (latest)

User's screenshot heard "one thirty two" for 12×11 but rejected it as speech before question reveal. That phrase already parsed as132; the timing guard introduced in the preceding change blocked it. The guard is removed. An invalid early estimated timestamp now falls back to recognition-arrival duration (logged in diagnostics), never a zero/negative time or an accusation that the student spoke early.

Local capture readiness now waits for actual PCM samples rather than connecting an audio node. Calibrate the capture frame clock from the first received microphone buffer; do not extrapolate from AudioContext.currentTime before mic startup. `beginAnswerWindow(shownAt)` is called when practice reveals the question (and by SpeechTest); pre-reveal samples are trimmed before feeding Vosk. The worklet inserts silence for input gaps after capture has begun so elapsed time is not compressed. Acoustic onset remains estimated; no timing claim of physical millisecond precision.

Shared grammar/parser now include full hundreds with/without "and", shorthand (one thirty two/one twelve/one twenty one), a hundred, and three-digit readings (one three two/one one two/one two one). Mixed digit/word transcripts such as one32, 1 thirty two, one hundred and32 are normalized through the same strict phrase lookup. All supported numbers0–225 have nonempty round-tripping forms. Different numeric answers remain different; never guess the expected answer from the question. Three-digit sequences are interpreted as hundreds; conflicting longer lists and spoken equations remain rejected.

64 automated tests pass. End-to-end audio verification replayed generated WAVs through a virtual MediaStream, the real AudioWorklet, the NumberSpeechRecognition adapter, and actual Vosk WASM. All six decoded correctly:132 shorthand/full/individual digits,112 shorthand,121 shorthand, and ten. Playback began1.2s after reveal; measured onsets were1.32–1.35s including leading fixture silence/audio-path latency, while final results arrived2.62–3.83s. No real microphone was accessed. The temporary QA route was removed before deployment. Preserve this pipeline test distinction from earlier decoder-only file tests.

### Number-engine response timing correction (latest)

User confirms local number recognition works quickly, but every response was being scored around 0.1–0.2s. Cause: the adapter emitted `onspeechstart` on the first RMS > 0.008 audio chunk, so startup/room noise was accepted as speech. That amplitude test now indicates sound only; it cannot stop the response timer.

The Vosk decoder uses `setWords(true)`. Final results supply the first non-[unk] word's start within captured audio. The worklet preserves each buffer's `currentFrame` sample position, mapped to performance.now's clock independently of delivery/decoder delays. The first spoken word's start is retained across finalized introduction segments. Practice reveals the question with flushSync inside requestAnimationFrame and starts the four-second clock in that frame. The saved response duration is spoken-word onset minus question reveal, not the end of a multiword answer or transcript arrival. This remains an estimated acoustic boundary and browser display-frame timing, not lab-grade physical display/microphone synchronization.

Interim answers still show Correct!/Wrong! immediately; seconds and the final speed category appear once word timing is available. Number mode always flushes the decoder at the deadline, even with a numeric interim. Missing timing or speech that began before reveal produces an unscored retry instead of a fabricated fast time. Browser recognition retains native speech-start timing.

Validation: 58 regression tests pass (frame reveal/cancellation, onset backdating, noise, delayed results, missing timing, final-buffer sample positions). Actual Vosk/WASM tests with a startup click and 0.5s versus 2s silence correctly recognized ten/eight/twenty-eight. Word onsets shifted by exactly 1.5s (ten and twenty: 0.57→2.07; eight: 0.60→2.10). Multiword timing uses twenty's onset, not eight or the end of the recording. Temporary acoustic QA route removed. User microphone accuracy/timing still needs real-use verification.

### Independent number speech engine (latest)

The user's isolated-answer v3 trace detects sound/speech at 1.280s but returns NO transcript before capture stops at 4.386s or the processing allowance ends at 7.385s. The parser never receives words in this trace. This does not identify an acoustic cause inside Chrome. Further parser aliases cannot repair missing transcripts.

Practice now offers **Enable number recognition**, a separate Vosk WASM engine with direct AudioWorklet microphone capture. This is distinct from Chrome's native on-device pack. Download is opt-in (~42 MB), microphone audio stays on-device, and the grammar includes all numbers 0–225 (including wrong answers), answer introductions, and an unknown-word path. Browser recognition remains available and unchanged. The model is cached by vosk-browser; mode selection currently lasts for the page lifetime.

`web/lib/number-speech.ts` adapts the local decoder to the existing practice/test lifecycle. Every captured sample is decoded, with noise suppression disabled; an energy threshold is used only for timing, never to discard audio. Stop flushes the final worklet buffer before asking for a final transcript. Interim feedback remains immediate; only final answers or the deadline commit scores. Existing four-second capture and three-second processing allowance remain. No changes to spaced repetition or database.

`npm run dev` and `npm run build` prepare the model using `web/scripts/prepare-number-model.mjs`: download the official English small 0.15 ZIP, verify its pinned SHA-256, repack for vosk-browser, and serve the generated archive under `/models/english-numbers-0.15.tar.gz`. Archive/cache are ignored by Git. Apache license and attribution are in `web/public/models/`. Build machines need network access to the model host on an uncached build. Next and eslint-config-next are pinned to 16.3.5.

Actual browser/WASM acoustic verification used Windows SAPI-generated WAV files in two voices: two, four, six, eight, ten, forty, twenty-eight, and fifty-one. All 16 decoded correctly; hello and good morning decoded as [unk]. Decoder processing for complete files was 257–429ms, NOT measured live microphone latency. Temporary QA route was removed. Adapter regression tests also cover quiet samples, buffered audio on stop, wrong answers, cancellation, and pending microphone permission. User-voice and Safari microphone accuracy remain unverified; do not claim this has been confirmed on the user's hardware.

### Real browser trace follow-up: delayed transcript delivery

User supplied a browser-mode Chrome153/Windows trace: audiostart0.336s, speechstart6.236s, first interim "Two"7.737s, then cumulative "Two four six eight ten 40", final11.251s. All six numbers are present in this continuous utterance; the combined list is correctly rejected as a single answer. This does NOT establish accuracy for isolated syllables or prove a practice timeout caused the earlier loss. It establishes a1.501s speech-event-to-transcript delay in this trace.

Practice's800ms post-stop transcript allowance could discard a delayed result from near the4s deadline. It now allows up to3s for processing via `SPEECH_RESULT_GRACE_MS`, still stops audio at4s, and still displays numeric interim feedback immediately. Speech onset timing remains separate from delivery timing.48 tests pass, including a3.7s speech event whose transcript arrives5.2s; capture ends4s and the answer retains3.7s timing. A failed practice attempt now exposes a bounded local-only recognition report with actual lifecycle/raw alternatives under `Recognition details for this attempt`. No audio or reports are uploaded.

Setup speech test v3 now tests ONE selected number per run and starts its4s answer window at audiostart, with the same3s processing allowance. This replaces the misleading15s list test. Next useful evidence is a standalone test or the actual failed-practice report. Do not claim the engine-level missing single-word issue is solved until real testing confirms it.

### Current follow-up: dropped short-number alternatives and diagnostics

User still sees `Heard: The answer is` with no number for 1+1. Microphone works in other apps; do not attribute this to hardware. Fixed app-side omissions: to/too=2 and won=1 in standalone/answer phrases; alternate transcripts are checked for every segment, including a number after a finalized prefix; identical repetitions like "ten ten" are one answer, never a sum. Unrelated words or conflicting numbers are not silently added. All primary numeric answers still win over alternatives regardless of expected answer. Shared selection lives in `web/lib/speech-results.ts`, speech types in `web/lib/browser-speech.ts`.

Native on-device engines receive equal vocabulary hints for number words when supported. Browser service mode is unchanged; unsupported local hints are removed and recognition restarted without changing mode or extending the answer deadline. New `Test speech recognition` panel in setup logs real raw alternatives, segments, boundaries, and parsed values locally for 15 seconds; no audio, scores, or diagnostics are saved/uploaded. It unmounts/stops capture when practice starts. This enables actual-machine evidence rather than only mocked callbacks. No claim that engine-level failure to transcribe standalone numbers is resolved until a real test confirms it. Existing four-second practice timing and instant interim feedback remain.

### Latest screenshot diagnosis: final segments without a number

User supplied 3+1 marked Wrong at0.8s with Heard: The answer is. Reproduced bug: `onresult` committed any final transcript, even a final nonnumeric prefix. Recognition now waits for a numeric result across segments and empty-session restarts; deadline finalization offers an unscored retry for nonnumeric transcripts. Parser strips answer introductions before parsing digits, words, or existing aliases (for=4, ate=8). 40 tests and build passed, including prefix-final then separate four/six/eight/ten segments in both modes. This is a concrete app bug fix, not proof that all acoustic recognition failures are resolved. The paired screenshot heard28 for7+1 and correctly marked it wrong. The rollback request was canceled; current work builds on the latest version restored by6a5d754.

### Most recent follow-up: single syllables in both modes

User reports six/eight/ten frequently return no transcript in BOTH browser and native on-device modes. The shared recognition lifecycle now uses continuous=true and does not call stop() at speechend. Question reveal and the four-second timer wait for `audiostart` (actual capture), not `start` (service start). Both modes allow up to800ms for a buffered result after stopping capture at the empty-transcript deadline. Empty results in either mode do not score an attempt and report whether the browser emitted sound/speech events or neither. No engine-specific acoustic root cause is proven; do not claim actual microphone accuracy is fixed. 37 mocked lifecycle/parser/persistence tests pass. Older descriptions of continuous=false, start-based timing, speechend stopping, or local-only draining below are superseded by this section.

### Latest follow-up: on-device mode

User subsequently reported both ten and forty still produce no transcript in **on-device** mode (screenshot: 10 × 4, Wrong 4.0s, No answer heard). The local answer deadline now calls stop() and allows up to800ms for a buffered result instead of immediately aborting it. Capture still ends at4s. An empty local result offers a manual retry without scoring a wrong answer; it does not silently switch to an online service. Browser-mode deadline behavior is unchanged. Tests simulate buffered forty, empty finalization, and late events; 33 tests pass. Real microphone recognition remains unverified: do not claim standalone ten/forty accuracy is solved by mocked tests.

## Project and setup

- Repository: https://github.com/ra60peter-bot/Math-Facts
- Branch: `main`. Latest application commit at handoff: `339a372` (this document is committed after it).
- Live app: https://math-facts-swart.vercel.app/
- Vercel project/team: `math-facts/math-facts`; application root directory: `web`.
- Supabase project: `xfpfdnnkscalmwmgwhcm`. Existing production database and authentication are already configured. Do not create a new project or rerun migrations merely to set up the desktop.
- Work on the Next.js application in `web/`. The root also contains a separate legacy Python app.
- Read `web/AGENTS.md` and relevant installed Next.js documentation before code changes. The app uses Next.js 16.3.x and React 19.

On the desktop, clone the repository (or pull an existing clean checkout), open its folder in Codex, then run from `web/`:

```powershell
npm ci
npm run dev
```

The usual URL is http://localhost:3000; Next.js may choose 3001 if 3000 is occupied. Use the URL printed by the server.

For authenticated local testing, create `web/.env.local` from `web/.env.example` and fill in the existing project's values through a secure local transfer or authenticated Supabase/Vercel settings. Required names:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

`.env.local` is ignored and deliberately not included in this handoff. Never commit or print its values. The service-role key must remain server-only. Avoid overwriting an existing desktop environment file. Browser sign-ins, microphone permissions, speech-pack downloads, node_modules, and localStorage do not travel with Git. Production cloud data stays in the existing Supabase project. Keep production Site URL configured for the live site; localhost redirect URLs were already configured for ports 3000 and 3001.

## Immediate unresolved task: recognition of “ten”

The user uses Chrome on their laptop, browser recognition mode. Most numbers work; forty improved after fixes, but saying “ten” alone repeatedly yields “No answer heard.” Do not describe this as solved.

The latest diagnostic asked the user to say “the answer is ten.” Their screenshot showed `Heard: Your answer is 10` and `Answer recorded`. That proves a longer phrase produced a transcript, not that the standalone word issue is fixed. It exposed a separate parser bug: digits inside answer phrases were discarded. Commit `339a372` fixes explicit phrases such as “Your answer is 10”, “the answer is 10”, and “it's 10”. Tests and production build passed; push to main succeeded. Vercel deployment of this latest commit was NOT verified because the previous browser tab was no longer available. Verify deployment before asking for another user test.

Next steps: verify latest release; obtain real recognition-event evidence on the affected machine before further speculative timing changes. A diagnostic mode should avoid storing audio or polluting student history. If considering a different recognition engine, discuss download size, performance, browser support, and privacy concretely. Do not infer a student's spoken answer from the expected answer.

## Speech behavior and recent changes

Main implementation: `web/components/math-facts-app.tsx` (`startListening`, `handleResponse`, `stopListening`). Parser: `web/lib/number-parser.ts`. Optional native language-pack preparation: `web/lib/local-speech.ts`.

- Browser Web Speech recognition is the default. On-device recognition is opt-in via the highlighted voice settings card. Native local speech was slower for the user; do not automatically enable or download it again.
- Browser recognition may use the browser vendor's online service; localhost does not imply offline speech processing.
- Recognition uses interim results, continuous=false, en-US, and up to five alternatives. A valid first numeric interpretation wins even if wrong; alternatives are only considered when the first transcript has no number.
- The question is revealed and its four-second window begins on recognition `onstart`, not during microphone startup.
- Numeric interim results immediately show provisional Correct/Slow/Wrong feedback. Saving, wrong-answer controls, and progression wait for finalization. A partial “twenty” may become “twenty eight.” Do not commit partial numbers prematurely.
- Response time uses the speech-start callback if available; otherwise transcript arrival. Confirmation of the same numeric answer retains its displayed time. A revised number gets its own arrival time when there is no speech-start time. These are browser event times, not precise acoustic timestamps.
- Empty transcripts no longer erase a previously recognized number. Empty recognition sessions restart at most twice inside the original deadline; no extra four-second window.
- `onspeechend` only requests `stop()` after a nonempty transcript has arrived; stopping before the first transcript was a suspected short-word failure path, not a proven root cause.
- Ten, 10, tin, forty, 40, fourty, digits with fillers, and explicit answer phrases are parsed. Bare “ten” already parsed correctly before these recent patches. Lack of a transcript is a recognition issue, not a spelling alias issue.
- User previously asked to revert an earlier Safari timing experiment because it hurt Chrome. Commit `b872947` was reverted by `773ef6f`. Subsequent explicitly requested feedback fixes are newer; avoid wholesale reverting current work.

Recent commits, newest first:

- `339a372`: parse numeric answer phrases (latest application change).
- `3daadc4`: avoid stopping short speech before any transcript arrives.
- `07cb709`: recover empty recognition within original answer deadline.
- `c987c47`: numeric fillers and forty spelling variant.
- `9452005`: Easy cutoff changed to 1.2 seconds.
- `410b33b`: immediate provisional feedback for live recognized answers.
- `0347200`: session-complete average response time replaces Mastery.
- `a18731a`: highlighted voice settings and transposed fact grid.

## Current product rules

- FSRS desired retention: 90%. `lib/fsrs-scheduler.ts` and `lib/learning.ts` implement scheduling/grading.
- Correct <=1200ms: Easy. Correct >1200ms through1500ms: Good. Correct >1500ms and <4000ms: Hard. Wrong or >=4000ms: Again.
- Visible feedback: Correct! in green through1.5s, Slow! in yellow above1.5s, Wrong! in red; response time shown.
- Multiplication operands 2 through12. Grid top headers represent FIRST operand; left headers SECOND. Preserve subtraction orientation and valid cells.
- History supports student selection, individual session details, deletion, and result sorting (wrong first, then slow correct, then fast correct; slowest first within groups).
- Early exits save partial sessions, including zero-attempt sessions.
- Wrong answers offer acceptance of the heard input as correct; preserve retry/scoring behavior.
- Session-complete summary: accuracy, question count, average response time.
- Bootstrap administrator: impleader@gmail.com. Owners manage student profiles; students do not have independent logins.

## Explicitly canceled work / pending requests

The user canceled the request to remove deleted session results from spaced repetition. All associated local work was undone. Proposed migration008 was NEVER run and its files were removed. Do not implement this canceled feature. Current history deletion deletes sessions/attempts while learning state remains intact.

An earlier request to require a manually entered password before deleting a student was not completed. Treat it as pending context, not the current task. Do not invent a password flow for Google-only accounts.

## Validation and deployment

Run from `web/`:

```powershell
node --test tests/speech-lifecycle.test.mjs tests/local-speech.test.mjs tests/session-deletion.test.mjs
npm run build
```

On the laptop npm was not on PATH, so builds used `node node_modules/next/dist/bin/next build`; TypeScript used `node node_modules/typescript/bin/tsc --noEmit`. ESLint must run from `web/` to find its config.

Speech tests use real callbacks with a mocked recognizer and deterministic clock. They verify lifecycle and parsing, NOT real microphone accuracy. Latest change passed 22 speech-lifecycle tests and a production build. Other test files were not rerun for the final parser-only change.

The established workflow is edit, test/build, commit explicit files, push main, then verify Vercel production deployment by matching the commit. Existing session authorization covered these routine app updates. Never claim “live” from a successful push alone. Credentials and service-role data must not enter Git, logs, or handoff documents.

Prior browser tool handles and tabs are machine/session-specific; rediscover them. The laptop working tree was clean before adding this document. No database changes were made by the recent speech fixes.
