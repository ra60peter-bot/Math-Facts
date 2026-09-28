"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { CELEBRATION_MS, playCelebrationMusic, type CelebrationChoice, type VisualTheme } from "../lib/celebration";

const blobs = ["party-blob", "laughing-blob", "cool-blob"];
export const VISUAL_SCENES: Record<VisualTheme, { caption: string; mascot: string; colors: string[] }> = {
  confetti: { caption: "The blobs are going bananas!", mascot: "party-blob", colors: ["#ffce54", "#b59aff", "#8ae4b8", "#ff9cbf"] },
  balloons: { caption: "Up, up, and hooray!", mascot: "laughing-blob", colors: ["#ff93ba", "#8edfff", "#ffe08a", "#c6a4ff"] },
  dance: { caption: "Tiny blobs. Big dance moves.", mascot: "cool-blob", colors: ["#f1a4ff", "#87f5e4", "#ffe181", "#b8a4ff"] },
  rockets: { caption: "You’re out of this world!", mascot: "cool-blob", colors: ["#99dcff", "#ffbf73", "#fff1a0", "#c2b4ff"] },
  fireworks: { caption: "A whole sky of hoorays!", mascot: "party-blob", colors: ["#ffd96a", "#ff8fa9", "#a5e7ff", "#d7adff"] },
};

export function SessionCelebration({ choice, onFinished }: { choice: CelebrationChoice; onFinished: () => void }) {
  const scene = VISUAL_SCENES[choice.visual];
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(onFinished, CELEBRATION_MS);
    return () => window.clearTimeout(timer);
  }, [onFinished]);
  useEffect(() => {
    if (!muted) return playCelebrationMusic(choice.music);
  }, [muted, choice.music]);

  return <div className="celebration" data-scene={choice.visual} aria-label="Session celebration">
    <div className="celebration-particles" aria-hidden="true">
      <div className="celebration-backdrop" />
      {Array.from({ length: 15 }, (_, i) => <span key={i} className="celebration-blob" style={{
        "--x": `${4 + i * 6.5}%`, "--y": `${24 + (i * 17) % 60}%`, "--drift": `${i % 2 ? -90 : 90}px`, "--spin": `${i % 2 ? -35 : 35}deg`,
        "--delay": `${(i % 5) * 0.15}s`, "--size": `${48 + (i % 3) * 16}px`, "--color": scene.colors[i % 4],
        "--origin-x": `${20 + (i % 3) * 30}%`, "--origin-y": `${42 + (i % 3) * 12}%`,
        "--burst-x": `${Math.round(Math.cos(i * 2.4) * 210)}px`, "--burst-y": `${Math.round(Math.sin(i * 2.4) * 190)}px`,
      } as CSSProperties}><span className="celebration-blob-face" style={{ backgroundImage: `url(/celebration/${blobs[(i + (choice.visual === "dance" ? 2 : 0)) % blobs.length]}.svg)` }} /></span>)}
      {Array.from({ length: 32 }, (_, i) => <i key={i} className="celebration-confetti" style={{
        "--x": `${(i * 31) % 100}%`, "--y": `${18 + (i * 19) % 76}%`, "--drift": `${(i % 2 ? -1 : 1) * (35 + i % 5 * 20)}px`,
        "--delay": `${(i % 8) * 0.1}s`, backgroundColor: scene.colors[i % 4],
      } as CSSProperties} />)}
    </div>
    <div className="celebration-banner">
      <span className="celebration-mascot" aria-hidden="true" style={{ backgroundImage: `url(/celebration/${scene.mascot}.svg)` }} />
      <div role="status"><strong>You did it!</strong><span>{scene.caption}</span></div>
      <button className="button secondary" onClick={() => setMuted(true)} disabled={muted} aria-label="Mute celebration music">{muted ? "Muted" : "Mute"}</button>
      <button className="celebration-close" onClick={onFinished} aria-label="Dismiss celebration">×</button>
    </div>
  </div>;
}
