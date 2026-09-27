import type { LocalSpeechSupport } from "./local-speech";
import type { SpeechPhrase, SpeechResults } from "./speech-results";

// A real browser trace took 1.5s from speech detection to its first transcript.
// This bounds processing after stop(); it never extends the capture window.
export const SPEECH_RESULT_GRACE_MS = 3000;

export type BrowserSpeechRecognitionEvent = { results: SpeechResults; resultIndex?: number; speechStartedAt?: number };
export type BrowserSpeechRecognitionErrorEvent = { error: string };
export type BrowserSpeechRecognition = {
  processLocally?: boolean;
  usesWordTiming?: boolean;
  beginAnswerWindow?: (shownAt: number) => void;
  phrases?: SpeechPhrase[];
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionConstructor = (new () => BrowserSpeechRecognition) & LocalSpeechSupport;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
    SpeechRecognitionPhrase?: new (phrase: string, boost: number) => SpeechPhrase;
  }
}
