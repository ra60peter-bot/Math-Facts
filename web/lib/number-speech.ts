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
  private speech = false;
  private finalRequested = false;
  private flushTimer: number | undefined;

  start() {
    if (this.state === "starting" || this.state === "recording" || this.state === "draining") throw new Error("Recognition already started");
    if (!model?.ready) throw new Error("Enable number recognition first");
    this.state = "starting";
    this.speech = false;
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
      decoder.on("partialresult", (message) => {
        if (message.event === "partialresult" && message.result.partial) this.deliver(message.result.partial, false);
      });
      decoder.on("result", (message) => {
        if (message.event !== "result") return;
        if (message.result.text) this.deliver(message.result.text, true);
        if (this.state === "draining") { this.cleanup(); this.onend?.(); }
      });
      decoder.on("error", () => this.fail("number-decoder"));
      this.source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, "number-capture");
      this.capture = capture;
      capture.port.onmessage = ({ data }: MessageEvent<{ samples?: Float32Array; stopped?: boolean }>) => {
        if (this.state !== "recording" && this.state !== "draining") return;
        if (data.samples) {
          if (!this.speech && this.state === "recording") {
            const rms = Math.sqrt(data.samples.reduce((sum, value) => sum + value * value, 0) / data.samples.length);
            if (rms > 0.008) { this.speech = true; this.onsoundstart?.(); this.onspeechstart?.(); }
          }
          decoder.acceptWaveformFloat(data.samples, context.sampleRate);
        }
        if (data.stopped) this.requestFinal();
      };
      this.source.connect(capture);
      // Worklet outputs silence, so keeping it scheduled cannot echo the mic.
      capture.connect(context.destination);
      this.state = "recording";
      this.onaudiostart?.();
    } catch (error) {
      if (this.state === "ended") return;
      this.fail(error instanceof DOMException && error.name === "NotAllowedError" ? "not-allowed" : "audio-capture");
    }
  }

  private deliver(transcript: string, isFinal: boolean) {
    if (this.state !== "recording" && this.state !== "draining") return;
    this.onresult?.({ results: [{ 0: { transcript }, length: 1, isFinal }], resultIndex: 0 });
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
