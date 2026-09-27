// Used only when the recognizer aligns a word to the beginning of the entire
// recording. Keep short energy windows, not audio, and never gate recognition.
export class SpeechOnset {
  private frames: number[] = [];
  private sum = 0;
  private count = 0;
  private frameSize = 160;

  add(samples: Float32Array, sampleRate: number) {
    this.frameSize = Math.max(1, Math.round(sampleRate / 100));
    for (const value of samples) {
      this.sum += value * value;
      if (++this.count === this.frameSize) {
        this.frames.push(Math.sqrt(this.sum / this.count));
        this.sum = 0;
        this.count = 0;
      }
    }
  }

  // Resolve the first word inside its own acoustic span. A short startup
  // click is not a sustained word; trailing words cannot supply its onset.
  resolve(start: number, end: number): number | undefined {
    if (start >= 0.05) return start;
    if (!Number.isFinite(end) || end <= start) return undefined;
    const frames = this.frames.slice(0, Math.ceil(end * 100));
    if (frames.length < 8) return undefined;
    const sorted = [...frames].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)];
    const peak = sorted[Math.floor(sorted.length * 0.95)];
    if (peak <= floor * 2 || peak < 0.00001) return undefined;
    const threshold = Math.max(floor * 3, peak * 0.08, 0.00001);
    let runStart = -1, active = 0, gap = 0;
    const candidates: number[] = [];
    const finishRun = () => {
      if (active >= 3 && runStart >= 5) candidates.push(runStart / 100);
      runStart = -1; active = 0; gap = 0;
    };
    for (let index = 0; index < frames.length; index++) {
      if (frames[index] > threshold) {
        if (runStart < 0) runStart = index;
        active++; gap = 0;
      } else if (runStart >= 0 && ++gap > 4) finishRun();
    }
    finishRun();
    return candidates.at(-1);
  }
}
