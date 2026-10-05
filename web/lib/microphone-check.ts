// One-time microphone checks use the same number engine and parser as practice.
// No student result is recorded by this adapter.
import { NumberSpeechRecognition, prepareNumberSpeech } from "./number-speech";
import { prepareSafariNumberAudio, releaseSafariNumberAudio } from "./safari-number-audio";
import { readNumberResult } from "./speech-results";

export type VoiceAttemptOptions = {
  // Keep the question hidden until this callback. Reveal it in a display frame,
  // then call markShown with performance.now() immediately after the DOM commit.
  onReady: (markShown: (timestamp?: number) => void) => void;
  onTranscript: (text: string) => void;
  onProcessing?: () => void;
  onAnswer: (value: number, heard: string, responseMs: number | null) => void;
  onFailure: (message: string) => void;
  maxWaitMs?: number;
  calibration?: boolean;
};

export type VoiceAttemptHandle = { cancel(): void };
type AttemptHandle = VoiceAttemptHandle;
let activeAttempt: AttemptHandle | null = null;

export const prepareVoice = prepareNumberSpeech;

// Call synchronously from Start / Repeat / Retry / microphone-test clicks.
// Chromium deliberately keeps the production engine's existing audio setup.
export function unlockVoice(): void {
  prepareSafariNumberAudio();
}

export function releaseVoiceAudio(): void {
  activeAttempt?.cancel();
  releaseSafariNumberAudio();
}

export function startVoiceAttempt(options: VoiceAttemptOptions): AttemptHandle {
  activeAttempt?.cancel();
  const recognition = new NumberSpeechRecognition();
  const answerWindowMs = options.maxWaitMs ?? (options.calibration ? 10000 : 4000);
  let active = true;
  let captureReady = false;
  let questionShownAt: number | null = null;
  let latestTranscript = "";
  let draining = false;
  let readyTimer: number | undefined;
  let answerTimer: number | undefined;
  let drainTimer: number | undefined;

  const clearTimers = () => {
    window.clearTimeout(readyTimer);
    window.clearTimeout(answerTimer);
    window.clearTimeout(drainTimer);
  };
  const handle: AttemptHandle = {
    cancel() {
      if (!active) return;
      active = false;
      clearTimers();
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onaudiostart = null;
      recognition.abort();
      if (activeAttempt === handle) activeAttempt = null;
    },
  };
  activeAttempt = handle;

  const fail = (message: string) => {
    if (!active) return;
    handle.cancel();
    options.onFailure(message);
  };
  const noAnswer = () => fail(latestTranscript
    ? "I heard words, but not a complete number. Please try saying your answer again. Nothing was scored."
    : "I did not catch an answer. Please try the microphone again. Nothing was scored.");
  const stopAndDrain = () => {
    if (!active || draining) return;
    draining = true;
    options.onProcessing?.();
    if (!active) return;
    // stop(), rather than abort(), flushes a short word that is still buffered.
    // Only a final transcript can finish the attempt; an interim prefix such
    // as 'one' must not be graded while 'one hundred eight' is still decoding.
    drainTimer = window.setTimeout(noAnswer, 3000);
    try { recognition.stop(); }
    catch { fail("The microphone stopped unexpectedly. Please retry. Nothing was scored."); }
  };

  recognition.onaudiostart = () => {
    if (!active || captureReady) return;
    captureReady = true;
    window.clearTimeout(readyTimer);
    // Also bound a cancelled/hidden render so an unmarked question never leaves
    // microphone capture open indefinitely.
    readyTimer = window.setTimeout(() => fail("The question could not start. Please retry. Nothing was scored."), 10000);
    options.onReady((timestamp = performance.now()) => {
      if (!active || questionShownAt !== null) return;
      const now = performance.now();
      // The caller and the recognizer must use the same monotonic clock.
      questionShownAt = Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now + 10 ? timestamp : now;
      recognition.beginAnswerWindow(questionShownAt);
      window.clearTimeout(readyTimer);
      answerTimer = window.setTimeout(stopAndDrain, Math.max(0, answerWindowMs - (now - questionShownAt)));
    });
  };
  recognition.onresult = event => {
    if (!active || questionShownAt === null || !event.results.length) return;
    const { transcript, value } = readNumberResult(event.results);
    if (!transcript) return;
    latestTranscript = transcript;
    options.onTranscript(transcript);
    if (!active) return; // A caller may cancel after seeing a transcript.
    const lastSegment = event.results[event.results.length - 1];
    if (!lastSegment?.isFinal || value === null) return;

    const measured = Number.isFinite(event.speechStartedAt) ? event.speechStartedAt! - questionShownAt : NaN;
    // Word alignment is an acoustic estimate. A zero/early/missing boundary is
    // explicitly untimed; transcript-arrival delay must not become recall time.
    const responseMs = !options.calibration && measured >= 50 && measured <= answerWindowMs
      ? Math.round(measured)
      : null;
    handle.cancel();
    options.onAnswer(value, transcript, responseMs);
  };
  recognition.onerror = event => {
    const messages: Record<string, string> = {
      "not-allowed": "Microphone access is blocked. Allow the microphone for this site, then retry. Nothing was scored.",
      "audio-capture": "The microphone could not open. Check your selected microphone, then retry. Nothing was scored.",
      "audio-interrupted": "Safari interrupted the microphone. Retry to reconnect it. Nothing was scored.",
      "number-decoder": "Number recognition stopped. Please retry. Nothing was scored.",
    };
    fail(messages[event.error] ?? "The microphone stopped. Please retry. Nothing was scored.");
  };
  recognition.onend = () => {
    if (!active) return;
    // NumberSpeechRecognition emits any buffered final result before onend.
    // Never promote an unfinished interim transcript into a scored answer.
    if (!captureReady) fail("The microphone did not start. Please retry. Nothing was scored.");
    else noAnswer();
  };
  // Permission UI and audio startup do not consume the student's answer time.
  readyTimer = window.setTimeout(() => fail("The microphone did not start. Allow access and retry. Nothing was scored."), 15000);
  try { recognition.start(); }
  catch { fail("Number recognition is not ready yet. Let the speech download finish, then retry. Nothing was scored."); }
  return handle;
}
