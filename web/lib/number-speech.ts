import type { Model, KaldiRecognizer } from "vosk-browser";
import type { BrowserSpeechRecognition } from "./browser-speech";
import { numberToPhrases } from "./number-parser";

export const NUMBER_MODEL_URL = "/models/english-numbers-0.15.tar.gz";
// Include every number, including wrong answers, and an unknown-word path.
// Never restrict the grammar to the question's correct answer.
export const NUMBER_GRAMMAR = JSON.stringify([
  ...Array.from({ length: 226 }, (_, value) => numberToPhrases(value)).flat(),
  "the answer is", "my answer is", "it is", "[unk]",
]);

let model: Model | null = null;
let preparing: Promise<void> | null = null;

export function prepareNumberSpeech(): Promise<void> {
  if (model?.ready) return Promise.resolve();
  if (preparing) return preparing;
  preparing = (async () => {
    const { Model } = await import("vosk-browser");
    const candidate = new Model(NUMBER_MODEL_URL, -1);
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { candidate.terminate(); reject(new Error("The number speech download timed out. Please retry.")); }, 120000);
      candidate.on("load", (event) => {
        if (event.event !== "load") return;
        window.clearTimeout(timeout);
        if (event.result) resolve();
        else { candidate.terminate(); reject(new Error("Could not load the number speech model.")); }
      });
      candidate.on("error", () => {
        window.clearTimeout(timeout);
        candidate.terminate();
        reject(new Error("Could not download the number speech model. Check the connection and retry."));
      });
    });
    model = candidate;
  })().finally(() => { preparing = null; });
  return preparing;
}

// Adapts our PCM-based decoder to the existing practice lifecycle. This engine
// never calls SpeechRecognition: even its microphone capture is independent.
export class NumberSpeechRecognition implements BrowserSpeechRecognition {
  processLocally = true;
  usesWordTiming = true;
  lang = "en-US";
  continuous = true;
  interimResults = true;
  maxAlternatives = 1;
  onstart: BrowserSpeechRecognition["onstart"] = null;
  onaudiostart: BrowserSpeechRecognition["onaudiostart"] = null;
  onsoundstart: BrowserSpeechRecognition["onsoundstart"] = null;
  onspeechstart: BrowserSpeechRecognition["onspeechstart"] = null;
  onspeechend: BrowserSpeechRecognition["onspeechend"] = null;
  onresult: BrowserSpeechRecognition["onresult"] = null;
  onerror: BrowserSpeechRecognition["onerror"] = null;
  onend: BrowserSpeechRecognition["onend"] = null;
  private state: "idle" | "starting" | "recording" | "draining" | "ended" = "idle";
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private decoder: KaldiRecognizer | null = null;
  private sound = false;
  private audioStartedAt: number | null = null;
  private answerWindowStart: number | null = null;
  private speechStartedAt: number | null = null;
  private finalRequested = false;
  private flushTimer: number | undefined;

  start() {
    if (this.state === "starting" || this.state === "recording" || this.state === "draining") throw new Error("Recognition already started");
    if (!model?.ready) throw new Error("Enable number recognition first");
    this.state = "starting";
    this.sound = false;
    this.audioStartedAt = null;
    this.answerWindowStart = null;
    this.speechStartedAt = null;
    this.finalRequested = false;
    this.onstart?.();
    void this.openAudio();
  }

