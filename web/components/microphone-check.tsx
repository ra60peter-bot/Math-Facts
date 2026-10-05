"use client";
import { useEffect, useRef, useState } from "react";
import { prepareVoice, startVoiceAttempt, unlockVoice, releaseVoiceAudio, type VoiceAttemptHandle } from "../lib/microphone-check";
import { confirmMicrophone } from "../lib/practice-preferences";

export function MicrophoneCheck({ troubleshooting = false, onContinue, onBack }: { troubleshooting?: boolean; onContinue?: () => void; onBack: () => void }) {
  const [state, setState] = useState("idle"), [heard, setHeard] = useState(""), [message, setMessage] = useState("");
  const attempt = useRef<VoiceAttemptHandle | null>(null), generation = useRef(0);
  useEffect(() => () => { generation.current++; attempt.current?.cancel(); releaseVoiceAudio(); }, []);
  async function check() {
    const version = ++generation.current;
    attempt.current?.cancel(); unlockVoice(); setState("loading"); setHeard(""); setMessage("");
    try {
      await prepareVoice(); if (version !== generation.current) return;
      attempt.current = startVoiceAttempt({ calibration: true,
        onReady: mark => { mark(); setState("listening"); },
        onTranscript: setHeard,
        onProcessing: () => setState("processing"),
        onAnswer: (_value, transcript) => {
          setHeard(transcript); setState("ready"); releaseVoiceAudio();
          if (!confirmMicrophone()) setMessage("This check passed, but browser storage is unavailable. It can only be remembered for this visit.");
        },
        onFailure: text => { setMessage(text); setState("failed"); releaseVoiceAudio(); },
      });
    } catch { if (version === generation.current) { setState("failed"); setMessage("Number recognition could not load. Check your connection and try again."); releaseVoiceAudio(); } }
  }
  const busy = ["loading", "listening", "processing"].includes(state);
  return <section className={`mic-check-panel${troubleshooting ? " mic-check-compact" : ""}`}>
    <button className="text-button" onClick={onBack}>← {troubleshooting ? "Back to controls" : "Back to my choices"}</button>
    <p className="eyebrow">{troubleshooting ? "Microphone troubleshooting" : "One-time sound check"}</p>
    {!troubleshooting && <div className={`mic-orb ${state === "ready" ? "ready" : ""}`} aria-hidden="true">{state === "ready" ? "✓" : "◉"}</div>}
    <h1>{state === "ready" ? "You’re ready to practice." : state === "listening" ? "Say a number, such as eight." : state === "loading" ? "Preparing your microphone…" : state === "processing" ? "Checking what we heard…" : "Let’s make sure we can hear you."}</h1>
    <p className="muted">{troubleshooting ? "Check this browser’s microphone without recording a practice result." : "One successful check is remembered for every student in this browser on this computer. An account owner can run it again from Family controls."}</p>
    <div aria-live="polite">{heard && <p>Heard: <strong>{heard}</strong></p>}{message && <p className="notice">{message}</p>}</div>
    {state === "ready" && !troubleshooting ? <button className="button primary" onClick={onContinue}>Start my round →</button> : <button className="button primary" disabled={busy} onClick={() => void check()}>{busy ? "Listening…" : troubleshooting ? "Run microphone check" : "Try the microphone"}</button>}
    <p className="fine-print">Allow microphone access if asked. Say one number in your usual voice. This check does not record a practice result.</p>
  </section>;
}
