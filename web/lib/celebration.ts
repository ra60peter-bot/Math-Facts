export const CELEBRATION_MS = 5000;

export function shouldCelebrate(attempts: readonly { answerCorrect: boolean }[], targetCount: number) {
  return targetCount > 0 && attempts.length >= targetCount &&
    attempts.filter(attempt => attempt.answerCorrect).length / attempts.length > 0.8;
}

let audioContext: AudioContext | null = null;

// Called by Start/Repeat while a user gesture is active, so the later fanfare
// can play on browsers that disallow starting audio from a timer callback.
export function prepareCelebrationAudio() {
  try {
    const Audio = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) return;
    audioContext ??= new Audio();
    void audioContext.resume().catch(() => undefined);
    const silence = audioContext.createBufferSource();
    silence.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    silence.connect(audioContext.destination);
    silence.start();
  } catch { /* A blocked speaker must never prevent practice. */ }
}

// An original, short cartoon-style tune, synthesized locally without a fetch.
export function playCelebrationMusic() {
  const context = audioContext;
  if (!context || context.state !== "running") return () => undefined;
  const voices: OscillatorNode[] = [];
  const master = context.createGain();
  master.gain.value = 0.12;
  master.connect(context.destination);
  const start = context.currentTime + 0.02;
  const note = (midi: number, at: number, duration: number, bass = false) => {
    const oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = bass ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), start + at);
    // Tiny upward scoops make the melody sound like bouncing gumdrops.
    if (!bass) {
      oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 71) / 12), start + at);
      oscillator.frequency.exponentialRampToValueAtTime(440 * 2 ** ((midi - 69) / 12), start + at + 0.04);
    }
    envelope.gain.setValueAtTime(0, start + at);
    envelope.gain.linearRampToValueAtTime(bass ? 0.4 : 0.6, start + at + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + at + duration);
    oscillator.connect(envelope); envelope.connect(master);
    oscillator.start(start + at); oscillator.stop(start + at + duration + 0.01);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    voices.push(oscillator);
  };
  try {
    [72, 76, 79, 84, 79, 76, 77, 81, 84, 89, 84, 81, 79, 83, 86, 91, 86, 83, 84, 79, 76, 79, 84, 88].forEach((pitch, i) => note(pitch, i * 0.18, 0.15));
    [48, 55, 53, 60, 55, 62].forEach((pitch, i) => note(pitch, i * 0.72, 0.3, true));
    [72, 76, 79, 84].forEach(pitch => note(pitch, 4.32, 0.6));
  } catch { master.disconnect(); }
  return () => {
    for (const voice of voices) { try { voice.stop(); } catch { /* Already stopped. */ } }
    master.disconnect();
  };
}
