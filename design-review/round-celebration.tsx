import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { VISUAL_SCENES } from '../web/components/session-celebration';
import { CELEBRATION_MS, playCelebrationMusic, shouldCelebrate, type CelebrationChoice } from '../web/lib/celebration';
import type { Round } from './data';

export { chooseCelebration, prepareCelebrationAudio, CELEBRATION_MS } from '../web/lib/celebration';
export type { CelebrationChoice } from '../web/lib/celebration';

// Reuse the production threshold: finish the configured round and score >80%.
// A disputed recognition is not a correct answer and cannot inflate eligibility.
export function shouldCelebrateRound(round: Round) {
  return shouldCelebrate(round.results.map(result => ({ answerCorrect: ['fast', 'slow', 'untimed'].includes(result.outcome) })), round.total);
}

const blobs = ['party-blob', 'laughing-blob', 'cool-blob'];

// The original five scenes and musical arrangements are reused unchanged.
// The isolated wrapper adds preview preferences and a stable eight-second timer.
// Include /assets/celebration.css from the preview stylesheet.
export function RoundCelebration({ choice, onFinished, sound = true, motion = true }: {
  choice: CelebrationChoice;
  onFinished: () => void;
  sound?: boolean;
  motion?: boolean;
}) {
  const scene = VISUAL_SCENES[choice.visual];
  const [muted, setMuted] = useState(!sound);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    const timer = window.setTimeout(() => finished.current(), CELEBRATION_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (sound && !muted) return playCelebrationMusic(choice.music);
  }, [sound, muted, choice.music]);

  return <div className="round-celebration" data-motion={motion ? 'full' : 'reduced'}>
    <div className="celebration" data-scene={choice.visual} aria-label="Round celebration">
      <div className="celebration-particles" aria-hidden="true">
        <div className="celebration-backdrop" />
        {Array.from({ length: 15 }, (_, i) => <span key={i} className="celebration-blob" style={{
          '--x': `${4 + i * 6.5}%`, '--y': `${24 + (i * 17) % 60}%`, '--drift': `${i % 2 ? -90 : 90}px`, '--spin': `${i % 2 ? -35 : 35}deg`,
          '--delay': `${(i % 5) * 0.15}s`, '--size': `${48 + (i % 3) * 16}px`, '--color': scene.colors[i % 4],
          '--origin-x': `${20 + (i % 3) * 30}%`, '--origin-y': `${42 + (i % 3) * 12}%`,
          '--burst-x': `${Math.round(Math.cos(i * 2.4) * 210)}px`, '--burst-y': `${Math.round(Math.sin(i * 2.4) * 190)}px`,
        } as CSSProperties}><span className="celebration-blob-face" style={{ backgroundImage: `url(/celebration/${blobs[(i + (choice.visual === 'dance' ? 2 : 0)) % blobs.length]}.svg)` }} /></span>)}
        {Array.from({ length: 32 }, (_, i) => <i key={i} className="celebration-confetti" style={{
          '--x': `${(i * 31) % 100}%`, '--y': `${18 + (i * 19) % 76}%`, '--drift': `${(i % 2 ? -1 : 1) * (35 + i % 5 * 20)}px`,
          '--delay': `${(i % 8) * 0.1}s`, backgroundColor: scene.colors[i % 4],
        } as CSSProperties} />)}
      </div>
      <div className="celebration-banner">
        <span className="celebration-mascot" aria-hidden="true" style={{ backgroundImage: `url(/celebration/${scene.mascot}.svg)` }} />
        <div role="status"><strong>You did it!</strong><span>{scene.caption}</span></div>
        <button className="button secondary" onClick={() => setMuted(true)} disabled={muted || !sound} aria-label="Mute celebration music">{muted || !sound ? 'Muted' : 'Mute'}</button>
        <button className="celebration-close" onClick={onFinished} aria-label="Dismiss celebration">×</button>
      </div>
    </div>
  </div>;
}
