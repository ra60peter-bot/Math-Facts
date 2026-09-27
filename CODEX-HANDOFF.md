# Math Facts: desktop handoff

Updated September 26, 2026. Read this before continuing work.

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