  private async openAudio() {
    try {
      const context = new AudioContext({ sampleRate: 16000 });
      this.context = context;
      await context.resume();
      await context.audioWorklet.addModule("/number-capture.worklet.js");
      if (this.state !== "starting") return;
      // Avoid aggressive noise suppression clipping brief consonants. Always
      // send every audio sample to the decoder, regardless of energy level.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
      if (this.state !== "starting") { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const decoder = new model!.KaldiRecognizer(context.sampleRate, NUMBER_GRAMMAR);
      this.decoder = decoder;
      decoder.setWords(true);
      decoder.on("partialresult", (message) => {
        if (message.event === "partialresult" && message.result.partial) this.deliver(message.result.partial, false);
      });
      decoder.on("result", (message) => {
        if (message.event !== "result") return;
        // Word alignment measures the beginning of the utterance in captured
        // audio, not when decoding finishes. Ignore unrelated noise/[unk].
        const firstWord = message.result.result?.find((word) => word.word !== "[unk]" && Number.isFinite(word.start) && word.start >= 0);
        if (firstWord && this.audioStartedAt !== null && this.speechStartedAt === null) {
          this.speechStartedAt = this.audioStartedAt + firstWord.start * 1000;
        }
        if (message.result.text) this.deliver(message.result.text, true);
        if (this.state === "draining") { this.cleanup(); this.onend?.(); }
      });
      decoder.on("error", () => this.fail("number-decoder"));
      this.source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, "number-capture");
      this.capture = capture;
      // Calibrate only once actual mic samples arrive. AudioContext startup
      // can advance/suspend its clock before a microphone supplies samples.
      let audioClockOrigin: number | null = null;
      capture.port.onmessage = ({ data }: MessageEvent<{ samples?: Float32Array; startFrame?: number; stopped?: boolean }>) => {
        if (this.state !== "recording" && this.state !== "draining") return;
        if (data.samples && data.startFrame !== undefined) {
          if (audioClockOrigin === null) {
            audioClockOrigin = performance.now() - (data.startFrame + data.samples.length) / context.sampleRate * 1000;
            this.onaudiostart?.();
          }
          if (this.answerWindowStart !== null) {
            const capturedAt = audioClockOrigin + data.startFrame / context.sampleRate * 1000;
            const trim = Math.max(0, Math.ceil((this.answerWindowStart - capturedAt) * context.sampleRate / 1000));
            const samples = trim ? data.samples.slice(trim) : data.samples;
            if (samples.length) {
              if (this.audioStartedAt === null) this.audioStartedAt = capturedAt + trim / context.sampleRate * 1000;
              if (!this.sound && this.state === "recording") {
                const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
                if (rms > 0.008) { this.sound = true; this.onsoundstart?.(); }
              }
              decoder.acceptWaveformFloat(samples, context.sampleRate);
            }
          }
        }
        if (data.stopped) this.requestFinal();
      };
      this.source.connect(capture);
      // Worklet outputs silence, so keeping it scheduled cannot echo the mic.
      capture.connect(context.destination);
      this.state = "recording";
    } catch (error) {
      if (this.state === "ended") return;
      this.fail(error instanceof DOMException && error.name === "NotAllowedError" ? "not-allowed" : "audio-capture");
    }
  }

  beginAnswerWindow(shownAt: number) {
    if (this.answerWindowStart === null) this.answerWindowStart = shownAt;
  }

  private deliver(transcript: string, isFinal: boolean) {
    if (this.state !== "recording" && this.state !== "draining") return;
    this.onresult?.({ results: [{ 0: { transcript }, length: 1, isFinal }], resultIndex: 0, speechStartedAt: this.speechStartedAt ?? undefined });
  }
  stop() {
    if (this.state !== "recording") { if (this.state === "starting") { this.cleanup(); this.onend?.(); } return; }
    this.state = "draining";
    this.stream?.getTracks().forEach((track) => track.stop());
    this.capture?.port.postMessage("stop");
    this.flushTimer = window.setTimeout(() => this.requestFinal(), 250);
  }
  private requestFinal() {
    if (this.state !== "draining" || this.finalRequested) return;
    this.finalRequested = true;
    window.clearTimeout(this.flushTimer);
    this.decoder?.retrieveFinalResult();
  }
  abort() { this.cleanup(); }
  private fail(error: string) {
    this.cleanup();
    this.onerror?.({ error });
    this.onend?.();
  }
  private cleanup() {
    this.state = "ended";
    window.clearTimeout(this.flushTimer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.capture) { this.capture.port.onmessage = null; this.capture.disconnect(); this.capture.port.close(); }
    this.source?.disconnect();
    this.capture = null;
    this.source = null;
    this.decoder?.remove();
    this.decoder = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }
}
