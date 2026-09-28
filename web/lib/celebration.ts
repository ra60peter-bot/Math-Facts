export const CELEBRATION_MS = 8000;

export const MUSIC_THEMES = ["bounce", "arcade", "parade", "waltz", "disco"] as const;
export const VISUAL_THEMES = ["confetti", "balloons", "dance", "rockets", "fireworks"] as const;
export type MusicTheme = typeof MUSIC_THEMES[number];
export type VisualTheme = typeof VISUAL_THEMES[number];
export type CelebrationChoice = { music: MusicTheme; visual: VisualTheme };

// Separate shuffled bags provide variety without tying a tune to a scene.
// Each option appears once per five celebrations; avoid a repeat at bag edges.
export function createCelebrationPicker(random: () => number = Math.random) {
  const bag = <T extends string>(options: readonly T[]) => {
    let remaining: T[] = [], last: T | undefined;
    return () => {
      if (!remaining.length) {
        remaining = [...options];
        for (let i = remaining.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
        }
        const end = remaining.length - 1;
        if (remaining[end] === last) [remaining[0], remaining[end]] = [remaining[end], remaining[0]];
      }
      last = remaining.pop()!;
      return last;
    };
  };
  const music = bag(MUSIC_THEMES), visual = bag(VISUAL_THEMES);
  return (): CelebrationChoice => ({ music: music(), visual: visual() });
}
export const chooseCelebration = createCelebrationPicker();

type MusicArrangement = {
  name: string;
  wave: OscillatorType;
  beat: number;
  melody: readonly (readonly [number | null, number])[];
  bass: readonly number[];
  bassBeat: number;
  chord: readonly number[];
  articulation: number;
  volume: number;
  scoop: boolean;
};

export const MUSIC_ARRANGEMENTS: Record<MusicTheme, MusicArrangement> = {
  bounce: {
    name: "Gumdrop Bounce", wave: "triangle", beat: 0.24, articulation: 0.7, volume: 0.6, scoop: true,
    melody: [[72, 1], [76, 1], [79, 1], [84, 1], [79, 0.5], [76, 0.5], [72, 1], [null, 1], [77, 1], [81, 1], [84, 1], [89, 1], [84, 1], [81, 1], [79, 1], [76, 1]],
    bass: [48, 55, 53, 60, 55, 62, 48, 55], bassBeat: 0.48, chord: [72, 76, 79, 84],
  },
  arcade: {
    name: "Arcade Victory", wave: "square", beat: 0.16, articulation: 0.65, volume: 0.22, scoop: false,
    melody: [[76, 1], [83, 1], [88, 1], [83, 1], [79, 1], [86, 1], [91, 2], [null, 1], [88, 1], [86, 1], [83, 1], [81, 1], [83, 1], [88, 2], [91, 1], [95, 1], [88, 2]],
    bass: [52, 64, 55, 67, 57, 69, 59, 71], bassBeat: 0.32, chord: [76, 79, 83, 88],
  },
  parade: {
    name: "Silly Parade", wave: "triangle", beat: 0.3, articulation: 0.55, volume: 0.6, scoop: true,
    melody: [[67, 1.5], [71, 0.5], [74, 1], [71, 1], [72, 1.5], [76, 0.5], [79, 2], [74, 1], [74, 0.5], [76, 0.5], [74, 1], [71, 1], [69, 1], [66, 1], [67, 2]],
    bass: [43, 55, 50, 55, 48, 60, 50, 62], bassBeat: 0.6, chord: [67, 71, 74, 79],
  },
  waltz: {
    name: "Bubble Waltz", wave: "sine", beat: 0.36, articulation: 0.9, volume: 0.8, scoop: false,
    melody: [[74, 2], [78, 1], [81, 2], [78, 1], [79, 1], [83, 1], [86, 1], [83, 2], [79, 1], [81, 2], [78, 1], [76, 1], [73, 1], [69, 1], [74, 3]],
    bass: [50, 57, 62, 55, 62, 67, 57, 64, 69], bassBeat: 0.36, chord: [74, 78, 81, 86],
  },
  disco: {
    name: "Disco Blobs", wave: "square", beat: 0.22, articulation: 0.5, volume: 0.24, scoop: false,
    melody: [[69, 1], [null, 0.5], [72, 0.5], [76, 1], [null, 1], [79, 0.5], [76, 0.5], [72, 1], [74, 1], [76, 2], [81, 0.5], [79, 0.5], [76, 1], [72, 1], [69, 1], [null, 1]],
    bass: [45, 57, 45, 52, 48, 60, 50, 62], bassBeat: 0.44, chord: [69, 72, 76, 81],
  },
};

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

// Five original arrangements, synthesized locally without downloading audio.
export function playCelebrationMusic(theme: MusicTheme = "bounce") {
  const context = audioContext;
  if (!context || context.state !== "running") return () => undefined;
  const voices: OscillatorNode[] = [];
  const arrangement = MUSIC_ARRANGEMENTS[theme];
  const master = context.createGain();
  master.gain.value = 0.12;
  master.connect(context.destination);
  const start = context.currentTime + 0.02;
  const note = (midi: number, at: number, duration: number, bass = false) => {
    const oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = bass ? "sine" : arrangement.wave;
    oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), start + at);
    // Tiny upward scoops make the melody sound like bouncing gumdrops.
    if (!bass && arrangement.scoop) {
      oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 71) / 12), start + at);
      oscillator.frequency.exponentialRampToValueAtTime(440 * 2 ** ((midi - 69) / 12), start + at + 0.04);
    }
    envelope.gain.setValueAtTime(0, start + at);
    envelope.gain.linearRampToValueAtTime(bass ? 0.4 : arrangement.volume, start + at + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + at + duration);
    oscillator.connect(envelope); envelope.connect(master);
    oscillator.start(start + at); oscillator.stop(start + at + duration + 0.01);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    voices.push(oscillator);
  };
  try {
    let at = 0, index = 0;
    while (at < 7.05) {
      const [pitch, beats] = arrangement.melody[index++ % arrangement.melody.length];
      const step = beats * arrangement.beat;
      if (pitch !== null) note(pitch, at, Math.min(step * arrangement.articulation, 7.15 - at));
      at += step;
    }
    for (let i = 0; i * arrangement.bassBeat < 7.05; i++) {
      note(arrangement.bass[i % arrangement.bass.length], i * arrangement.bassBeat, Math.min(arrangement.bassBeat * 0.6, 0.3), true);
    }
    arrangement.chord.forEach(pitch => note(pitch, 7.2, 0.7));
  } catch { master.disconnect(); }
  return () => {
    for (const voice of voices) { try { voice.stop(); } catch { /* Already stopped. */ } }
    master.disconnect();
  };
}
