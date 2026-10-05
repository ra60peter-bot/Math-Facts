import type { BrowserSpeechRecognition } from '../web/lib/browser-speech';

export type ReplayOutcome = 'manual' | 'correct' | 'slow' | 'wrong' | 'unrecognized' | 'microphone';
let selected: ReplayOutcome = 'correct';
let current: NumberSpeechRecognition | null = null;
const listeners = new Set<() => void>();
let revision = 0;
const trace: string[] = [];
const notify = () => { revision++; listeners.forEach(listener => listener()); };
export const replay = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => `${selected}:${Boolean(current?.ready)}:${revision}`,
  trace: () => trace,
  log(message: string) { trace.push(message); if(trace.length > 12)trace.shift(); notify(); },
  setOutcome(outcome: ReplayOutcome) { selected = outcome; notify(); },
  outcome: () => selected,
  ready: () => Boolean(current?.ready),
  answer(outcome: Exclude<ReplayOutcome, 'manual'>) { current?.deliver(outcome); },
};
export const prepareNumberSpeech = async () => undefined;
export class NumberSpeechRecognition implements BrowserSpeechRecognition {
  processLocally = true;
  usesWordTiming = true;
  lang = 'en-US'; continuous = true; interimResults = true; maxAlternatives = 1;
  onstart: BrowserSpeechRecognition['onstart'] = null;
  onaudiostart: BrowserSpeechRecognition['onaudiostart'] = null;
  onsoundstart: BrowserSpeechRecognition['onsoundstart'] = null;
  onspeechstart: BrowserSpeechRecognition['onspeechstart'] = null;
  onspeechend: BrowserSpeechRecognition['onspeechend'] = null;
  onresult: BrowserSpeechRecognition['onresult'] = null;
  onerror: BrowserSpeechRecognition['onerror'] = null;
  onend: BrowserSpeechRecognition['onend'] = null;
  ready = false;
  private active = false;
  private shownAt = 0;
  private timer: number | undefined;
  start() {
    replay.log('Simulated recognition start requested.');
    this.active = true; current = this; this.onstart?.();
    this.timer = window.setTimeout(() => { if (this.active) this.onaudiostart?.(); }, 80);
    notify();
  }
  beginAnswerWindow(shownAt: number) {
    replay.log('Question revealed; simulated answer window began.');
    this.shownAt = shownAt; this.ready = true; notify();
    if (selected !== 'manual') {
      const outcome = selected;
      this.timer = window.setTimeout(() => this.deliver(outcome), outcome === 'slow' ? 2100 : 850);
    }
  }
  deliver(outcome: Exclude<ReplayOutcome, 'manual'>) {
    if (!this.active || !this.ready) return;
    window.clearTimeout(this.timer);
    if (outcome === 'microphone') { this.onerror?.({ error: 'audio-capture' }); return; }
    const text = document.querySelector('.fact')?.textContent ?? '';
    const fact = text.match(/(\d+)\s*([+×−-])\s*(\d+)/);
    const correct = fact ? fact[2] === '+' ? +fact[1] + +fact[3] : fact[2] === '×' ? +fact[1] * +fact[3] : +fact[1] - +fact[3] : 8;
    const transcript = outcome === 'unrecognized' ? 'the answer is' : String(outcome === 'wrong' ? correct + 1 : correct);
    const responseMs = outcome === 'slow' ? 2100 : 850;
    this.onsoundstart?.();
    this.onresult?.({ results: [{ 0: { transcript }, length: 1, isFinal: true }], resultIndex: 0, speechStartedAt: this.shownAt + responseMs });
    if (outcome === 'unrecognized') this.stop();
  }
  stop() { if (!this.active) return; window.clearTimeout(this.timer); this.active = false; this.ready = false; if (current === this) current = null; notify(); this.onend?.(); }
  abort() { window.clearTimeout(this.timer); this.active = false; this.ready = false; if (current === this) current = null; notify(); }
}
