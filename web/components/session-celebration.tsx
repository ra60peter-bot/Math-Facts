"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { CELEBRATION_MS, playCelebrationMusic } from "../lib/celebration";

const blobs = ["party-blob", "laughing-blob", "cool-blob"];

export function SessionCelebration({ onFinished }: { onFinished: () => void }) {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(onFinished, CELEBRATION_MS);
    return () => window.clearTimeout(timer);
  }, [onFinished]);
  useEffect(() => {
    if (!muted) return playCelebrationMusic();
  }, [muted]);

  return <div className="celebration" aria-label="Session celebration">
    <div className="celebration-particles" aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => <span key={i} className="celebration-blob" style={{
        "--x": `${4 + i * 7}%`, "--drift": `${i % 2 ? -90 : 90}px`, "--spin": `${i % 2 ? -35 : 35}deg`,
        "--delay": `${(i % 5) * 0.13}s`, "--size": `${48 + (i % 3) * 16}px`,
      } as CSSProperties}><span style={{ backgroundImage: `url(/celebration/${blobs[i % blobs.length]}.svg)` }} /></span>)}
      {Array.from({ length: 32 }, (_, i) => <i key={i} className="celebration-confetti" style={{
        "--x": `${(i * 31) % 100}%`, "--drift": `${(i % 2 ? -1 : 1) * (35 + i % 5 * 20)}px`,
        "--delay": `${(i % 8) * 0.1}s`, backgroundColor: ["#ffce54", "#b59aff", "#8ae4b8", "#ff9cbf"][i % 4],
      } as CSSProperties} />)}
    </div>
    <div className="celebration-banner">
      <span className="celebration-mascot" aria-hidden="true" />
      <div role="status"><strong>You did it!</strong><span>The blobs are going bananas!</span></div>
      <button className="button secondary" onClick={() => setMuted(true)} disabled={muted} aria-label="Mute celebration music">{muted ? "Muted" : "Mute"}</button>
      <button className="celebration-close" onClick={onFinished} aria-label="Dismiss celebration">×</button>
    </div>
  </div>;
}
